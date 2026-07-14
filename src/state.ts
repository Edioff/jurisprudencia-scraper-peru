/**
 * Persistent run state: which pages are done, which PDFs are downloaded,
 * which downloads failed and why.
 *
 * Enables the two operational requirements of the challenge:
 *  - long runs can be interrupted and resumed without redoing work
 *  - failed downloads (e.g. persistent 429s) are recorded for `retry-failed`
 */

import * as path from 'path';
import { readJsonIfExists, toCsv, writeJsonAtomic, ensureDir } from './core/files';
import { DocumentRecord, FailedDownload, ScrapeState } from './types';
import * as fs from 'fs';

export class StateStore {
  private state: ScrapeState;
  private documents = new Map<string, DocumentRecord>();

  readonly stateFile: string;
  readonly documentsFile: string;
  readonly csvFile: string;
  readonly pdfDir: string;

  constructor(outDir: string, site: string) {
    this.stateFile = path.join(outDir, 'state.json');
    this.documentsFile = path.join(outDir, 'documents.json');
    this.csvFile = path.join(outDir, 'documents.csv');
    this.pdfDir = path.join(outDir, 'pdfs');
    ensureDir(this.pdfDir);

    const prior = readJsonIfExists<ScrapeState>(this.stateFile);
    this.state =
      prior && prior.site === site
        ? prior
        : {
            site,
            totalRecords: null,
            completedPages: [],
            downloaded: {},
            failed: [],
            updatedAt: new Date().toISOString(),
          };

    const priorDocs = readJsonIfExists<DocumentRecord[]>(this.documentsFile);
    if (prior && prior.site === site && priorDocs) {
      for (const doc of priorDocs) this.documents.set(docKey(doc), doc);
    }
  }

  get totalRecords(): number | null {
    return this.state.totalRecords;
  }

  set totalRecords(total: number | null) {
    this.state.totalRecords = total;
  }

  isPageCompleted(page: number): boolean {
    return this.state.completedPages.includes(page);
  }

  markPageCompleted(page: number): void {
    if (!this.isPageCompleted(page)) this.state.completedPages.push(page);
  }

  isDownloaded(uuid: string | null): boolean {
    return uuid !== null && uuid in this.state.downloaded;
  }

  recordDownload(doc: DocumentRecord, pdfFile: string): void {
    if (doc.uuid) this.state.downloaded[doc.uuid] = pdfFile;
    doc.pdfFile = pdfFile;
    this.documents.set(docKey(doc), doc);
    // A previously failed download that now succeeded leaves the failed list.
    this.state.failed = this.state.failed.filter((f) => f.uuid !== doc.uuid);
  }

  recordFailure(doc: DocumentRecord, attempts: number, lastError: string): void {
    this.state.failed = this.state.failed.filter((f) => f.uuid !== doc.uuid);
    this.state.failed.push({
      uuid: doc.uuid,
      rowIndex: doc.rowIndex,
      page: doc.page,
      fields: doc.fields,
      attempts,
      lastError,
      failedAt: new Date().toISOString(),
    });
  }

  get failed(): FailedDownload[] {
    return [...this.state.failed];
  }

  get downloadedCount(): number {
    return Object.keys(this.state.downloaded).length;
  }

  addDocuments(docs: DocumentRecord[]): void {
    for (const doc of docs) {
      const key = docKey(doc);
      const existing = this.documents.get(key);
      // Never lose an already-recorded pdfFile on re-scrape of the same page.
      if (existing?.pdfFile && !doc.pdfFile) doc.pdfFile = existing.pdfFile;
      this.documents.set(key, doc);
    }
  }

  get documentCount(): number {
    return this.documents.size;
  }

  /** Flush state + extracted data to disk (called after every page). */
  save(): void {
    this.state.updatedAt = new Date().toISOString();
    writeJsonAtomic(this.stateFile, this.state);

    const docs = [...this.documents.values()].sort((a, b) => a.rowIndex - b.rowIndex);
    writeJsonAtomic(this.documentsFile, docs);

    if (docs.length > 0) {
      const fieldNames = Object.keys(docs[0].fields);
      const headers = [...fieldNames, 'uuid', 'pdfFile'];
      const rows = docs.map((d) => ({
        ...d.fields,
        uuid: d.uuid ?? '',
        pdfFile: d.pdfFile ?? '',
      }));
      fs.writeFileSync(this.csvFile, toCsv(headers, rows), 'utf-8');
    }
  }
}

/**
 * Rows without a uuid still get an identity for deduplication. Row indexes
 * alone can shift if the result set changes between runs, so the key also
 * carries the row's identifying field.
 */
function docKey(doc: DocumentRecord): string {
  if (doc.uuid) return doc.uuid;
  const id = doc.fields.numeroExpediente ?? Object.values(doc.fields)[1] ?? '';
  return `row-${doc.rowIndex}-${id}`;
}
