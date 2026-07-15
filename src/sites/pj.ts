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

import * as cheerio from 'cheerio';
import { JsfSession, SessionExpiredError } from '../core/jsf-session';
import { DocumentRecord, FichaDetail } from '../types';
import { PdfDownload, SearchResult, SiteAdapter } from './adapter';
import { fileNameFromDisposition, sanitizeFileName } from '../core/files';
import { log } from '../core/logger';
import { parseRetryAfterMs, RetriesExhaustedError, sleep } from '../core/retry';

const FORM = 'formBuscador';
const SPINNER = `${FORM}:spinner`;
const SERVLET = '/jurisprudenciaweb/ServletDescarga?uuid=';
/** The detail-modal container the "Ver Ficha" AJAX re-renders. */
const POPUP = `${FORM}:popupResolucion`;
const PAGE_SIZE = 10;

/** The list-level metadata keys the ficha request echoes back to the server. */
const FICHA_ECHO_KEYS: readonly string[] = [
  'recurso', 'nroexp', 'palabras', 'pretensiones', 'normaDI',
  'tipoResolucion', 'fechaResolucion', 'sala', 'sumilla',
];

/**
 * The three section headers the ficha modal is organized into. Matched by
 * their heading text (accent-tolerant) rather than a fixed markup shape, so a
 * label/value pair is filed under whichever section header precedes it. Pairs
 * before any known header — or after an unexpected one — fall into `extra`, so
 * nothing is lost even if a document's modal doesn't follow the usual layout.
 */
const FICHA_SECTIONS: ReadonlyArray<{ key: keyof FichaDetail; re: RegExp }> = [
  { key: 'resolucion', re: /DATOS\s+DE\s+LA\s+RESOLUCI[OÓ]N/i },
  { key: 'proceso', re: /DATOS\s+DEL\s+PROCESO/i },
  { key: 'procedencia', re: /DATOS\s+DE\s+PROCEDENCIA/i },
];

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
  /** recurso + expediente identify every resolution; the rest (sumilla,
   *  palabras, normaDI…) are genuinely optional and vary by document. */
  readonly requiredFields = ['recurso', 'nroexp'] as const;
  /** ServletDescarga is a stateless GET (uuid + cookie), so downloads
   *  parallelize safely within one session. */
  readonly concurrentDownloads = true;
  /** Session inits (GETs) here; the search form lives on this page. */
  readonly pagePath = '/jurisprudenciaweb/faces/page/inicio.xhtml';
  private readonly resultPath = '/jurisprudenciaweb/faces/page/resultado.xhtml';

  async search(session: JsfSession): Promise<SearchResult> {
    // The PJ server returns intermittent 500s on navigation. A fresh view
    // (re-init) per attempt is more reliable than re-posting a possibly
    // stale ViewState, so search re-establishes the session between tries.
    return withReinit(session, 'search', async () => {
      const inicio = session.pageHtml;
      // Full form + the general-search button's params: RichFaces requires
      // the entire form to be resubmitted.
      const fields = harvestForm(inicio, FORM);
      Object.assign(fields, generalSearchButton(inicio));
      const page = await session.postPage(fields, 'search', this.pagePath);
      const total = page.match(TOTAL_RECORDS);
      if (!total) throw new Error('PJ search returned no result count (transient server error?)');
      const firstPageRows = parseResults(page, 0);
      // A count but no parseable rows means the server returned an error/empty
      // shell (it is flaky) — throw so withReinit gets a fresh view and retries
      // rather than reporting a bogus empty first page.
      if (Number(total[1]) > 0 && firstPageRows.length === 0) {
        throw new Error('PJ search: result count present but 0 rows parsed (transient error page?)');
      }
      return { totalRecords: Number(total[1]), pageSize: PAGE_SIZE, firstPageRows };
    });
  }

  async fetchPage(session: JsfSession, pageIndex: number, _pageSize: number): Promise<DocumentRecord[]> {
    // Jump to a 1-based page via the page-number spinner + "IR" button.
    // On a lost view (re-init), the search must be replayed before the
    // spinner exists again — hence the re-search inside the recovery.
    return withReinit(session, `page ${pageIndex + 1}`, async () => {
      if (!/formBuscador:spinner/.test(session.pageHtml)) await this.search(session);
      const current = session.pageHtml;
      const fields = harvestForm(current, FORM);
      fields[SPINNER] = String(pageIndex + 1);
      fields[irButtonId(current)] = 'IR';
      const html = await session.postPage(fields, `page ${pageIndex + 1}`, this.resultPath);
      const rows = parseResults(html, pageIndex);
      // Every in-range page has at least one row; 0 rows is a transient error
      // page, not a real empty page. Throw so it is retried, not lost.
      if (rows.length === 0) {
        throw new Error(`PJ page ${pageIndex + 1}: 0 rows parsed (transient error page?)`);
      }
      return rows;
    });
  }

  async downloadPdf(session: JsfSession, row: DocumentRecord): Promise<PdfDownload> {
    if (!row.uuid) throw new Error(`Row ${row.rowIndex} has no uuid`);
    const res = await session.get(SERVLET + encodeURIComponent(row.uuid));
    return {
      bytes: res.data,
      serverFileName: fileNameFromDisposition(res.headers['content-disposition']),
    };
  }

  /**
   * Fetch the "Ver Ficha" modal and return its ~40 detail fields. It's a
   * RichFaces AJAX that re-renders the popup (`render=@component`) carrying
   * the row's identifiers. The row must be rendered in the current view, so
   * on the flaky server's ViewExpired we restore the page (re-paginate) and
   * retry rather than losing the detail.
   */
  async fetchDetail(session: JsfSession, row: DocumentRecord): Promise<FichaDetail> {
    if (!row.downloadButtonId || !row.uuid) return emptyDetail();
    const btn = row.downloadButtonId;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const fields = harvestForm(session.pageHtml, FORM);
        Object.assign(fields, fichaParams(row, btn));
        const res = await session.postAjax(fields, this.resultPath);
        const modal = res.updates.get(POPUP);
        const decoded = modal ? htmlUnescape(modal) : '';
        if (!/DATOS DE LA RESOLUCI/i.test(decoded)) {
          throw new SessionExpiredError('ficha modal came back empty');
        }
        return parseFicha(decoded);
      } catch (err) {
        if (attempt === 3) throw err;
        // Re-establish a fresh, valid view on the row's page, then retry.
        await this.fetchPage(session, row.page, PAGE_SIZE);
      }
    }
    return emptyDetail();
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
 * try again, with the same exponential backoff + jitter policy as the inner
 * retry layer (and honoring Retry-After if the underlying failure carried
 * one). This absorbs the PJ server's frequent intermittent 500s on
 * navigation, which a plain same-ViewState retry cannot recover from.
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
      // If fn() exhausted its inner retries, the rate-limit hint (if any)
      // lives on the wrapped error, not the wrapper.
      const cause = err instanceof RetriesExhaustedError ? err.lastError : err;
      const retryAfter = parseRetryAfterMs(cause);
      const backoff = Math.round(1500 * 2 ** (i - 1) * (0.75 + Math.random() * 0.5));
      const wait = Math.min(retryAfter ?? backoff, 60_000);
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
  // RichFaces.ajax("formBuscador:repeat:N:jXXX", event, {"parameters":{...}} ,"incId":"1"} )
  // Anchor the params object on the trailing "incId" marker so a value that
  // itself contains "}" (possible in a sumilla) can't terminate it early.
  const linkRe = /RichFaces\.ajax\("(formBuscador:repeat:(\d+):[^"]+)",event,\{"parameters":\{([\s\S]*?)\}\s*,\s*"incId"/g;
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

/** Build the "Ver Ficha" AJAX parameters for a row (minus the form fields,
 *  which the caller harvests). Mirrors the RichFaces click request. */
function fichaParams(row: DocumentRecord, btn: string): Record<string, string> {
  const echoed: Record<string, string> = { uuid: row.uuid ?? '' };
  for (const key of FICHA_ECHO_KEYS) echoed[key] = row.fields[key] ?? '';
  return {
    ...echoed,
    'javax.faces.source': btn,
    'javax.faces.partial.event': 'click',
    'javax.faces.partial.execute': `${btn} @component`,
    'javax.faces.partial.render': '@component',
    'org.richfaces.ajax.component': btn,
    [btn]: btn,
    'AJAX:EVENTS_COUNT': '1',
    'javax.faces.partial.ajax': 'true',
  };
}

/**
 * Parse the detail modal's HTML into its three sections. Each field is
 *   <div class="...txtbold...">Label:</div>
 *   <div class="...marginb2..."><span class="data">Value</span></div>
 * so we pair every bold label with the value box that follows it, and file the
 * pair under whichever section header (DATOS DE LA RESOLUCIÓN / DEL PROCESO /
 * DE PROCEDENCIA) most recently preceded it in the document.
 *
 * This is deliberately structure-agnostic: it captures whatever labels a modal
 * actually presents (grouping by position), so a document that omits a field,
 * adds one, or renders an unfamiliar section neither breaks parsing nor loses
 * data — stray pairs land in `extra`. The `***` role prefixes and the section
 * headers themselves (which have no value box) are dropped.
 */
export function parseFicha(modalHtml: string): FichaDetail {
  const detail = emptyDetail();
  const $ = cheerio.load(modalHtml);
  let section: keyof FichaDetail = 'extra';
  let label: string | null = null;

  // Walk every element in document order. Labels and values are the `txtbold` /
  // `marginb2` divs; a section header is any element whose own text is one of
  // the three titles. Values are read with `.text()`, which includes the text
  // of any nested markup — so a value wrapped in extra elements is captured in
  // full (a regex up to the first `</div>` would silently truncate it).
  $('body *').each((_i, el) => {
    const $el = $(el);
    const cls = $el.attr('class') ?? '';

    if (/(^|\s)txtbold(\s|$)/.test(cls)) {
      const text = $el.text().replace(/\s+/g, ' ').trim();
      // The section titles themselves are `txtbold` divs (inside the panel
      // heading), so check for a header BEFORE treating the element as a
      // field label — otherwise the title is swallowed as a label and every
      // field lands in `extra`.
      const header = FICHA_SECTIONS.find((s) => s.re.test(text));
      if (header) {
        section = header.key;
        label = null;
        return;
      }
      label = text.replace(/\*+/g, '').replace(/:\s*$/, '').trim();
      return;
    }
    if (/(^|\s)marginb2(\s|$)/.test(cls)) {
      if (label !== null) {
        const key = slug(label);
        const value = $el.text().replace(/\s+/g, ' ').trim();
        const bucket = detail[section];
        // Within a section a label could still repeat; keep the first non-empty
        // value so a later blank one can't clobber real data.
        if (key && (!(key in bucket) || (bucket[key] === '' && value !== ''))) bucket[key] = value;
      }
      label = null;
      return;
    }
    // Section header: match on the element's OWN text (children removed) so a
    // container that merely wraps a header isn't mistaken for one.
    const own = $el.clone().children().remove().end().text().replace(/\s+/g, ' ').trim();
    const header = FICHA_SECTIONS.find((s) => s.re.test(own));
    if (header) {
      section = header.key;
      label = null;
    }
  });
  return detail;
}

function emptyDetail(): FichaDetail {
  return { resolucion: {}, proceso: {}, procedencia: {}, extra: {} };
}

/** "N° de Expediente de la Sala Superior" -> "nroDeExpedienteDeLaSalaSuperior". */
function slug(label: string): string {
  const words = label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining accents
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  if (words.length === 0) return '';
  return words
    .map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join('');
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
 * Parse a parameters object body `"k":"v","k2":"v2"` into key/value pairs.
 * A value ends at the *pair boundary* (`","` before the next key, or the end
 * of the body), not at the first inner quote — so a value that itself
 * contains a quote (legal sumillas quote statements) survives intact.
 */
function parseJsfParams(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /"([^"]+)":"([\s\S]*?)"(?=\s*,\s*"|\s*$)/g;
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
