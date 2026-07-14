/**
 * Orchestrator: walks every result page, extracts document metadata and
 * downloads each PDF, with resume, retry and session-recovery semantics.
 *
 * Flow per run:
 *   init session -> search (exposes full result set) -> for each page:
 *   paginate -> parse rows -> download row PDFs -> persist state.
 *
 * Two failure domains are handled separately:
 *  - transient HTTP failures (429/5xx/network): exponential backoff via withRetry
 *  - JSF session/view loss: re-init + re-search + re-paginate, then retry once
 */

import * as fs from 'fs';
import * as path from 'path';
import { HttpClient } from './core/http-client';
import { JsfSession, SessionExpiredError } from './core/jsf-session';
import { log } from './core/logger';
import { RetriesExhaustedError, withRetry, DEFAULT_RETRY } from './core/retry';
import { mapLimit } from './core/concurrency';
import { ProxyPool } from './core/proxy';
import { sanitizeFileName } from './core/files';
import { SiteAdapter } from './sites/adapter';
import { StateStore } from './state';
import { buildReport, writeAndPrintReport } from './report';
import { DocumentRecord, ScraperOptions } from './types';

/** Set by the SIGINT handler; checked between units of work. */
let interrupted = false;
process.on('SIGINT', () => {
  if (interrupted) process.exit(130); // second Ctrl+C: exit immediately
  interrupted = true;
  log.warn('Interrupt received — finishing current document, saving state...');
});

export async function runScrape(adapter: SiteAdapter, opts: ScraperOptions): Promise<void> {
  const state = new StateStore(opts.outDir, adapter.name);
  const session = newSession(adapter, opts);

  log.info(`Site: ${adapter.description}`);
  log.info(`Output: ${path.resolve(opts.outDir)}`);

  await session.init();
  const search = await adapter.search(session);
  state.totalRecords = search.totalRecords;

  const totalPages = Math.ceil(search.totalRecords / search.pageSize);
  log.info(`${search.totalRecords} documents across ${totalPages} pages (page size ${search.pageSize})`);

  let pagesThisRun = 0;
  let docsThisRun = 0;

  for (let page = 0; page < totalPages; page++) {
    if (interrupted) break;
    if (opts.maxPages > 0 && pagesThisRun >= opts.maxPages) {
      log.info(`--max-pages ${opts.maxPages} reached, stopping`);
      break;
    }
    if (opts.maxDocs > 0 && docsThisRun >= opts.maxDocs) break;

    if (state.isPageCompleted(page)) {
      log.debug(`Page ${page + 1}/${totalPages}: already completed, skipping`);
      continue;
    }

    // Page 0 rows come free with the search; other pages need pagination.
    // (Re-runs that skip ahead also re-paginate so rows are rendered.)
    let rows: DocumentRecord[];
    if (page === 0 && pagesThisRun === 0) {
      rows = search.firstPageRows;
    } else {
      rows = await withSessionRecovery(
        () => adapter.fetchPage(session, page, search.pageSize),
        async () => {
          await reestablish(session, adapter, state);
        },
        `page ${page + 1}`,
      );
    }

    state.addDocuments(rows);
    log.info(`Page ${page + 1}/${totalPages}: ${rows.length} rows`);

    // Defense in depth: a page that yields 0 rows while the corpus is
    // non-empty is a transient error, not a real empty page. Don't mark it
    // complete, so a later run re-fetches it instead of losing those docs.
    // (Adapters also throw on this, but the guard covers any that don't.)
    if (rows.length === 0 && search.totalRecords > 0) {
      log.warn(`Page ${page + 1}/${totalPages}: 0 rows — not marking complete, will retry on re-run`);
      state.save();
      pagesThisRun++;
      continue;
    }

    // Only mark the page complete when the row loop ran to its natural end.
    let processedAllRows = true;
    if (!opts.skipPdfs) {
      const concurrency = adapter.concurrentDownloads ? opts.concurrency : 1;
      if (concurrency > 1) {
        // Concurrent path: the site's downloads are stateless (no shared view
        // state), so no session recovery — just retry each. maxDocs is a
        // soft cap here (a page finishes before the next is checked).
        const done = await mapLimit(rows, concurrency, (row) =>
          downloadRow(session, adapter, row, state, opts, search.pageSize, false),
        );
        docsThisRun += done.filter(Boolean).length;
        if (interrupted) processedAllRows = false;
      } else {
        for (const row of rows) {
          if (interrupted || (opts.maxDocs > 0 && docsThisRun >= opts.maxDocs)) {
            processedAllRows = false;
            break;
          }
          const downloaded = await downloadRow(session, adapter, row, state, opts, search.pageSize, true);
          if (downloaded) docsThisRun++;
        }
      }
    }
    if (opts.maxDocs > 0 && docsThisRun >= opts.maxDocs) {
      log.info(`--max-docs ${opts.maxDocs} reached, stopping`);
    }

    if (!interrupted && processedAllRows) state.markPageCompleted(page);

    state.save();
    pagesThisRun++;
  }

  state.save();
  summarize(state);
  runReport(opts.outDir, adapter.requiredFields);
  if (interrupted) {
    log.warn('Run interrupted — state saved; re-run to resume where you left off.');
    process.exit(130);
  }
}

/** Construct a session with the site's HTTP client, wiring proxy rotation
 *  when a proxies file was given (direct otherwise). */
function newSession(adapter: SiteAdapter, opts: ScraperOptions): JsfSession {
  const proxies = opts.proxiesFile ? ProxyPool.fromFile(opts.proxiesFile) : ProxyPool.empty();
  return new JsfSession(new HttpClient(adapter.baseUrl, opts.delayMs, proxies), adapter.pagePath);
}

/** Build, persist and print the validation report for an output directory. */
export function runReport(outDir: string, requiredFields: readonly string[] = []): void {
  const report = buildReport(outDir, new Date().toISOString(), requiredFields);
  writeAndPrintReport(outDir, report);
}

/** Re-process everything in the failed list (grouped by page to keep rows rendered). */
export async function retryFailed(adapter: SiteAdapter, opts: ScraperOptions): Promise<void> {
  const state = new StateStore(opts.outDir, adapter.name);
  const failed = state.failed;
  if (failed.length === 0) {
    log.info('No failed downloads recorded — nothing to retry.');
    return;
  }
  log.info(`Retrying ${failed.length} failed download(s)`);

  const session = newSession(adapter, opts);
  await session.init();
  const search = await adapter.search(session);

  const pages = [...new Set(failed.map((f) => f.page))].sort((a, b) => a - b);
  for (const page of pages) {
    if (interrupted) break;
    const rows =
      page === 0
        ? search.firstPageRows
        : await withSessionRecovery(
            () => adapter.fetchPage(session, page, search.pageSize),
            async () => {
              await reestablish(session, adapter, state);
            },
            `retry page ${page + 1}`,
          );
    state.addDocuments(rows);

    const targets = new Set(failed.filter((f) => f.page === page).map((f) => f.uuid));
    for (const row of rows) {
      if (interrupted) break;
      if (!targets.has(row.uuid) || state.isDownloaded(row.uuid)) continue;
      targets.delete(row.uuid);
      await downloadRow(session, adapter, row, state, opts, search.pageSize, true);
    }
    // Rows recorded on this page but no longer found here: the result set
    // shifted since the failure. Keep them in the failed list and say so,
    // rather than silently skipping them.
    const missing = [...targets].filter((uuid) => uuid !== null && !state.isDownloaded(uuid));
    for (const uuid of missing) {
      log.warn(
        `retry: document ${uuid} not found on its recorded page ${page + 1} — ` +
          `the result set may have shifted; re-run \`scrape\` to refresh, it stays in the failed list`,
      );
    }
    state.save();
  }

  state.save();
  summarize(state);
}

/**
 * Download one row's PDF. Returns true on success.
 * On exhausted retries the failure is recorded and the scraper moves on.
 * `recover` enables session re-establishment on view loss (sequential path);
 * the concurrent path passes false since its downloads are stateless and
 * re-establishing would mutate the session other tasks are using.
 */
async function downloadRow(
  session: JsfSession,
  adapter: SiteAdapter,
  row: DocumentRecord,
  state: StateStore,
  opts: ScraperOptions,
  pageSize: number,
  recover: boolean,
): Promise<boolean> {
  if (!row.uuid) {
    log.debug(`Row ${row.rowIndex}: no PDF link, metadata only`);
    return false;
  }
  if (state.isDownloaded(row.uuid)) {
    log.debug(`Row ${row.rowIndex}: already downloaded, skipping`);
    return false;
  }

  const label = `PDF ${downloadLabel(row)}`;

  const attempt = async (target: DocumentRecord): Promise<string> => {
    const { bytes, serverFileName } = await adapter.downloadPdf(session, target);

    // Both sites fail "softly": OEFA re-renders the page as HTML when the row
    // is no longer in the view; PJ answers a stale/lost session with an HTML
    // page instead of the PDF stream. Anything that is not a PDF is treated
    // as session loss so recovery re-establishes and retries.
    if (!looksLikePdf(bytes)) {
      throw new SessionExpiredError(`expected PDF, got ${bytes.length} bytes of non-PDF content`);
    }

    const fileName = uniqueFileName(state.pdfDir, adapter.pdfFileName(target, serverFileName), target);
    fs.writeFileSync(path.join(state.pdfDir, fileName), bytes);
    return fileName;
  };

  const attemptWithRetry = (target: DocumentRecord) =>
    withRetry(() => attempt(target), { ...DEFAULT_RETRY, maxAttempts: opts.maxAttempts, label });

  try {
    const fileName = recover
      ? await withSessionRecovery(
          () => attemptWithRetry(row),
          async () => {
            const fresh = await reestablish(session, adapter, state, row.page, pageSize);
            // Match strictly by uuid: row indexes shift if the result set
            // changed, and downloading the wrong document would be worse
            // than failing.
            const replacement = fresh.find((r) => r.uuid === row.uuid);
            if (replacement) Object.assign(row, replacement);
          },
          label,
        )
      : await attemptWithRetry(row);
    state.recordDownload(row, fileName);
    log.info(`  ✓ ${fileName} (${state.downloadedCount} total)`);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const attempts = err instanceof RetriesExhaustedError ? err.attempts : 1;
    state.recordFailure(row, attempts, message);
    log.error(`  ✗ ${label}: ${message} — recorded for retry-failed`);
    return false;
  }
}

/**
 * Run `fn`; if the JSF view/session died, run `recover` (re-init + re-render)
 * and try `fn` once more. Anything else propagates.
 */
async function withSessionRecovery<T>(
  fn: () => Promise<T>,
  recover: () => Promise<void>,
  label: string,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const sessionLoss =
      err instanceof SessionExpiredError ||
      (err instanceof RetriesExhaustedError && err.lastError instanceof SessionExpiredError);
    if (!sessionLoss) throw err;
    log.warn(`${label}: session/view expired — re-establishing session`);
    await recover();
    return fn();
  }
}

/** Fresh session + search (+ optional pagination back to `page`). */
async function reestablish(
  session: JsfSession,
  adapter: SiteAdapter,
  state: StateStore,
  page?: number,
  pageSize?: number,
): Promise<DocumentRecord[]> {
  await session.init();
  const search = await adapter.search(session);
  state.totalRecords = search.totalRecords;
  if (page === undefined || page === 0) return search.firstPageRows;
  return adapter.fetchPage(session, page, pageSize ?? search.pageSize);
}

function looksLikePdf(body: Buffer): boolean {
  return body.subarray(0, 5).toString('latin1') === '%PDF-';
}

/** A short, human-readable id for a row, tolerant of per-site field names. */
function downloadLabel(row: DocumentRecord): string {
  const f = row.fields;
  return f.nroResolucionApelacion || f.numeroExpediente || f.nroexp || row.uuid || `row-${row.rowIndex}`;
}

/**
 * Avoid clobbering distinct documents that share a resolution number:
 * on name collision, disambiguate with a uuid fragment.
 */
function uniqueFileName(dir: string, fileName: string, row: DocumentRecord): string {
  if (!fs.existsSync(path.join(dir, fileName))) return fileName;
  const suffix = row.uuid ? row.uuid.slice(0, 8) : String(row.rowIndex);
  return sanitizeFileName(`${fileName.replace(/\.pdf$/i, '')}__${suffix}`) + '.pdf';
}

function summarize(state: StateStore): void {
  log.info('—'.repeat(60));
  log.info(
    `Summary: ${state.documentCount} documents extracted, ` +
      `${state.downloadedCount} PDFs downloaded, ${state.failed.length} failed`,
  );
  if (state.failed.length > 0) {
    log.warn(`Failed downloads are recorded in state.json — run \`npm run retry-failed\` to reprocess them.`);
  }
}
