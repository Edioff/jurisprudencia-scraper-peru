/**
 * Retry with exponential backoff + jitter, aware of HTTP 429 semantics.
 *
 * Backoff schedule (defaults): 1s, 2s, 4s, 8s, 16s (+/- 20% jitter), capped at 60s.
 * When the server sends a `Retry-After` header (seconds or HTTP date) we honor it,
 * still capped so a hostile/buggy header can't stall the scraper for hours.
 */

import { AxiosError } from 'axios';
import { log } from './logger';

export interface RetryOptions {
  /** Total attempts including the first one. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Human-readable label for log lines. */
  label: string;
}

export const DEFAULT_RETRY: Omit<RetryOptions, 'label'> = {
  maxAttempts: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
};

export class RetriesExhaustedError extends Error {
  constructor(
    label: string,
    /** Attempts actually made (1 for a non-retryable failure). */
    public readonly attempts: number,
    public readonly lastError: unknown,
  ) {
    super(`${label}: giving up after ${attempts} attempt(s) (${describeError(lastError)})`);
    this.name = 'RetriesExhaustedError';
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Extract an HTTP status code from an axios error, if any. */
export function statusOf(err: unknown): number | null {
  if (err instanceof AxiosError && err.response) return err.response.status;
  return null;
}

export function describeError(err: unknown): string {
  const status = statusOf(err);
  if (status !== null) return `HTTP ${status}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** 429 + transient server/network failures are worth retrying; 4xx generally are not. */
export function isRetryable(err: unknown): boolean {
  const status = statusOf(err);
  if (status !== null) {
    return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
  }
  if (err instanceof AxiosError) {
    // No response at all: DNS failure, reset, timeout... all transient by nature.
    return true;
  }
  return false;
}

/** Parse a Retry-After header (delta-seconds or HTTP date) into milliseconds. */
export function parseRetryAfterMs(err: unknown): number | null {
  if (!(err instanceof AxiosError) || !err.response) return null;
  const raw = err.response.headers?.['retry-after'];
  if (raw === undefined || raw === null || raw === '') return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(String(raw));
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

function backoffDelayMs(attempt: number, opts: RetryOptions): number {
  const exponential = opts.baseDelayMs * 2 ** (attempt - 1);
  const jitter = 1 + (Math.random() * 0.4 - 0.2); // +/- 20%
  return Math.min(Math.round(exponential * jitter), opts.maxDelayMs);
}

/**
 * Run `fn`, retrying retryable failures with exponential backoff.
 * Throws `RetriesExhaustedError` once attempts run out so callers can
 * record the document and move on (challenge requirement).
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  let lastError: unknown;
  let attemptsMade = 0;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    attemptsMade = attempt;
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt === opts.maxAttempts) break;

      // Retry-After is defined for 429 and 503 (RFC 9110); honor it whenever
      // a retryable response carries it.
      const retryAfter = parseRetryAfterMs(err);
      const delay =
        retryAfter !== null
          ? Math.min(retryAfter, opts.maxDelayMs)
          : backoffDelayMs(attempt, opts);
      log.warn(
        `${opts.label}: ${describeError(err)} — attempt ${attempt}/${opts.maxAttempts} failed, retrying in ${Math.round(delay / 1000)}s` +
          (retryAfter !== null ? ' (Retry-After)' : ''),
      );
      await sleep(delay);
    }
  }
  throw new RetriesExhaustedError(opts.label, attemptsMade, lastError);
}
