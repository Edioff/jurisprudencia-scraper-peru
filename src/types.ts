/**
 * Shared domain types used across the scraper.
 */

/**
 * The per-item lifecycle state persisted in SQLite, enabling precise resume:
 *  - `pending`     — discovered but not yet processed
 *  - `in_progress` — processing started (a crash leaves it here → retried)
 *  - `done`        — completed successfully
 *  - `failed`      — retries exhausted (kept for `retry-failed`)
 *  - `na`          — not applicable (e.g. ficha status for a site with no modal)
 */
export type ItemStatus = 'pending' | 'in_progress' | 'done' | 'failed' | 'na';

/**
 * A document's "Ver Ficha" detail, grouped by the modal's three sections
 * exactly as the site presents them. Each bucket holds `label → value` pairs;
 * `extra` catches anything rendered outside the three known sections, so no
 * field is ever dropped even if a document's modal has an unexpected shape.
 */
export interface FichaDetail {
  /** DATOS DE LA RESOLUCIÓN (judges, ponente, fallo, sumilla, keywords…). */
  resolucion: Record<string, string>;
  /** DATOS DEL PROCESO (chamber, judicial district, matter, procedural regime…). */
  proceso: Record<string, string>;
  /** DATOS DE PROCEDENCIA (origin case history: filing/qualification/origin dates…). */
  procedencia: Record<string, string>;
  /** Label/value pairs found outside the three known sections (usually empty). */
  extra: Record<string, string>;
}

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
  /**
   * Full per-document detail from the "Ver Ficha" modal, grouped by section.
   * Present only for sites that expose a detail view (PJ); absent for sites
   * whose results list is already complete (OEFA).
   */
  detail?: FichaDetail;
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
  /** Skip the per-document detail (ficha) fetch, keeping only list metadata. */
  skipDetails: boolean;
  /** Max attempts per download before recording it as failed. */
  maxAttempts: number;
  /** Max concurrent PDF downloads (only applied when the adapter allows it). */
  concurrency: number;
  /**
   * Number of independent JSF sessions paginating in parallel (default 1).
   * Pagination can't be parallelized within one session (the ViewState mutates
   * per navigation), so >1 spins up that many sessions, each taking a stripe of
   * pages. They share one rate limiter, so the global request rate stays polite.
   */
  pageConcurrency: number;
  /** Optional file of proxy URLs to rotate through (empty = direct). */
  proxiesFile: string;
  verbose: boolean;
}
