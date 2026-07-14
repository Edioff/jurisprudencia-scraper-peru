/**
 * HTTP client wrapper around axios.
 *
 * Responsibilities:
 *  - persistent session cookies (see CookieJar)
 *  - browser-like default headers
 *  - a global politeness delay between consecutive requests
 *  - manual redirect handling so `Set-Cookie` on 3xx hops is never lost
 *    (axios' auto-follow drops intermediate response headers)
 */

import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { CookieJar } from './cookie-jar';
import { sleep } from './retry';
import { log } from './logger';
import { ProxyPool } from './proxy';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const MAX_REDIRECTS = 5;

const ENTITY_HEADERS = ['content-type', 'content-length', 'transfer-encoding'];

function withoutEntityHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) return headers;
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !ENTITY_HEADERS.includes(name.toLowerCase())),
  );
}

export class HttpClient {
  private readonly axios: AxiosInstance;
  readonly jar = new CookieJar();
  private nextSlotAt = 0;
  private readonly secure: boolean;

  constructor(
    baseUrl: string,
    /** Minimum spacing between requests, in ms. */
    private readonly delayMs: number,
    /** Optional proxy rotation; defaults to going direct. */
    private readonly proxies: ProxyPool = ProxyPool.empty(),
  ) {
    this.secure = baseUrl.startsWith('https://');
    this.axios = axios.create({
      baseURL: baseUrl,
      timeout: 30_000,
      // We validate status ourselves so 3xx can be followed manually.
      maxRedirects: 0,
      validateStatus: () => true,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: '*/*',
        'Accept-Language': 'es-PE,es;q=0.9,en;q=0.8',
      },
    });
  }

  /**
   * Space request *starts* by at least `delayMs`, even when several requests
   * run concurrently. Each caller reserves the next time slot synchronously
   * (JS is single-threaded, so the read+write of `nextSlotAt` is atomic),
   * which serializes starts without serializing the in-flight requests.
   */
  private async politeWait(): Promise<void> {
    const now = Date.now();
    const startAt = Math.max(now, this.nextSlotAt);
    this.nextSlotAt = startAt + this.delayMs;
    const wait = startAt - now;
    if (wait > 0) await sleep(wait);
  }

  /**
   * Perform a request, following redirects manually (cookies captured on
   * every hop) and turning HTTP errors into axios-style thrown errors so
   * the retry layer can classify them.
   */
  private async request(config: AxiosRequestConfig): Promise<AxiosResponse<Buffer>> {
    await this.politeWait();

    // Rotate one proxy per logical request (kept across its redirect hops).
    // `false` disables axios' env-var proxy when we're going direct.
    const proxy = this.proxies.next() ?? false;

    let current: AxiosRequestConfig = { ...config, responseType: 'arraybuffer', proxy };
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const cookie = this.jar.header();
      current.headers = { ...current.headers, ...(cookie ? { Cookie: cookie } : {}) };

      const res = await this.axios.request<Buffer>(current);
      this.jar.store(res.headers['set-cookie']);

      if (res.status >= 300 && res.status < 400 && res.headers.location) {
        // Some of these sites sit behind a TLS-terminating proxy and emit
        // `http://` Location headers after an `https://` request. Following
        // them verbatim would downgrade (and often get blocked), so upgrade
        // the scheme back to match the request we made.
        let location = res.headers.location as string;
        if (this.secure && location.startsWith('http://')) {
          location = 'https://' + location.slice('http://'.length);
        }
        log.debug(`HTTP ${res.status} -> following redirect to ${location}`);
        // Redirects after a POST are followed as GET, per browser behavior;
        // entity headers describing the POST body must not carry over.
        current = {
          method: 'GET',
          url: location,
          headers: withoutEntityHeaders(config.headers as Record<string, string> | undefined),
          responseType: 'arraybuffer',
          timeout: current.timeout,
          proxy, // keep the same proxy across the redirect chain
        };
        continue;
      }

      // Reaching here with a 3xx means no Location header: malformed response.
      if (res.status >= 300) {
        throw new axios.AxiosError(
          `Request failed with status code ${res.status}`,
          String(res.status),
          undefined,
          undefined,
          res,
        );
      }
      return res;
    }
    throw new Error(`Too many redirects (> ${MAX_REDIRECTS}) for ${config.url}`);
  }

  async get(url: string, timeoutMs = 30_000): Promise<AxiosResponse<Buffer>> {
    return this.request({ method: 'GET', url, timeout: timeoutMs });
  }

  /**
   * POST a form (`application/x-www-form-urlencoded`).
   * `extraHeaders` lets the JSF layer add its `Faces-Request` marker.
   * Downloads use a longer timeout since PDFs on these sites reach 10+ MB.
   */
  async postForm(
    url: string,
    fields: Record<string, string>,
    extraHeaders: Record<string, string> = {},
    timeoutMs = 30_000,
  ): Promise<AxiosResponse<Buffer>> {
    const body = new URLSearchParams(fields).toString();
    return this.request({
      method: 'POST',
      url,
      data: body,
      timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        ...extraHeaders,
      },
    });
  }
}
