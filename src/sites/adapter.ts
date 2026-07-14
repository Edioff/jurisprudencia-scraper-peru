/**
 * Site adapter contract.
 *
 * The JSF mechanics (session + ViewState chaining, retry, the pagination
 * loop, resume, the record-and-continue download policy) live in the core
 * and orchestrator. Adapters own exactly what differs per site: how to run
 * the search, how to page, how a result row maps to metadata, and how to
 * fetch its PDF. That surface is small enough that adding a site is one
 * focused file — `oefa.ts` (PrimeFaces) and `pj.ts` (RichFaces) are the
 * two reference implementations, and they interact with their servers
 * quite differently despite sharing this contract.
 */

import { JsfSession } from '../core/jsf-session';
import { DocumentRecord } from '../types';

export interface SearchResult {
  totalRecords: number;
  pageSize: number;
  /** Rows rendered on the first page by the search itself. */
  firstPageRows: DocumentRecord[];
}

/** Raw PDF bytes plus the server-suggested file name, if any. */
export interface PdfDownload {
  bytes: Buffer;
  serverFileName: string | null;
}

export interface SiteAdapter {
  /** Short id used in CLI (`--site oefa`). */
  readonly name: string;
  /** Human description for logs/README. */
  readonly description: string;
  readonly baseUrl: string;
  /** Page the session GETs and POSTs against. */
  readonly pagePath: string;
  /**
   * Identity metadata fields that every document must have. The validation
   * report treats less-than-full coverage of these as a warning (a likely
   * parsing regression), while other fields may legitimately be sparse.
   */
  readonly requiredFields: readonly string[];

  /**
   * Whether a row's PDF download is safe to run concurrently within one
   * session. True only when the download is a self-contained request that
   * doesn't depend on mutable session/view state — e.g. PJ's stateless
   * `ServletDescarga?uuid=` GET. OEFA's download is a form POST that needs
   * the row rendered in the current view, so it stays sequential.
   */
  readonly concurrentDownloads: boolean;

  /**
   * Run the initial search that exposes the full result set
   * (for these repositories: submit the filter form empty).
   */
  search(session: JsfSession): Promise<SearchResult>;

  /** Fetch one result page's rows via the site's pagination mechanism. */
  fetchPage(session: JsfSession, pageIndex: number, pageSize: number): Promise<DocumentRecord[]>;

  /**
   * Fetch a row's PDF. The adapter owns the transport (a JSF form POST for
   * OEFA, a plain resource GET for PJ). The orchestrator handles retry,
   * validation and persistence around this call.
   */
  downloadPdf(session: JsfSession, row: DocumentRecord): Promise<PdfDownload>;

  /** Compose a descriptive local file name for a row's PDF. */
  pdfFileName(row: DocumentRecord, serverFileName: string | null): string;
}
