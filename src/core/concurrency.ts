/**
 * Bounded-concurrency map: run `fn` over `items` with at most `limit` in
 * flight at once, preserving input order in the results. A simple worker
 * pool — no dependency needed for what the scraper uses it for (parallel
 * PDF downloads whose start rate is already capped by the HTTP client).
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = Math.max(1, Math.floor(limit));
  const results = new Array<R>(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(n, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
