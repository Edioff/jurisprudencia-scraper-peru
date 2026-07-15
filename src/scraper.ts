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
import { HttpClient, RateLimiter } from './core/http-client';
import { JsfSession, SessionExpiredError } from './core/jsf-session';
import { log } from './core/logger';
import { RetriesExhaustedError, withRetry, DEFAULT_RETRY } from './core/retry';
import { mapLimit } from './core/concurrency';
import { ProxyPool } from './core/proxy';
import { sanitizeFileName } from './core/files';
import { RunStatus } from './core/db';
import { SearchResult, SiteAdapter } from './sites/adapter';
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
  const state = new StateStore(opts.outDir, adapter.name, { hasDetail: !!adapter.fetchDetail });
  state.startRun('scrape');

  let status: RunStatus = 'completed';
  try {
    status = await scrapeAllPages(state, adapter, opts);
  } catch (err) {
    status = 'failed';
    throw err;
  } finally {
    // Whatever happened — clean finish, Ctrl+C or an unexpected crash — record
    // the run's outcome, flush the human-facing exports and close the database.
    finalizeRun(state, status);
  }

  runReport(opts.outDir, adapter.requiredFields);
  if (interrupted) {
    log.warn('Run interrupted — state saved; re-run to resume where you left off.');
    process.exit(130);
  }
}

/**
 * Walk every result page: paginate, extract metadata + ficha, download PDFs.
 * Returns the run outcome (`completed`, or `interrupted` if Ctrl+C was hit).
 * Pagination is sequential by default; `--page-concurrency N` runs N
 * independent sessions over stripes of pages (see `scrapePagesConcurrently`).
 */
async function scrapeAllPages(
  state: StateStore,
  adapter: SiteAdapter,
  opts: ScraperOptions,
): Promise<RunStatus> {
  // With page concurrency, every session shares one limiter so the *global*
  // request rate stays as polite as a single session's.
  const limiter = opts.pageConcurrency > 1 ? new RateLimiter(opts.delayMs) : undefined;
  const session = newSession(adapter, opts, limiter);

  log.info(`Site: ${adapter.description}`);
  log.info(`Output: ${path.resolve(opts.outDir)}`);

  await session.init();
  const search = await adapter.search(session);
  state.totalRecords = search.totalRecords;

  const totalPages = Math.ceil(search.totalRecords / search.pageSize);
  log.info(`${search.totalRecords} documents across ${totalPages} pages (page size ${search.pageSize})`);

  if (opts.pageConcurrency > 1) {
    await scrapePagesConcurrently(state, adapter, opts, session, search, totalPages, limiter!);
  } else {
    await scrapePagesSequentially(state, adapter, opts, session, search, totalPages);
  }

  const status: RunStatus = interrupted ? 'interrupted' : 'completed';
  summarize(state, status, totalPages);
  return status;
}

/** Sequential pagination: one session, page after page (the default). */
async function scrapePagesSequentially(
  state: StateStore,
  adapter: SiteAdapter,
  opts: ScraperOptions,
  session: JsfSession,
  search: SearchResult,
  totalPages: number,
): Promise<void> {
  let pagesThisRun = 0;
  let docsThisRun = 0;

  for (let page = 0; page < totalPages; page++) {
    if (interrupted) break;
    if (opts.maxPages > 0 && pagesThisRun >= opts.maxPages) {
      log.info(`--max-pages ${opts.maxPages} reached, stopping`);
      break;
    }
    if (opts.maxDocs > 0 && docsThisRun >= opts.maxDocs) {
      log.info(`--max-docs ${opts.maxDocs} reached, stopping`);
      break;
    }
    if (state.isPageCompleted(page)) {
      log.debug(`Page ${page + 1}/${totalPages}: already completed, skipping`);
      continue;
    }

    // Page 0's rows come free with the search; the rest need pagination.
    const preloaded = page === 0 && pagesThisRun === 0 ? search.firstPageRows : null;
    const budget = opts.maxDocs > 0 ? opts.maxDocs - docsThisRun : Infinity;
    const { downloaded } = await processPage(session, adapter, opts, state, search, page, totalPages, preloaded, budget);
    docsThisRun += downloaded;
    pagesThisRun++;
    state.save();
  }
}

/**
 * Parallel pagination via N independent sessions. Pagination can't be
 * parallelized *within* a session (the ViewState mutates on every navigation
 * POST), so each worker gets its own session + ViewState and pulls pages from a
 * shared queue (`claimPage`) — whoever is free takes the next page, which
 * balances the work far better than fixed stripes when a run cap is in play.
 * All workers share one rate limiter, so the global request rate stays polite
 * regardless of N. This is the single-process form of the horizontal sharding
 * described in the README.
 */
async function scrapePagesConcurrently(
  state: StateStore,
  adapter: SiteAdapter,
  opts: ScraperOptions,
  firstSession: JsfSession,
  search: SearchResult,
  totalPages: number,
  limiter: RateLimiter,
): Promise<void> {
  const workerCount = Math.min(opts.pageConcurrency, totalPages);
  // Shared cursor + counters. Safe without locks: `claimPage` has no awaits, so
  // in single-threaded JS its read-decide-increment never interleaves.
  const counters = { pages: 0, docs: 0 };
  let nextPage = 0;
  log.info(`Paginating with ${workerCount} parallel sessions`);

  /** Hand out the next page to process, honoring resume and the run caps. */
  const claimPage = (): number | null => {
    while (nextPage < totalPages) {
      if (opts.maxPages > 0 && counters.pages >= opts.maxPages) return null;
      if (opts.maxDocs > 0 && counters.docs >= opts.maxDocs) return null;
      const page = nextPage++;
      if (state.isPageCompleted(page)) continue; // already done on a prior run
      counters.pages += 1;
      return page;
    }
    return null;
  };

  const worker = async (w: number): Promise<void> => {
    // Worker 0 reuses the session that already ran the search; the others open
    // their own and establish their view before paginating.
    const session = w === 0 ? firstSession : newSession(adapter, opts, limiter);
    if (w !== 0) {
      await session.init();
      await adapter.search(session);
    }

    for (;;) {
      if (interrupted) break;
      const page = claimPage();
      if (page === null) break;
      const budget = opts.maxDocs > 0 ? opts.maxDocs - counters.docs : Infinity;
      const { downloaded } = await processPage(session, adapter, opts, state, search, page, totalPages, null, budget);
      counters.docs += downloaded;
      state.save();
    }
  };

  await Promise.all(Array.from({ length: workerCount }, (_v, w) => worker(w)));
}

/**
 * Process one result page on `session`: paginate to it (unless `preloaded`
 * rows were supplied), extract metadata + ficha, and download the PDFs.
 * Failures are recorded and the page skipped (record-and-continue). Returns how
 * many PDFs it downloaded and whether the page was fully processed. `docBudget`
 * caps the sequential download loop so a global --max-docs is honored
 * (Infinity = no cap).
 */
async function processPage(
  session: JsfSession,
  adapter: SiteAdapter,
  opts: ScraperOptions,
  state: StateStore,
  search: SearchResult,
  page: number,
  totalPages: number,
  preloaded: DocumentRecord[] | null,
  docBudget: number,
): Promise<{ downloaded: number; processedAll: boolean }> {
  state.startPage(page); // pending → in_progress

  // A page that keeps failing after recovery is recorded and skipped rather
  // than aborting the run — the record-and-continue policy the challenge asks
  // for on persistent errors.
  let rows: DocumentRecord[];
  try {
    rows =
      preloaded ??
      (await withSessionRecovery(
        () => adapter.fetchPage(session, page, search.pageSize),
        async () => {
          await reestablish(session, adapter, state);
        },
        `page ${page + 1}`,
      ));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Page ${page + 1}/${totalPages}: ${msg} — marked failed, continuing`);
    state.markPageFailed(page, msg);
    return { downloaded: 0, processedAll: false };
  }

  log.info(`Page ${page + 1}/${totalPages}: ${rows.length} rows`);

  // A page that yields 0 rows while the corpus is non-empty is a transient
  // error, not a real empty page. Mark it failed (not done) so a later run
  // re-fetches it instead of losing those docs.
  if (rows.length === 0 && search.totalRecords > 0) {
    log.warn(`Page ${page + 1}/${totalPages}: 0 rows — marked failed, will retry on re-run`);
    state.markPageFailed(page, '0 rows parsed (transient error page?)');
    return { downloaded: 0, processedAll: false };
  }

  // Persist list metadata first so the rows exist for the detail/download
  // state transitions that follow.
  state.addDocuments(rows);

  // Enrich each row with its full detail (the "Ver Ficha" sections) while this
  // page is still the current view — a stateful AJAX call, so it runs
  // sequentially, before the (possibly concurrent) downloads.
  if (adapter.fetchDetail && !opts.skipDetails) {
    for (const row of rows) {
      if (interrupted) break;
      try {
        state.setFichaDetail(row, await adapter.fetchDetail(session, row));
      } catch (err) {
        const msg = (err as Error).message;
        log.warn(`  detail ${downloadLabel(row)}: ${msg} — keeping list metadata`);
        state.markFichaFailed(row, msg);
      }
    }
  }

  let downloaded = 0;
  let processedAll = true;
  if (!opts.skipPdfs) {
    const concurrency = adapter.concurrentDownloads ? opts.concurrency : 1;
    if (concurrency > 1) {
      // Stateless downloads (no shared view), so no session recovery — just
      // retry each. Cap this page's batch to the remaining --max-docs budget;
      // across parallel workers it can still overshoot by up to one page (each
      // computed its budget before the others incremented), so --max-docs is a
      // soft cap under --page-concurrency.
      const batch = Number.isFinite(docBudget) ? rows.slice(0, Math.max(0, docBudget)) : rows;
      const done = await mapLimit(batch, concurrency, (row) =>
        downloadRow(session, adapter, row, state, opts, search.pageSize, false),
      );
      downloaded = done.filter(Boolean).length;
      if (interrupted || batch.length < rows.length) processedAll = false;
    } else {
      for (const row of rows) {
        if (interrupted || downloaded >= docBudget) {
          processedAll = false;
          break;
        }
        if (await downloadRow(session, adapter, row, state, opts, search.pageSize, true)) downloaded++;
      }
    }
  }

  if (!interrupted && processedAll) state.markPageCompleted(page, rows.length);
  return { downloaded, processedAll };
}

/** Construct a session with the site's HTTP client, wiring proxy rotation
 *  when a proxies file was given (direct otherwise). An optional shared rate
 *  limiter keeps several sessions at one global, polite request rate. */
function newSession(adapter: SiteAdapter, opts: ScraperOptions, limiter?: RateLimiter): JsfSession {
  const proxies = opts.proxiesFile ? ProxyPool.fromFile(opts.proxiesFile) : ProxyPool.empty();
  return new JsfSession(new HttpClient(adapter.baseUrl, opts.delayMs, proxies, limiter), adapter.pagePath);
}

/** Build, persist and print the validation report for an output directory. */
export function runReport(outDir: string, requiredFields: readonly string[] = []): void {
  const report = buildReport(outDir, new Date().toISOString(), requiredFields);
  writeAndPrintReport(outDir, report);
}

export async function retryFailed(adapter: SiteAdapter, opts: ScraperOptions): Promise<void> {
  const state = new StateStore(opts.outDir, adapter.name, { hasDetail: !!adapter.fetchDetail });
  if (state.failed.length === 0) {
    log.info('No failed downloads recorded — nothing to retry.');
    state.close();
    return;
  }

  state.startRun('retry-failed');
  let status: RunStatus = 'completed';
  try {
    status = await retryFailedDownloads(state, adapter, opts);
  } catch (err) {
    status = 'failed';
    throw err;
  } finally {
    finalizeRun(state, status);
  }
}

/**
 * Finalize a run resiliently: attempt every cleanup step even if an earlier one
 * throws, so a failure in one (e.g. a WAL checkpoint on a full disk) can't skip
 * the exports or leave the run stuck 'running'.
 */
function finalizeRun(state: StateStore, status: RunStatus): void {
  const step = (label: string, fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      log.error(`finalize: ${label} failed — ${(err as Error).message}`);
    }
  };
  step('save', () => state.save());
  step('finishRun', () => state.finishRun(status));
  step('exportArtifacts', () => state.exportArtifacts());
  step('close', () => state.close());
}

/** Re-process everything in the failed list (grouped by page to keep rows rendered). */
async function retryFailedDownloads(
  state: StateStore,
  adapter: SiteAdapter,
  opts: ScraperOptions,
): Promise<RunStatus> {
  const failed = state.failed;
  log.info(`Retrying ${failed.length} failed download(s)`);

  const session = newSession(adapter, opts);
  await session.init();
  const search = await adapter.search(session);
  state.totalRecords = search.totalRecords;

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

  const status: RunStatus = interrupted ? 'interrupted' : 'completed';
  summarize(state, status);
  return status;
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

  state.startDownload(row); // pending → in_progress
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

/** Print the end-of-run summary block (pages, documents, PDFs, outcome). */
function summarize(state: StateStore, status: RunStatus, totalPages?: number): void {
  const s = state.stats();
  const pages = totalPages ? `${s.pagesCompleted}/${totalPages}` : String(s.pagesCompleted);
  const line = '═'.repeat(44);
  log.info(line);
  log.info('  Run summary');
  log.info(`  Pages completed:  ${pages}`);
  log.info(`  Documents:        ${s.docsExtracted}`);
  log.info(`  PDFs:  OK ${s.pdfsDone}  ·  failed ${s.pdfsFailed}  ·  pending ${s.pending}`);
  log.info(`  Status:           ${status}`);
  log.info(line);
  if (s.pdfsFailed > 0) {
    log.warn(`  ${s.pdfsFailed} download(s) failed — run \`retry-failed\` to reprocess them.`);
  }
}
