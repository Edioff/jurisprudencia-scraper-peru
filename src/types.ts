/**
 * Shared domain types used across the scraper.
 */

/** One document row extracted from a results table. */
export interface DocumentRecord {
  /** Server-side document identifier used to request the PDF (may be missing if a row has no file). */
  uuid: string | null;
  /** Absolute row index in the full result set (0-based), as rendered by PrimeFaces (`data-ri`). */
  rowIndex: number;
  /** 0-based page this row belongs to. */
  page: number;
  /** Site-specific metadata columns, keyed by the adapter's column names. */
  fields: Record<string, string>;
  /** Full JSF client id of the per-row download button (e.g. `form:dt:37:j_idt63`). */
  downloadButtonId: string | null;
  /** Local file name of the downloaded PDF, set once the download succeeds. */
  pdfFile?: string;
}

/** A download that exhausted its retries; kept so it can be reprocessed later. */
export interface FailedDownload {
  uuid: string | null;
  rowIndex: number;
  page: number;
  fields: Record<string, string>;
  attempts: number;
  lastError: string;
  failedAt: string;
}

/** Persistent scraper state enabling resume + retry across runs. */
export interface ScrapeState {
  site: string;
  totalRecords: number | null;
  /** Pages fully processed (metadata extracted and downloads attempted). */
  completedPages: number[];
  /** uuid -> local pdf file name for every successful download. */
  downloaded: Record<string, string>;
  failed: FailedDownload[];
  updatedAt: string;
}

/** Result of parsing a JSF `<partial-response>` XML document. */
export interface PartialResponse {
  /** Fragment HTML keyed by the `<update id="...">` client id. */
  updates: Map<string, string>;
  /** New ViewState token, when the response carried one. */
  viewState: string | null;
  /** Populated when the server answered with `<error>` (e.g. ViewExpiredException). */
  error: string | null;
  /** Populated when the server asked the client to redirect (usually session loss). */
  redirectUrl: string | null;
}

/** Runtime options resolved from CLI flags + defaults. */
export interface ScraperOptions {
  site: string;
  outDir: string;
  /** Politeness delay between consecutive HTTP requests, in ms. */
  delayMs: number;
  /** Stop after this many result pages (0 = all). Useful for smoke tests. */
  maxPages: number;
  /** Stop after this many successful PDF downloads (0 = unlimited). */
  maxDocs: number;
  /** Extract metadata only, skip PDF downloads. */
  skipPdfs: boolean;
  /** Max attempts per download before recording it as failed. */
  maxAttempts: number;
  verbose: boolean;
}
