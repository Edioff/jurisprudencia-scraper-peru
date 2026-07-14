/**
 * Unit tests for the pure logic: partial-response parsing, row extraction,
 * retry/backoff semantics and file helpers. Uses Node's built-in test runner
 * (no extra dependencies) with fixtures captured from the live site.
 *
 * Run: npm test
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AxiosError, AxiosResponse } from 'axios';

import { buildReport } from '../src/report';

import { parsePartialResponse } from '../src/core/jsf-session';
import { OefaAdapter } from '../src/sites/oefa';
import {
  parseResults as parsePjResults,
  harvestForm,
  generalSearchButton,
  parseFicha,
} from '../src/sites/pj';
import { DocumentRecord } from '../src/types';
import {
  isRetryable,
  parseRetryAfterMs,
  withRetry,
  RetriesExhaustedError,
} from '../src/core/retry';
import { CookieJar } from '../src/core/cookie-jar';
import { mapLimit } from '../src/core/concurrency';
import { parseProxyUrl, ProxyPool } from '../src/core/proxy';
import { sanitizeFileName, toCsv, fileNameFromDisposition } from '../src/core/files';
import {
  SEARCH_FRAGMENT,
  PAGE_FRAGMENT,
  PARTIAL_RESPONSE,
  PARTIAL_RESPONSE_SPLIT_CDATA,
  PARTIAL_RESPONSE_ERROR,
  PARTIAL_RESPONSE_REDIRECT,
  PJ_RESULT_LINK,
  PJ_RESULTS_PAGE,
  PJ_INICIO_FORM,
  PJ_FICHA_MODAL,
} from './fixtures';

// ---------------------------------------------------------------------------
// parsePartialResponse

test('partial-response: extracts updates and rotates ViewState', () => {
  const parsed = parsePartialResponse(PARTIAL_RESPONSE);
  assert.equal(parsed.updates.get('listarDetalleInfraccionRAAForm:pgLista'), '<span>hello</span>');
  assert.equal(parsed.viewState, 'NEW_VIEW_STATE_TOKEN==');
  assert.equal(parsed.error, null);
});

test('partial-response: reassembles split CDATA (escaped "]]>")', () => {
  const parsed = parsePartialResponse(PARTIAL_RESPONSE_SPLIT_CDATA);
  assert.equal(parsed.updates.get('x'), 'before]]>after');
});

test('partial-response: surfaces ViewExpiredException as error', () => {
  const parsed = parsePartialResponse(PARTIAL_RESPONSE_ERROR);
  assert.match(parsed.error ?? '', /ViewExpiredException/);
});

test('partial-response: surfaces redirects (session loss)', () => {
  const parsed = parsePartialResponse(PARTIAL_RESPONSE_REDIRECT);
  assert.equal(parsed.redirectUrl, '/repdig/sesionExpirada.xhtml');
});

test('partial-response: full HTML page is reported as error, not crash', () => {
  const parsed = parsePartialResponse('<!DOCTYPE html><html><body>login</body></html>');
  assert.notEqual(parsed.error, null);
});

// ---------------------------------------------------------------------------
// OEFA row parsing

const adapter = new OefaAdapter();
// parseRows is intentionally private; tests reach it via an any-cast.
const parseRows = (fragment: string, page: number): DocumentRecord[] =>
  (adapter as any).parseRows(fragment, page);

test('rows: search fragment (full panel with table)', () => {
  const rows = parseRows(SEARCH_FRAGMENT, 0);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].uuid, '153a6d2a-cbed-40ef-b8ef-cd2272b19867');
  assert.equal(rows[0].downloadButtonId, 'listarDetalleInfraccionRAAForm:dt:0:j_idt63');
  assert.equal(rows[0].rowIndex, 0);
  // multi-line cell collapsed to single-spaced text
  assert.equal(rows[0].fields.administrado, 'Corporación del Mar S.A. Austral Group S.A.A.');
  assert.equal(rows[1].fields.nroResolucionApelacion, '007-2016-OEFA/TFA-SEPIM');
});

test('rows: pagination fragment (bare <tr> list, no parent table)', () => {
  const rows = parseRows(PAGE_FRAGMENT, 1);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].rowIndex, 10);
  assert.equal(rows[0].page, 1);
  assert.equal(rows[0].uuid, '746821e4-f99f-4e5c-90e2-7e2e2e3731d8');
});

test('rows: a row without a download link yields uuid=null', () => {
  const rows = parseRows(PAGE_FRAGMENT, 1);
  assert.equal(rows[1].uuid, null);
  assert.equal(rows[1].downloadButtonId, null);
});

test('search: reads total and page size from the paginator', async () => {
  const fakeSession = {
    postAjax: async () =>
      parsePartialResponse(
        `<?xml version='1.0' encoding='UTF-8'?><partial-response><changes><update id="listarDetalleInfraccionRAAForm:pgLista"><![CDATA[${SEARCH_FRAGMENT}]]></update><update id="j_id1:javax.faces.ViewState:0"><![CDATA[VS]]></update></changes></partial-response>`,
      ),
  };
  const result = await adapter.search(fakeSession as any);
  assert.equal(result.totalRecords, 1753);
  assert.equal(result.pageSize, 10);
  assert.equal(result.firstPageRows.length, 2);
});

// ---------------------------------------------------------------------------
// PJ (RichFaces) parsing

test('PJ: extracts metadata + uuid from a doubly-escaped result link', () => {
  const rows = parsePjResults(PJ_RESULT_LINK, 0);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.uuid, '82a1732b-bee7-40f6-9e61-19db22c3a6be'); // dashes decoded
  assert.equal(r.rowIndex, 0);
  assert.equal(r.fields.recurso, 'Casación'); // accents preserved
  assert.equal(r.fields.nroexp, '001785-2024');
  assert.equal(r.fields.fechaResolucion, '09/07/2026'); // \/ decoded
  assert.equal(r.fields.sala, 'Sala Penal Permanente');
});

test('PJ: rowIndex tracks the RichFaces repeat index across pages', () => {
  // On page 2 the repeat indices are 10..19; the parser keeps them absolute.
  const page2 = PJ_RESULT_LINK.replace(/repeat:0/g, 'repeat:13');
  const rows = parsePjResults(page2, 1);
  assert.equal(rows[0].rowIndex, 13);
});

test('PJ: a value containing quotes is not truncated', () => {
  // A sumilla that quotes a phrase: the escaped inner quotes (\") survive the
  // unescape and must not end the value early.
  const withQuotes = PJ_RESULT_LINK.replace(
    'En el caso, solo los argumentos.',
    'El tribunal dijo \\\\&quot;no ha lugar\\\\&quot; y cerró.',
  );
  const rows = parsePjResults(withQuotes, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fields.sumilla, 'El tribunal dijo "no ha lugar" y cerró.');
});

test('PJ: parses two results from a page fragment', () => {
  const rows = parsePjResults(PJ_RESULTS_PAGE, 0);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].uuid, '82a1732b-bee7-40f6-9e61-19db22c3a6be');
  assert.equal(rows[1].uuid, '9c8d4d4a-bee7-40f6-9e61-19db22c3a6be');
  assert.equal(rows[1].rowIndex, 1);
  assert.equal(rows[1].fields.recurso, 'Apelación');
});

test('PJ: harvestForm collects inputs + selected option, drops buttons/unchecked', () => {
  const fields = harvestForm(PJ_INICIO_FORM, 'formBuscador');
  assert.equal(fields['formBuscador'], 'formBuscador');
  assert.equal(fields['formBuscador:txtBusqueda'], '');
  assert.equal(fields['formBuscador:buCorte'], '1'); // selected option
  assert.equal('formBuscador:buNcpp' in fields, false); // unchecked checkbox omitted
  assert.equal('formBuscador:j_idt447' in fields, false); // submit button omitted
});

test('PJ: picks the general-search button (not the specialized tab)', () => {
  const params = generalSearchButton(PJ_INICIO_FORM);
  assert.equal(params['formBuscador:j_idt69'], 'formBuscador:j_idt69');
  assert.equal(params['forward'], 'buscar');
  assert.equal('busqueda' in params, false); // 'especializada' marker rejected
});

test('PJ: parseFicha maps the detail modal into slugged fields', () => {
  const fields = parseFicha(PJ_FICHA_MODAL);
  assert.equal(fields.fechaDeLaResolucion, '09/07/2026');
  assert.equal(fields.juecesSupremos, 'CAMPOS BARRANZUELA, PRADO SALDARRIAGA');
  assert.equal(fields.ponente, ''); // empty value preserved
  assert.equal(fields.nDeExpedienteDeLaSalaSuperior, '2506-2019-0'); // accents/symbols slugged
  // a label repeated later with a blank value must not clobber the real one
  assert.equal(fields.tipoDeResolucion, 'Ejecutoria Suprema');
});

// ---------------------------------------------------------------------------
// retry / 429 semantics

function axios429(retryAfter?: string): AxiosError {
  return new AxiosError('rate limited', '429', undefined, undefined, {
    status: 429,
    headers: retryAfter !== undefined ? { 'retry-after': retryAfter } : {},
  } as unknown as AxiosResponse);
}

test('429 is retryable; 404 is not; network errors are', () => {
  assert.equal(isRetryable(axios429()), true);
  const notFound = new AxiosError('nf', '404', undefined, undefined, {
    status: 404,
    headers: {},
  } as unknown as AxiosResponse);
  assert.equal(isRetryable(notFound), false);
  assert.equal(isRetryable(new AxiosError('ECONNRESET')), true);
  assert.equal(isRetryable(new TypeError('bug')), false);
});

test('Retry-After: parses delta-seconds', () => {
  assert.equal(parseRetryAfterMs(axios429('7')), 7_000);
  assert.equal(parseRetryAfterMs(axios429()), null);
});

test('withRetry: retries 429 until success', async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      if (calls < 3) throw axios429('0');
      return 'ok';
    },
    { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 10, label: 'test' },
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('withRetry: exhausts attempts then throws RetriesExhaustedError', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw axios429('0');
      },
      { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10, label: 'test' },
    ),
    RetriesExhaustedError,
  );
  assert.equal(calls, 3);
});

test('withRetry: non-retryable errors fail fast (single attempt, accurate count)', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw new TypeError('logic bug');
      },
      { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 10, label: 'test' },
    ),
    (err: unknown) => err instanceof RetriesExhaustedError && err.attempts === 1,
  );
  assert.equal(calls, 1);
});

test('withRetry: Retry-After is honored on 503 too, not just 429', async () => {
  let calls = 0;
  const err503 = new AxiosError('unavailable', '503', undefined, undefined, {
    status: 503,
    headers: { 'retry-after': '0' },
  } as unknown as AxiosResponse);
  const result = await withRetry(
    async () => {
      calls++;
      if (calls < 2) throw err503;
      return 'ok';
    },
    { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10, label: 'test' },
  );
  assert.equal(result, 'ok');
  assert.equal(parseRetryAfterMs(err503), 0);
});

// ---------------------------------------------------------------------------
// small helpers

test('cookie jar: stores and emits session cookies', () => {
  const jar = new CookieJar();
  jar.store(['JSESSIONID=ABC123; Path=/repdig/; HttpOnly', 'other=1; Secure']);
  assert.equal(jar.header(), 'JSESSIONID=ABC123; other=1');
  jar.store(['JSESSIONID=NEW']);
  assert.equal(jar.header(), 'JSESSIONID=NEW; other=1');
});

test('sanitizeFileName strips characters illegal on Windows', () => {
  assert.equal(sanitizeFileName('Re 236/2013: "final" <v2>'), 'Re 236-2013- -final- -v2-');
});

test('toCsv escapes quotes, commas and newlines', () => {
  const csv = toCsv(['a', 'b'], [{ a: 'x,y', b: 'say "hi"\nok' }]);
  assert.equal(csv, 'a,b\r\n"x,y","say ""hi""\nok"\r\n');
});

test('Content-Disposition file name extraction', () => {
  assert.equal(fileNameFromDisposition('attachment;filename="Re 236-2013.pdf"'), 'Re 236-2013.pdf');
  assert.equal(fileNameFromDisposition(undefined), null);
  // quoted values may legally contain semicolons
  assert.equal(fileNameFromDisposition('attachment;filename="a;b.pdf"'), 'a;b.pdf');
  // bare token
  assert.equal(fileNameFromDisposition('attachment;filename=doc.pdf;size=1'), 'doc.pdf');
  // RFC 5987 percent-encoded
  assert.equal(fileNameFromDisposition("attachment;filename*=UTF-8''Re%20236.pdf"), 'Re 236.pdf');
});

// ---------------------------------------------------------------------------
// concurrency + proxy

test('mapLimit preserves order and respects the concurrency cap', async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (x) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return x * 10;
  });
  assert.deepEqual(out, [10, 20, 30, 40, 50, 60]); // input order preserved
  assert.ok(peak <= 2, `peak concurrency ${peak} exceeded cap 2`);
});

test('parseProxyUrl parses host, port and credentials', () => {
  assert.deepEqual(parseProxyUrl('http://10.0.0.2:3128'), {
    host: '10.0.0.2',
    port: 3128,
    protocol: 'http',
  });
  assert.deepEqual(parseProxyUrl('http://user:pass@10.0.0.1:8080'), {
    host: '10.0.0.1',
    port: 8080,
    protocol: 'http',
    auth: { username: 'user', password: 'pass' },
  });
});

test('ProxyPool round-robins and an empty pool goes direct', () => {
  const pool = ProxyPool.empty();
  assert.equal(pool.enabled, false);
  assert.equal(pool.next(), null);
});

// ---------------------------------------------------------------------------
// validation report

function writeRun(docs: DocumentRecord[], totalRecords: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scraper-report-'));
  fs.mkdirSync(path.join(dir, 'pdfs'));
  fs.writeFileSync(
    path.join(dir, 'state.json'),
    JSON.stringify({ site: 'pj', totalRecords, completedPages: [0], downloaded: {}, failed: [], updatedAt: '' }),
  );
  fs.writeFileSync(path.join(dir, 'documents.json'), JSON.stringify(docs));
  return dir;
}

test('report: a required field missing on all documents is flagged', () => {
  // recurso parsed fine, but nroexp is absent everywhere (a parsing regression).
  const docs: DocumentRecord[] = [
    { uuid: 'a', rowIndex: 0, page: 0, fields: { recurso: 'Casación' }, downloadButtonId: 'x' },
    { uuid: 'b', rowIndex: 1, page: 0, fields: { recurso: 'Apelación' }, downloadButtonId: 'y' },
  ];
  const report = buildReport(writeRun(docs, 100), '2026-07-14T00:00:00Z', ['recurso', 'nroexp']);
  assert.ok(report.warnings.some((w) => w.includes('nroexp') && w.includes('0%')));
  assert.ok(!report.warnings.some((w) => w.includes('recurso'))); // recurso is 100%, no warning
  assert.equal(report.ok, false);
});

test('report: clean run has no warnings and flags duplicate uuids', () => {
  const good: DocumentRecord[] = [
    { uuid: 'a', rowIndex: 0, page: 0, fields: { recurso: 'C', nroexp: '1' }, downloadButtonId: 'x' },
  ];
  assert.equal(buildReport(writeRun(good, 100), 'now', ['recurso', 'nroexp']).ok, true);

  const dup: DocumentRecord[] = [
    { uuid: 'a', rowIndex: 0, page: 0, fields: { recurso: 'C', nroexp: '1' }, downloadButtonId: 'x' },
    { uuid: 'a', rowIndex: 1, page: 0, fields: { recurso: 'C', nroexp: '2' }, downloadButtonId: 'y' },
  ];
  const report = buildReport(writeRun(dup, 100), 'now', ['recurso', 'nroexp']);
  assert.ok(report.warnings.some((w) => w.includes('duplicate uuid')));
});
