/**
 * Site adapter contract.
 *
 * The JSF mechanics (ViewState chaining, partial-response parsing, retry,
 * pagination loop, download plumbing) are identical across these government
 * sites — what changes per site are form/component ids, result columns and
 * download parameters. Adapters own exactly that surface, so adding a new
 * site means writing one focused file (see `oefa.ts`).
 */

import { JsfSession } from '../core/jsf-session';
import { DocumentRecord } from '../types';

export interface SearchResult {
  totalRecords: number;
  pageSize: number;
  /** Rows rendered on the first page by the search itself. */
  firstPageRows: DocumentRecord[];
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
   * Run the initial search that exposes the full result set
   * (for these repositories: submit the filter form empty).
   */
  search(session: JsfSession): Promise<SearchResult>;

  /** Fetch one result page via the table's AJAX pagination. */
  fetchPage(session: JsfSession, pageIndex: number, pageSize: number): Promise<DocumentRecord[]>;

  /**
   * Form fields (minus ViewState, which the session injects) that emulate
   * clicking the row's download link. Only valid while the row's page is
   * the one currently rendered in the view state.
   */
  buildDownloadFields(row: DocumentRecord): Record<string, string>;

  /** Compose a descriptive local file name for a row's PDF. */
  pdfFileName(row: DocumentRecord, serverFileName: string | null): string;
}
