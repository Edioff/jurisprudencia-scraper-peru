/**
 * JSF / PrimeFaces session driver — the heart of the scraper.
 *
 * How these sites work (discovered by reverse-engineering the pages,
 * see README "How the site works"):
 *
 *  1. A GET to the entry page sets a `JSESSIONID` cookie and embeds a
 *     `javax.faces.ViewState` token in a hidden input. The token is the
 *     encrypted, client-side-saved component tree (~1.5 KB of base64).
 *  2. Every interaction (search, pagination) is an AJAX POST carrying that
 *     token plus `javax.faces.partial.*` parameters. The server answers
 *     with a `<partial-response>` XML document whose `<update>` nodes hold
 *     HTML fragments — including a fresh ViewState that MUST replace ours.
 *  3. File downloads are plain (non-AJAX) form POSTs that reply with the
 *     raw file stream. They do not rotate the ViewState, so the last one
 *     received keeps working afterwards.
 *  4. Row actions only exist while their row is rendered in the current
 *     view state: you must paginate to a page before "clicking" its rows.
 */

import { AxiosResponse } from 'axios';
import * as cheerio from 'cheerio';
import { HttpClient } from './http-client';
import { PartialResponse } from '../types';
import { log } from './logger';
import { DEFAULT_RETRY, withRetry } from './retry';

/** The server no longer recognizes our view/session; callers should re-init. */
export class SessionExpiredError extends Error {
  constructor(detail: string) {
    super(`JSF session/view expired: ${detail}`);
    this.name = 'SessionExpiredError';
  }
}

/** Regexes for the ViewState hidden input on full HTML pages. */
const VIEWSTATE_INPUT = /name="javax\.faces\.ViewState"[^>]*value="([^"]+)"/;

export class JsfSession {
  private viewState: string | null = null;
  private lastHtml = '';

  constructor(
    readonly http: HttpClient,
    /** Path the session GETs on init and POSTs to by default. */
    private readonly pagePath: string,
  ) {}

  /**
   * The most recent full HTML page the session loaded (init or postPage).
   * Adapters for classic JSF (RichFaces) harvest their form fields from it,
   * since those sites require the entire form to be resubmitted.
   */
  get pageHtml(): string {
    return this.lastHtml;
  }

  /**
   * GET the entry page and capture the initial ViewState.
   *
   * All session traffic (init + AJAX) is retried here with exponential
   * backoff, so 429/transient failures on navigation are absorbed at this
   * layer. Downloads are retried by the orchestrator instead, which owns
   * the record-failure-and-continue policy.
   */
  async init(): Promise<void> {
    this.http.jar.clear();
    this.viewState = null;
    const res = await withRetry(() => this.http.get(this.pagePath), {
      ...DEFAULT_RETRY,
      label: `GET ${this.pagePath}`,
    });
    const html = res.data.toString('utf-8');
    const match = html.match(VIEWSTATE_INPUT);
    if (!match) {
      throw new Error(
        `Could not find javax.faces.ViewState on ${this.pagePath} — page layout may have changed`,
      );
    }
    this.viewState = match[1];
    this.lastHtml = html;
    log.debug(`Session initialized (ViewState ${this.viewState.length} chars)`);
  }

  private requireViewState(): string {
    if (!this.viewState) throw new Error('Session not initialized — call init() first');
    return this.viewState;
  }

  /**
   * Send a JSF AJAX (partial) POST and parse the `<partial-response>`.
   * Rotates the stored ViewState when the response carries a new one.
   */
  async postAjax(fields: Record<string, string>): Promise<PartialResponse> {
    const res = await withRetry(
      () =>
        this.http.postForm(
          this.pagePath,
          { ...fields, 'javax.faces.ViewState': this.requireViewState() },
          {
            'Faces-Request': 'partial/ajax',
            'X-Requested-With': 'XMLHttpRequest',
          },
        ),
      { ...DEFAULT_RETRY, label: `AJAX ${fields['javax.faces.source'] ?? this.pagePath}` },
    );

    const xml = res.data.toString('utf-8');
    const parsed = parsePartialResponse(xml);

    if (parsed.error) throw new SessionExpiredError(parsed.error);
    if (parsed.redirectUrl) throw new SessionExpiredError(`redirected to ${parsed.redirectUrl}`);
    if (parsed.updates.size === 0 && !parsed.viewState) {
      throw new SessionExpiredError('empty partial-response (no updates, no ViewState)');
    }

    if (parsed.viewState) this.viewState = parsed.viewState;
    return parsed;
  }

  /**
   * Send a full (non-AJAX) form POST — used for file downloads.
   * Returns the raw response so callers can inspect headers and bytes.
   */
  async postDownload(
    fields: Record<string, string>,
    timeoutMs = 180_000,
  ): Promise<AxiosResponse<Buffer>> {
    return this.http.postForm(
      this.pagePath,
      { ...fields, 'javax.faces.ViewState': this.requireViewState() },
      {},
      timeoutMs,
    );
  }

  /**
   * Full-form POST that returns a whole HTML page rather than a partial
   * response — the interaction model of classic (non-AJAX) JSF like the
   * RichFaces PJ site, where search and pagination navigate the page and
   * the server answers via a redirect. Rotates the ViewState from the
   * returned HTML. Retried with backoff like the AJAX path.
   */
  async postPage(
    fields: Record<string, string>,
    label: string,
    targetPath = this.pagePath,
  ): Promise<string> {
    const res = await withRetry(
      () =>
        this.http.postForm(targetPath, {
          ...fields,
          'javax.faces.ViewState': this.requireViewState(),
        }),
      { ...DEFAULT_RETRY, label },
    );
    const html = res.data.toString('utf-8');
    const match = html.match(VIEWSTATE_INPUT);
    if (!match) {
      throw new SessionExpiredError(`no ViewState in response to ${label} (session likely lost)`);
    }
    this.viewState = match[1];
    this.lastHtml = html;
    return html;
  }

  /** Retried GET returning the raw bytes — used by adapters whose file
   *  downloads are plain resource URLs (e.g. PJ's ServletDescarga). */
  async get(path: string, timeoutMs = 180_000): Promise<AxiosResponse<Buffer>> {
    return withRetry(() => this.http.get(path, timeoutMs), {
      ...DEFAULT_RETRY,
      label: `GET ${path}`,
    });
  }
}

/**
 * Parse a `<partial-response>` XML document.
 *
 * Uses cheerio in XML mode rather than regex: JSF escapes literal `]]>`
 * inside fragments by splitting the CDATA section, which a naive regex
 * would truncate. htmlparser2 reassembles those sections correctly.
 */
export function parsePartialResponse(xml: string): PartialResponse {
  const out: PartialResponse = { updates: new Map(), viewState: null, error: null, redirectUrl: null };

  if (!xml.includes('<partial-response')) {
    // Full HTML instead of XML usually means a login/error page: session gone.
    out.error = 'response is not a partial-response document';
    return out;
  }

  const $ = cheerio.load(xml, { xmlMode: true });

  $('partial-response > changes > update').each((_i, el) => {
    const id = $(el).attr('id') ?? '';
    const content = $(el).text();
    if (/ViewState/i.test(id)) {
      out.viewState = content;
    } else {
      out.updates.set(id, content);
    }
  });

  const errorName = $('partial-response > error > error-name').text();
  const errorMessage = $('partial-response > error > error-message').text();
  if (errorName || errorMessage) out.error = `${errorName} ${errorMessage}`.trim();

  const redirect = $('partial-response > redirect').attr('url');
  if (redirect) out.redirectUrl = redirect;

  return out;
}
