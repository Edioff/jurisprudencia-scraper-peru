/**
 * SQLite persistence — the run's single source of truth.
 *
 * For a corpus of hundreds of thousands of documents, a keep-everything-in-memory
 * + rewrite-the-whole-JSON-every-page approach doesn't scale: it re-serializes
 * the entire result set on each page and can't be queried. A tiny embedded
 * database is the honest fit. Three tables model the work exactly:
 *
 *   documents  — one row per document (metadata + the ficha's three sections),
 *                each carrying its own PDF/ficha lifecycle state.
 *   pages      — the pagination state machine (which pages are done/failed).
 *   runs       — one row per execution: when it started/finished, with what
 *                outcome, how many documents came out and how many are pending.
 *
 * Every item moves through an explicit state machine
 * (`pending → in_progress → done | failed`), which is what makes resume precise:
 * on restart we redo exactly what is not `done`, and a crash mid-item leaves it
 * `in_progress` so it is retried rather than silently skipped.
 *
 * `documents.json` / `.csv` / `state.json` are *exports* derived from here.
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import { ensureDir } from './files';
import { DocumentRecord, FailedDownload, FichaDetail, ItemStatus } from '../types';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  run_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  site           TEXT NOT NULL,
  command        TEXT NOT NULL,          -- 'scrape' | 'retry-failed'
  started_at     TEXT NOT NULL,
  finished_at    TEXT,                   -- null while the run is in progress
  status         TEXT NOT NULL DEFAULT 'running'
                 CHECK (status IN ('running','completed','interrupted','failed')),
  corpus_total   INTEGER,                -- documents the site reports for the query
  pages_done     INTEGER,                -- snapshot taken when the run ends
  docs_extracted INTEGER,
  pdfs_done      INTEGER,
  pdfs_failed    INTEGER,
  pending        INTEGER                 -- corpus_total - pdfs_done (still to download)
);

CREATE TABLE IF NOT EXISTS pages (
  page       INTEGER PRIMARY KEY,
  status     TEXT NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending','in_progress','done','failed')),
  row_count  INTEGER,
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS documents (
  doc_key      TEXT PRIMARY KEY,          -- uuid, or a synthetic key for rows without one
  uuid         TEXT,
  page         INTEGER NOT NULL,
  row_index    INTEGER NOT NULL,
  recurso      TEXT,                       -- promoted identity fields, for readable queries
  nro_exp      TEXT,
  list_data    TEXT NOT NULL DEFAULT '{}', -- JSON: the results-list metadata
  resolucion   TEXT NOT NULL DEFAULT '{}', -- JSON: DATOS DE LA RESOLUCIÓN
  proceso      TEXT NOT NULL DEFAULT '{}', -- JSON: DATOS DEL PROCESO
  procedencia  TEXT NOT NULL DEFAULT '{}', -- JSON: DATOS DE PROCEDENCIA
  extra        TEXT NOT NULL DEFAULT '{}', -- JSON: label/value pairs outside those sections
  pdf_file     TEXT,
  pdf_status   TEXT NOT NULL DEFAULT 'pending'
               CHECK (pdf_status IN ('pending','in_progress','done','failed')),
  ficha_status TEXT NOT NULL DEFAULT 'pending'
               CHECK (ficha_status IN ('pending','in_progress','done','failed','na')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  updated_at   TEXT
);

-- Indexes for the hot lookups: resume/dedup by uuid, and status/page filters
-- used by retry, the report and progress queries. They matter at 200k rows.
CREATE INDEX IF NOT EXISTS idx_documents_uuid         ON documents(uuid);
CREATE INDEX IF NOT EXISTS idx_documents_pdf_status   ON documents(pdf_status);
CREATE INDEX IF NOT EXISTS idx_documents_ficha_status ON documents(ficha_status);
CREATE INDEX IF NOT EXISTS idx_documents_page         ON documents(page);
`;

const EMPTY_DETAIL: FichaDetail = { resolucion: {}, proceso: {}, procedencia: {}, extra: {} };

/** Terminal outcome of a run. */
export type RunStatus = 'running' | 'completed' | 'interrupted' | 'failed';

/** A single execution's record, as stored in the `runs` table. */
export interface RunRecord {
  runId: number;
  site: string;
  command: string;
  startedAt: string;
  finishedAt: string | null;
  status: RunStatus;
  corpusTotal: number | null;
  pagesDone: number | null;
  docsExtracted: number | null;
  pdfsDone: number | null;
  pdfsFailed: number | null;
  pending: number | null;
}

/** The counts folded into a run when it finishes. */
export interface RunTotals {
  status: RunStatus;
  pagesDone: number;
  docsExtracted: number;
  pdfsDone: number;
  pdfsFailed: number;
  pending: number;
}

/** A document as reconstructed from the database (for export / retry). */
interface DbDocRow {
  doc_key: string;
  uuid: string | null;
  page: number;
  row_index: number;
  recurso: string | null;
  nro_exp: string | null;
  list_data: string;
  resolucion: string;
  proceso: string;
  procedencia: string;
  extra: string;
  pdf_file: string | null;
  pdf_status: ItemStatus;
  ficha_status: ItemStatus;
  attempts: number;
  last_error: string | null;
  updated_at: string | null;
}

export class Db {
  private readonly db: Database.Database;
  readonly file: string;

  constructor(dbFile: string) {
    this.file = dbFile;
    ensureDir(path.dirname(dbFile));
    this.db = new Database(dbFile);
    // WAL keeps writes durable and cheap under the per-page save cadence;
    // NORMAL sync is the standard, crash-safe pairing with WAL.
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** Fold the WAL back into the main database file to bound its growth on
   *  long runs. Cheap and non-blocking (PASSIVE). */
  checkpoint(): void {
    this.db.pragma('wal_checkpoint(PASSIVE)');
  }

  /** Run `fn` inside a single transaction (all-or-nothing). */
  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  private now(): string {
    return new Date().toISOString();
  }

  // --- runs (execution history) ---------------------------------------------

  /** Open a new run row and return its id. */
  startRun(site: string, command: string, startedAt: string): number {
    const info = this.db
      .prepare(`INSERT INTO runs (site, command, started_at, status) VALUES (?, ?, ?, 'running')`)
      .run(site, command, startedAt);
    return Number(info.lastInsertRowid);
  }

  /** Record the corpus size against a run as soon as the search reveals it. */
  setRunCorpusTotal(runId: number, corpusTotal: number): void {
    this.db.prepare('UPDATE runs SET corpus_total = ? WHERE run_id = ?').run(corpusTotal, runId);
  }

  /** Close a run with its outcome and the final counts. */
  finishRun(runId: number, finishedAt: string, totals: RunTotals): void {
    this.db
      .prepare(
        `UPDATE runs SET
           finished_at    = @finishedAt,
           status         = @status,
           pages_done     = @pagesDone,
           docs_extracted = @docsExtracted,
           pdfs_done      = @pdfsDone,
           pdfs_failed    = @pdfsFailed,
           pending        = @pending
         WHERE run_id = @runId`,
      )
      .run({ runId, finishedAt, ...totals });
  }

  /** The site this database holds data for (from the most recent run). */
  latestSite(): string | null {
    const row = this.db.prepare('SELECT site FROM runs ORDER BY run_id DESC LIMIT 1').get() as
      | { site: string }
      | undefined;
    return row ? row.site : null;
  }

  /** The corpus total most recently observed (stable across runs of a site). */
  latestCorpusTotal(): number | null {
    const row = this.db
      .prepare('SELECT corpus_total FROM runs WHERE corpus_total IS NOT NULL ORDER BY run_id DESC LIMIT 1')
      .get() as { corpus_total: number } | undefined;
    return row ? row.corpus_total : null;
  }

  /** The full run history, oldest first (for the state.json export). */
  allRuns(): RunRecord[] {
    const rows = this.db.prepare('SELECT * FROM runs ORDER BY run_id').all() as Array<
      Record<string, unknown>
    >;
    return rows.map((r) => ({
      runId: r.run_id as number,
      site: r.site as string,
      command: r.command as string,
      startedAt: r.started_at as string,
      finishedAt: (r.finished_at as string) ?? null,
      status: r.status as RunStatus,
      corpusTotal: (r.corpus_total as number) ?? null,
      pagesDone: (r.pages_done as number) ?? null,
      docsExtracted: (r.docs_extracted as number) ?? null,
      pdfsDone: (r.pdfs_done as number) ?? null,
      pdfsFailed: (r.pdfs_failed as number) ?? null,
      pending: (r.pending as number) ?? null,
    }));
  }

  // --- pages ----------------------------------------------------------------

  getPageStatus(page: number): ItemStatus | null {
    const row = this.db.prepare('SELECT status FROM pages WHERE page = ?').get(page) as
      | { status: ItemStatus }
      | undefined;
    return row ? row.status : null;
  }

  /**
   * Move a page to `status`, upserting the row. `rowCount` records how many
   * rows the page yielded; `incAttempt` bumps the attempt counter (used when
   * (re)starting a page); `error` stores the last failure reason.
   */
  setPageStatus(
    page: number,
    status: Exclude<ItemStatus, 'na'>,
    opts: { rowCount?: number; incAttempt?: boolean; error?: string | null } = {},
  ): void {
    this.db
      .prepare(
        `INSERT INTO pages (page, status, row_count, attempts, last_error, updated_at)
         VALUES (@page, @status, @rowCount, @attempts0, @error, @now)
         ON CONFLICT(page) DO UPDATE SET
           status     = @status,
           row_count  = COALESCE(@rowCount, pages.row_count),
           attempts   = pages.attempts + @attemptInc,
           last_error = @error,
           updated_at = @now`,
      )
      .run({
        page,
        status,
        rowCount: opts.rowCount ?? null,
        attempts0: opts.incAttempt ? 1 : 0,
        attemptInc: opts.incAttempt ? 1 : 0,
        error: opts.error ?? null,
        now: this.now(),
      });
  }

  completedPages(): number[] {
    const rows = this.db
      .prepare(`SELECT page FROM pages WHERE status = 'done' ORDER BY page`)
      .all() as Array<{ page: number }>;
    return rows.map((r) => r.page);
  }

  pageStatusCounts(): Record<string, number> {
    return this.countBy('pages', 'status');
  }

  // --- documents ------------------------------------------------------------

  /**
   * Insert or refresh a document's list metadata. On conflict, only the
   * metadata columns are updated — the PDF and ficha lifecycle columns are
   * left untouched, so re-scraping a page never loses a recorded download or
   * a previously fetched ficha.
   */
  upsertDocument(doc: DocumentRecord, docKey: string, fichaCapable: boolean): void {
    this.db
      .prepare(
        `INSERT INTO documents
           (doc_key, uuid, page, row_index, recurso, nro_exp, list_data, ficha_status, updated_at)
         VALUES
           (@doc_key, @uuid, @page, @row_index, @recurso, @nro_exp, @list_data, @ficha_status, @now)
         ON CONFLICT(doc_key) DO UPDATE SET
           uuid       = excluded.uuid,
           page       = excluded.page,
           row_index  = excluded.row_index,
           recurso    = excluded.recurso,
           nro_exp    = excluded.nro_exp,
           list_data  = excluded.list_data,
           updated_at = excluded.updated_at`,
      )
      .run({
        doc_key: docKey,
        uuid: doc.uuid,
        page: doc.page,
        row_index: doc.rowIndex,
        recurso: doc.fields.recurso ?? null,
        nro_exp: doc.fields.nroexp ?? doc.fields.numeroExpediente ?? null,
        list_data: JSON.stringify(doc.fields),
        ficha_status: fichaCapable ? 'pending' : 'na',
        now: this.now(),
      });
  }

  /** Persist a document's ficha sections and mark its ficha lifecycle state. */
  setDetail(docKey: string, detail: FichaDetail, status: Exclude<ItemStatus, 'na'>): void {
    this.db
      .prepare(
        `UPDATE documents SET
           resolucion   = @resolucion,
           proceso      = @proceso,
           procedencia  = @procedencia,
           extra        = @extra,
           ficha_status = @status,
           updated_at   = @now
         WHERE doc_key = @doc_key`,
      )
      .run({
        doc_key: docKey,
        resolucion: JSON.stringify(detail.resolucion),
        proceso: JSON.stringify(detail.proceso),
        procedencia: JSON.stringify(detail.procedencia),
        extra: JSON.stringify(detail.extra),
        status,
        now: this.now(),
      });
  }

  /** Mark a ficha fetch as failed without discarding any prior partial data. */
  setFichaStatus(docKey: string, status: Exclude<ItemStatus, 'na'>, error?: string): void {
    this.db
      .prepare(`UPDATE documents SET ficha_status = ?, last_error = COALESCE(?, last_error), updated_at = ? WHERE doc_key = ?`)
      .run(status, error ?? null, this.now(), docKey);
  }

  /** Record a successful PDF download. */
  setPdfDone(docKey: string, pdfFile: string): void {
    this.db
      .prepare(
        `UPDATE documents SET pdf_file = ?, pdf_status = 'done', last_error = NULL, updated_at = ? WHERE doc_key = ?`,
      )
      .run(pdfFile, this.now(), docKey);
  }

  /** Update a PDF's lifecycle state (in_progress on start, failed on give-up). */
  setPdfStatus(
    docKey: string,
    status: Exclude<ItemStatus, 'na'>,
    opts: { attempts?: number; error?: string | null } = {},
  ): void {
    this.db
      .prepare(
        // COALESCE keeps a prior failure reason when a retry moves the row back
        // to in_progress with no new error (matches setFichaStatus). A success
        // clears it explicitly via setPdfDone.
        `UPDATE documents SET
           pdf_status = @status,
           attempts   = COALESCE(@attempts, attempts),
           last_error = COALESCE(@error, last_error),
           updated_at = @now
         WHERE doc_key = @doc_key`,
      )
      .run({
        doc_key: docKey,
        status,
        attempts: opts.attempts ?? null,
        error: opts.error ?? null,
        now: this.now(),
      });
  }

  isDownloadedUuid(uuid: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM documents WHERE uuid = ? AND pdf_status = 'done' LIMIT 1`)
      .get(uuid);
    return row !== undefined;
  }

  /** uuid → pdf file name, for every completed download that has a uuid. */
  downloadedMap(): Record<string, string> {
    const rows = this.db
      .prepare(
        `SELECT uuid, pdf_file FROM documents WHERE pdf_status = 'done' AND uuid IS NOT NULL AND pdf_file IS NOT NULL`,
      )
      .all() as Array<{ uuid: string; pdf_file: string }>;
    const out: Record<string, string> = {};
    for (const r of rows) out[r.uuid] = r.pdf_file;
    return out;
  }

  downloadedCount(): number {
    return this.scalar(`SELECT COUNT(*) AS n FROM documents WHERE pdf_status = 'done'`);
  }

  documentCount(): number {
    return this.scalar('SELECT COUNT(*) AS n FROM documents');
  }

  docStatusCounts(): Record<string, number> {
    return this.countBy('documents', 'pdf_status');
  }

  /** Documents whose download exhausted its retries, as retry/report input. */
  failedDocs(): FailedDownload[] {
    const rows = this.db
      .prepare(`SELECT * FROM documents WHERE pdf_status = 'failed' ORDER BY row_index`)
      .all() as DbDocRow[];
    return rows.map((r) => ({
      uuid: r.uuid,
      rowIndex: r.row_index,
      page: r.page,
      fields: safeParse(r.list_data),
      attempts: r.attempts,
      lastError: r.last_error ?? '',
      failedAt: r.updated_at ?? '',
    }));
  }

  /** Every document, reconstructed as domain records (for export). */
  allDocuments(): DocumentRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM documents ORDER BY row_index')
      .all() as DbDocRow[];
    return rows.map((r) => ({
      uuid: r.uuid,
      rowIndex: r.row_index,
      page: r.page,
      fields: safeParse(r.list_data),
      detail:
        r.ficha_status === 'na'
          ? undefined
          : {
              resolucion: safeParse(r.resolucion),
              proceso: safeParse(r.proceso),
              procedencia: safeParse(r.procedencia),
              extra: safeParse(r.extra),
            },
      downloadButtonId: null,
      pdfFile: r.pdf_file ?? undefined,
    }));
  }

  // --- helpers --------------------------------------------------------------

  private scalar(sql: string): number {
    const row = this.db.prepare(sql).get() as { n: number };
    return row.n;
  }

  private countBy(table: string, column: string): Record<string, number> {
    const rows = this.db
      .prepare(`SELECT ${column} AS k, COUNT(*) AS n FROM ${table} GROUP BY ${column}`)
      .all() as Array<{ k: string; n: number }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.k] = r.n;
    return out;
  }
}

export { EMPTY_DETAIL };

function safeParse(json: string): Record<string, string> {
  try {
    return JSON.parse(json) as Record<string, string>;
  } catch {
    return {};
  }
}
