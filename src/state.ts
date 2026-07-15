/**
 * Persistent run state, backed by SQLite (see `core/db.ts`).
 *
 * This is the operational layer the orchestrator talks to. It owns the item
 * state machines (a page and a document each move
 * `pending → in_progress → done | failed`) and the resume/retry queries built
 * on them, and it derives the human-facing exports (`documents.json`,
 * `documents.csv`, `state.json`) from the database on demand.
 *
 * It satisfies the two operational requirements of the challenge:
 *  - long runs can be interrupted and resumed without redoing completed work
 *  - failed downloads (e.g. persistent 429s) are recorded for `retry-failed`
 */

import * as fs from 'fs';
import * as path from 'path';
import { toCsv, writeJsonAtomic, writeTextAtomic } from './core/files';
import { log } from './core/logger';
import { Db, RunStatus } from './core/db';
import { DocumentRecord, FailedDownload, FichaDetail } from './types';

const DB_FILE = 'documents.db';

/** A snapshot of a run's progress. */
export interface RunStats {
  corpusTotal: number;
  pagesCompleted: number;
  docsExtracted: number;
  pdfsDone: number;
  pdfsFailed: number;
  /** PDFs still to download (corpusTotal - pdfsDone). */
  pending: number;
}

/** CSV column prefix for each ficha section, keeping same-named fields
 *  (e.g. "Tipo de Resolución" appears in two sections) from colliding. */
const SECTION_PREFIX: Record<keyof FichaDetail, string> = {
  resolucion: 'res',
  proceso: 'proc',
  procedencia: 'proce',
  extra: 'extra',
};

export class StateStore {
  private readonly db: Db;
  private readonly hasDetail: boolean;
  private readonly site: string;
  private currentRunId: number | null = null;

  readonly outDir: string;
  readonly pdfDir: string;

  constructor(outDir: string, site: string, opts: { hasDetail?: boolean } = {}) {
    this.outDir = outDir;
    this.pdfDir = path.join(outDir, 'pdfs');
    fs.mkdirSync(this.pdfDir, { recursive: true });
    this.hasDetail = opts.hasDetail ?? false;
    this.site = site;

    this.db = new Db(path.join(outDir, DB_FILE));
    // A database is tied to one site — refuse to mix another site's data into
    // the same output directory (which would corrupt the corpus counts).
    const existing = this.db.latestSite();
    if (existing && existing !== site) {
      this.db.close();
      throw new Error(
        `Output dir ${outDir} already holds data for site "${existing}"; ` +
          `use a separate --out directory for "${site}".`,
      );
    }
  }

  // --- run history ----------------------------------------------------------

  /** Open a new run (a `scrape` or `retry-failed` execution). */
  startRun(command: string): void {
    // Re-check the site guard at run time: the constructor's check passes when
    // the DB has no runs yet, so re-checking here narrows the window in which
    // two invocations could mix different sites into one output directory.
    const existing = this.db.latestSite();
    if (existing && existing !== this.site) {
      throw new Error(
        `Output dir ${this.outDir} already holds data for site "${existing}"; ` +
          `use a separate --out directory for "${this.site}".`,
      );
    }
    this.currentRunId = this.db.startRun(this.site, command, new Date().toISOString());
  }

  /** Close the current run, folding in the final counts. */
  finishRun(status: RunStatus): void {
    if (this.currentRunId === null) return;
    const s = this.stats();
    this.db.finishRun(this.currentRunId, new Date().toISOString(), {
      status,
      pagesDone: s.pagesCompleted,
      docsExtracted: s.docsExtracted,
      pdfsDone: s.pdfsDone,
      pdfsFailed: s.pdfsFailed,
      pending: s.pending,
    });
  }

  /** A live snapshot of the run's progress, for the end-of-run summary and
   *  the run record. `pending` is how many PDFs are still to download. */
  stats(): RunStats {
    const corpusTotal = this.totalRecords ?? 0;
    const pdfsDone = this.db.downloadedCount();
    return {
      corpusTotal,
      pagesCompleted: this.db.completedPages().length,
      docsExtracted: this.db.documentCount(),
      pdfsDone,
      pdfsFailed: this.db.failedDocs().length,
      pending: Math.max(0, corpusTotal - pdfsDone),
    };
  }

  get totalRecords(): number | null {
    return this.db.latestCorpusTotal();
  }

  set totalRecords(total: number | null) {
    if (total !== null && this.currentRunId !== null) {
      this.db.setRunCorpusTotal(this.currentRunId, total);
    }
  }

  // --- page state machine ---------------------------------------------------

  isPageCompleted(page: number): boolean {
    return this.db.getPageStatus(page) === 'done';
  }

  /** Mark a page as being worked on (bumps its attempt count). */
  startPage(page: number): void {
    this.db.setPageStatus(page, 'in_progress', { incAttempt: true });
  }

  markPageCompleted(page: number, rowCount?: number): void {
    this.db.setPageStatus(page, 'done', { rowCount });
  }

  markPageFailed(page: number, error: string): void {
    this.db.setPageStatus(page, 'failed', { error });
  }

  // --- document metadata + ficha --------------------------------------------

  /** doc_key -> page where this run first saw it, to surface duplicates live. */
  private seenThisRun = new Map<string, number>();

  /** Upsert each row's list metadata; persist any already-attached ficha. */
  addDocuments(docs: DocumentRecord[]): void {
    this.db.tx(() => {
      for (const doc of docs) {
        const key = docKey(doc);
        // The upsert quietly keeps the newest metadata (and preserves download
        // state), which is right for resumes — but the same key showing up on
        // TWO pages within one run means the site served a duplicate (or the
        // corpus shifted mid-run), and that should be visible as it happens,
        // not just inferable from the final counts.
        const firstPage = this.seenThisRun.get(key);
        if (firstPage !== undefined && firstPage !== doc.page) {
          log.warn(
            `Duplicate document ${key}: already seen on page ${firstPage + 1}, ` +
              `now again on page ${doc.page + 1} — keeping the newest metadata`,
          );
        }
        this.seenThisRun.set(key, doc.page);
        this.db.upsertDocument(doc, key, this.hasDetail);
        if (doc.detail) this.db.setDetail(key, doc.detail, 'done');
      }
    });
  }

  /** Store a document's fetched ficha detail (sections) as done. */
  setFichaDetail(doc: DocumentRecord, detail: FichaDetail): void {
    doc.detail = detail;
    this.db.setDetail(docKey(doc), detail, 'done');
  }

  /** Record that a document's ficha fetch failed (metadata is still kept). */
  markFichaFailed(doc: DocumentRecord, error: string): void {
    this.db.setFichaStatus(docKey(doc), 'failed', error);
  }

  // --- download state machine -----------------------------------------------

  isDownloaded(uuid: string | null): boolean {
    return uuid !== null && this.db.isDownloadedUuid(uuid);
  }

  /** Mark a document's PDF download as in progress. */
  startDownload(doc: DocumentRecord): void {
    this.db.setPdfStatus(docKey(doc), 'in_progress');
  }

  recordDownload(doc: DocumentRecord, pdfFile: string): void {
    doc.pdfFile = pdfFile;
    this.db.setPdfDone(docKey(doc), pdfFile);
  }

  recordFailure(doc: DocumentRecord, attempts: number, lastError: string): void {
    this.db.setPdfStatus(docKey(doc), 'failed', { attempts, error: lastError });
  }

  get failed(): FailedDownload[] {
    return this.db.failedDocs();
  }

  get downloadedCount(): number {
    return this.db.downloadedCount();
  }

  get documentCount(): number {
    return this.db.documentCount();
  }

  // --- persistence ----------------------------------------------------------

  /** Lightweight durability checkpoint, called after each page. Writes are
   *  already committed per statement; this just bounds WAL growth — so a
   *  failed checkpoint (disk full, transient I/O error) must not kill the
   *  run: warn and keep going, the next checkpoint will try again. */
  save(): void {
    try {
      this.db.checkpoint();
    } catch (err) {
      log.warn(`WAL checkpoint failed: ${(err as Error).message} — continuing`);
    }
  }

  close(): void {
    this.db.close();
  }

  /**
   * Derive the human-facing artifacts from the database:
   *  - documents.json : full records (list metadata + ficha sections)
   *  - documents.csv  : the same, flattened to columns
   *  - state.json     : resume/retry summary (pages, downloads, failures)
   */
  exportArtifacts(): { documents: number } {
    const docs = this.db.allDocuments();

    writeJsonAtomic(path.join(this.outDir, 'documents.json'), docs);

    if (docs.length > 0) {
      const flat = docs.map(flattenForCsv);
      const headers = unionKeys(flat);
      writeTextAtomic(path.join(this.outDir, 'documents.csv'), toCsv(headers, flat));
    }

    const state = {
      site: this.db.latestSite() ?? this.site,
      totalRecords: this.totalRecords,
      completedPages: this.db.completedPages(),
      downloaded: this.db.downloadedMap(),
      failed: this.db.failedDocs(),
      runs: this.db.allRuns(), // full execution history: when, outcome, counts
      updatedAt: new Date().toISOString(),
    };
    writeJsonAtomic(path.join(this.outDir, 'state.json'), state);

    return { documents: docs.length };
  }

  /** The site an output directory was scraped for, or null if none yet. */
  static siteOf(outDir: string): string | null {
    const dbFile = path.join(outDir, DB_FILE);
    if (!fs.existsSync(dbFile)) return null;
    const db = new Db(dbFile);
    try {
      return db.latestSite();
    } finally {
      db.close();
    }
  }
}

/** Flatten a document to a single CSV row: list fields + prefixed ficha
 *  sections + identity/columns for the PDF. */
function flattenForCsv(doc: DocumentRecord): Record<string, string> {
  const out: Record<string, string> = { ...doc.fields };
  if (doc.detail) {
    for (const section of Object.keys(SECTION_PREFIX) as Array<keyof FichaDetail>) {
      const prefix = SECTION_PREFIX[section];
      for (const [k, v] of Object.entries(doc.detail[section])) out[`${prefix}:${k}`] = v;
    }
  }
  out.uuid = doc.uuid ?? '';
  out.pdfFile = doc.pdfFile ?? '';
  return out;
}

/** Ordered union of all keys across rows (uuid + pdfFile pushed to the end). */
function unionKeys(rows: Array<Record<string, string>>): string[] {
  const keys = new Set<string>();
  for (const row of rows) for (const k of Object.keys(row)) keys.add(k);
  keys.delete('uuid');
  keys.delete('pdfFile');
  return [...keys, 'uuid', 'pdfFile'];
}

/**
 * A stable primary key for a document. uuid when present; otherwise a synthetic
 * key from a stable identifying field (so uuid-less rows still dedupe across
 * runs). rowIndex is deliberately NOT used when an identifier exists: it is
 * positional and shifts when the corpus gains/loses rows, which would orphan a
 * document's prior state. It is only the last-resort fallback.
 */
function docKey(doc: DocumentRecord): string {
  if (doc.uuid) return doc.uuid;
  const id = doc.fields.numeroExpediente ?? doc.fields.nroexp ?? Object.values(doc.fields)[1] ?? '';
  return id ? `id-${id}` : `row-${doc.rowIndex}`;
}
