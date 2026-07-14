/**
 * Tiny in-memory cookie jar.
 *
 * These JSF sites only need the `JSESSIONID` session cookie, so a full
 * RFC 6265 implementation (tough-cookie) would be dead weight. We store
 * name=value pairs and echo them back on every request to the same host.
 */

export class CookieJar {
  private cookies = new Map<string, string>();

  /** Ingest `Set-Cookie` response headers. */
  store(setCookieHeaders: string[] | undefined): void {
    if (!setCookieHeaders) return;
    for (const header of setCookieHeaders) {
      const pair = header.split(';', 1)[0];
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      this.cookies.set(name, value);
    }
  }

  /** Value for the `Cookie` request header, or undefined when empty. */
  header(): string | undefined {
    if (this.cookies.size === 0) return undefined;
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  clear(): void {
    this.cookies.clear();
  }
}
