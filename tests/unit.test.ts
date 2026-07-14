/**
 * Unit tests for the pure logic: partial-response parsing, row extraction,
 * retry/backoff semantics and file helpers. Uses Node's built-in test runner
 * (no extra dependencies) with fixtures captured from the live site.
 *
 * Run: npm test
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AxiosError, AxiosResponse } from 'axios';

import { parsePartialResponse } from '../src/core/jsf-session';
import { OefaAdapter } from '../src/sites/oefa';
import { DocumentRecord } from '../src/types';
import {
  isRetryable,
  parseRetryAfterMs,
  withRetry,
  RetriesExhaustedError,
} from '../src/core/retry';
import { CookieJar } from '../src/core/cookie-jar';
import { sanitizeFileName, toCsv, fileNameFromDisposition } from '../src/core/files';
import {
  SEARCH_FRAGMENT,
  PAGE_FRAGMENT,
  PARTIAL_RESPONSE,
  PARTIAL_RESPONSE_SPLIT_CDATA,
  PARTIAL_RESPONSE_ERROR,
  PARTIAL_RESPONSE_REDIRECT,
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
