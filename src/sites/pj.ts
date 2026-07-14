/**
 * Adapter: PJ — Jurisprudencia Nacional Sistematizada, Poder Judicial del
 * Perú (https://jurisprudencia.pj.gob.pe/jurisprudenciaweb/faces/page/resultado.xhtml).
 *
 * Stack observed: JSF (Mojarra) + RichFaces 4.2.2, server-side state saving
 * (the ViewState is a short `id1:id2` token, not an encrypted tree). The
 * interaction model is classic, non-AJAX JSF — quite different from OEFA's
 * PrimeFaces partial responses:
 *
 *  - Entry: GET `inicio.xhtml` → JSESSIONID + ViewState + the full search form.
 *  - Search: a FULL form POST of that whole form plus the "general search"
 *    button's params. The server answers 302 → `resultado.xhtml`. The site
 *    sits behind a TLS proxy that emits `http://` redirect Locations, which
 *    the HTTP client upgrades back to https.
 *  - Pagination: another full form POST of the results form, driving the
 *    RichFaces page-number spinner (`formBuscador:spinner`) + its "IR" button
 *    to jump to an arbitrary 1-based page. Each page renders 10 items.
 *  - Metadata: each result is a `formBuscador:repeat:N:...` block whose
 *    download link's onclick embeds every field we want (uuid, expediente,
 *    recurso, sala, fecha, sumilla, ...) — so we read metadata straight from
 *    that JS object rather than scraping the surrounding markup.
 *  - Download: a plain `GET /jurisprudenciaweb/ServletDescarga?uuid=<uuid>`
 *    streams the PDF (`Content-Disposition: attachment`). No arming needed.
 */

import { JsfSession } from '../core/jsf-session';
import { DocumentRecord } from '../types';
import { PdfDownload, SearchResult, SiteAdapter } from './adapter';
import { fileNameFromDisposition, sanitizeFileName } from '../core/files';
import { log } from '../core/logger';
import { sleep } from '../core/retry';

const FORM = 'formBuscador';
const SPINNER = `${FORM}:spinner`;
const SERVLET = '/jurisprudenciaweb/ServletDescarga?uuid=';
const PAGE_SIZE = 10;

/** The site phrases the count a few ways ("De un total de N resultados",
 *  "se obtuvieron N resultados"); the number always precedes "resultados". */
const TOTAL_RECORDS = /(\d+)\s*resultados/i;

/** Metadata keys carried in each result's download-link onclick object. */
const META_KEYS = [
  'uuid',
  'recurso',
  'nroexp',
  'palabras',
  'pretensiones',
  'normaDI',
  'tipoResolucion',
  'fechaResolucion',
  'sala',
  'sumilla',
] as const;

export class PjAdapter implements SiteAdapter {
  readonly name = 'pj';
  readonly description = 'PJ — Jurisprudencia Nacional Sistematizada (Poder Judicial del Perú)';
  readonly baseUrl = 'https://jurisprudencia.pj.gob.pe';
  /** Session inits (GETs) here; the search form lives on this page. */
  readonly pagePath = '/jurisprudenciaweb/faces/page/inicio.xhtml';
  private readonly resultPath = '/jurisprudenciaweb/faces/page/resultado.xhtml';

  async search(session: JsfSession): Promise<SearchResult> {
    // The PJ server returns intermittent 500s on navigation. A fresh view
    // (re-init) per attempt is more reliable than re-posting a possibly
    // stale ViewState, so search re-establishes the session between tries.
    const html = await withReinit(session, 'search', async () => {
      const inicio = session.pageHtml;
      // Full form + the general-search button's params: RichFaces requires
      // the entire form to be resubmitted.
      const fields = harvestForm(inicio, FORM);
      Object.assign(fields, generalSearchButton(inicio));
      const page = await session.postPage(fields, 'search', this.pagePath);
      if (!TOTAL_RECORDS.test(page)) {
        throw new Error('PJ search returned no result count (transient server error?)');
      }
      return page;
    });

    return {
      totalRecords: Number(html.match(TOTAL_RECORDS)![1]),
      pageSize: PAGE_SIZE,
      firstPageRows: parseResults(html, 0),
    };
  }

  async fetchPage(session: JsfSession, pageIndex: number, _pageSize: number): Promise<DocumentRecord[]> {
    // Jump to a 1-based page via the page-number spinner + "IR" button.
    // On a lost view (re-init), the search must be replayed before the
    // spinner exists again — hence the re-search inside the recovery.
    const html = await withReinit(session, `page ${pageIndex + 1}`, async () => {
      if (!/formBuscador:spinner/.test(session.pageHtml)) await this.search(session);
      const current = session.pageHtml;
      const fields = harvestForm(current, FORM);
      fields[SPINNER] = String(pageIndex + 1);
      fields[irButtonId(current)] = 'IR';
      return session.postPage(fields, `page ${pageIndex + 1}`, this.resultPath);
    });
    return parseResults(html, pageIndex);
  }

  async downloadPdf(session: JsfSession, row: DocumentRecord): Promise<PdfDownload> {
    if (!row.uuid) throw new Error(`Row ${row.rowIndex} has no uuid`);
    const res = await session.get(SERVLET + encodeURIComponent(row.uuid));
    return {
      bytes: res.data,
      serverFileName: fileNameFromDisposition(res.headers['content-disposition']),
    };
  }

  pdfFileName(row: DocumentRecord, serverFileName: string | null): string {
    // e.g. "Casacion-001785-2024__Resolucion_10_2026....pdf"
    const recurso = row.fields.recurso || 'resolucion';
    const nroexp = row.fields.nroexp || `row-${row.rowIndex}`;
    const server = serverFileName?.replace(/\.pdf$/i, '');
    const base = server ? `${recurso}-${nroexp}__${server}` : `${recurso}-${nroexp}`;
    return `${sanitizeFileName(base)}.pdf`;
  }
}

/**
 * Run `fn`, and on failure re-initialize the session (fresh ViewState) and
 * try again, up to a few times with linear backoff. This absorbs the PJ
 * server's frequent intermittent 500s on navigation, which a plain
 * same-ViewState retry cannot recover from.
 */
async function withReinit<T>(
  session: JsfSession,
  label: string,
  fn: () => Promise<T>,
  attempts = 4,
): Promise<T> {
  let lastError: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (i === attempts) break;
      const wait = 1500 * i;
      log.warn(`${label}: ${(err as Error).message} — re-initializing session (try ${i}/${attempts - 1})`);
      await sleep(wait);
      await session.init();
    }
  }
  throw lastError;
}

/**
 * Parse the 10 result items on a page. Metadata is read from each item's
 * download-link onclick, which carries a JS object with every field —
 * more reliable than scraping the visually-formatted panel around it.
 */
export function parseResults(html: string, pageIndex: number): DocumentRecord[] {
  const rows: DocumentRecord[] = [];
  // The download control's onclick is doubly escaped: the JS string quotes
  // are HTML-entity encoded (`&quot;`) AND backslash-escaped (`\"`), and the
  // uuid dashes arrive as `-`. Collapse all of that so the params
  // object reads as plain `"key":"value"`.
  const text = htmlUnescape(html)
    .replace(/\\+"/g, '"')
    .replace(/\\+u002[dD]/g, '-')
    .replace(/\\+\//g, '/');
  // RichFaces.ajax("formBuscador:repeat:N:jXXX", event, {"parameters":{...}})
  const linkRe = /RichFaces\.ajax\("(formBuscador:repeat:(\d+):[^"]+)",event,\{"parameters":\{(.*?)\}\s*,/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(text)) !== null) {
    if (!m[3].includes('"uuid"')) continue;
    const localIndex = Number(m[2]);
    const params = parseJsfParams(m[3]);
    if (!params.uuid) continue;

    const fields: Record<string, string> = {};
    for (const key of META_KEYS) {
      if (params[key] !== undefined && key !== 'uuid') fields[key] = params[key];
    }

    rows.push({
      uuid: params.uuid,
      // RichFaces assigns each `repeat:N` its absolute position in the full
      // result set (page 3 renders repeat:20..29), so N *is* the row index.
      rowIndex: localIndex,
      page: pageIndex,
      fields,
      downloadButtonId: m[1],
    });
  }
  return rows;
}

/**
 * Harvest a JSF form's submittable fields from a full HTML page: text/hidden
 * inputs and the selected option of each <select>. Buttons and unchecked
 * checkboxes/radios are omitted, matching what a browser would send.
 */
export function harvestForm(html: string, formId: string): Record<string, string> {
  const form = sliceForm(html, formId);
  const fields: Record<string, string> = {};

  const inputRe = /<input\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = inputRe.exec(form)) !== null) {
    const tag = m[0];
    const name = attr(tag, 'name');
    if (!name) continue;
    const type = (attr(tag, 'type') || 'text').toLowerCase();
    if (type === 'submit' || type === 'button' || type === 'image' || type === 'reset') continue;
    if ((type === 'checkbox' || type === 'radio') && !/\bchecked\b/i.test(tag)) continue;
    fields[name] = attr(tag, 'value') ?? '';
  }

  const selectRe = /<select\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/gi;
  while ((m = selectRe.exec(form)) !== null) {
    const [, name, body] = m;
    const selected =
      body.match(/<option[^>]*value="([^"]*)"[^>]*\bselected\b/i) ??
      body.match(/<option[^>]*value="([^"]*)"/i);
    fields[name] = selected ? selected[1] : '';
  }

  return fields;
}

/**
 * Extract the params object of the general-search button. Inside the onclick
 * the object is written with backslash-escaped quotes, e.g.
 *   {\'formBuscador:j_idt69\':\'formBuscador:j_idt69\',\'forward\':\'buscar\',...}
 * The general button forwards to "buscar" and, unlike the specialized tab,
 * carries no `busqueda:especializada` marker.
 */
export function generalSearchButton(html: string): Record<string, string> {
  const blockRe = /\{((?:\\'[^']*\\':\\'[^']*\\',?)+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) !== null) {
    const body = m[1];
    if (!/\\'forward\\':\\'buscar\\'/.test(body)) continue;
    if (/\\'busqueda\\':\\'especializada\\'/.test(body)) continue;
    return parseJsfcljsParams(body);
  }
  throw new Error('Could not locate the general-search button on inicio.xhtml');
}

/** The RichFaces "IR" page-jump submit button id (first paginator). */
function irButtonId(html: string): string {
  const m = html.match(/<input[^>]*name="(formBuscador:j_idt\d+)"[^>]*value="IR"/);
  if (!m) throw new Error('Could not find the "IR" pagination button');
  return m[1];
}

/** Slice out `<form id="...">...</form>`; falls back to whole doc if absent. */
function sliceForm(html: string, formId: string): string {
  const start = html.search(new RegExp(`<form[^>]*id="${escapeRe(formId)}"`, 'i'));
  if (start < 0) return html;
  const end = html.indexOf('</form>', start);
  return end < 0 ? html.slice(start) : html.slice(start, end);
}

/** Parse a `mojarra.jsfcljs` param body with backslash-escaped quotes:
 *  `\'k\':\'v\',\'k2\':\'v2\'`. */
function parseJsfcljsParams(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /\\'([^']*)\\':\\'([^']*)\\'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) out[m[1]] = m[2];
  return out;
}

/**
 * Parse a RichFaces parameters object body `"k":"v","k2":"v2"`, decoding the
 * escapes RichFaces emits: `-` (dash) and `\/` (slash). Values are HTML
 * entities that we also unescape (e.g. `&quot;` never appears inside, but
 * accented text arrives as raw UTF-8).
 */
function parseJsfParams(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /"([^"]+)":"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    out[m[1]] = m[2].replace(/\s+/g, ' ').trim();
  }
  return out;
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`, 'i'));
  return m ? m[1] : null;
}

/** Decode the handful of HTML entities these pages use. */
function htmlUnescape(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
