/**
 * Minimal timestamped console logger with levels.
 * Deliberately dependency-free: the scraper only needs progress visibility,
 * not a full logging framework.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m', // gray
  info: '\x1b[36m', // cyan
  warn: '\x1b[33m', // yellow
  error: '\x1b[31m', // red
};
const RESET = '\x1b[0m';

let minLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

function write(level: LogLevel, message: string): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const ts = new Date().toISOString();
  const line = `${COLORS[level]}[${ts}] [${level.toUpperCase().padEnd(5)}]${RESET} ${message}`;
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const log = {
  debug: (msg: string) => write('debug', msg),
  info: (msg: string) => write('info', msg),
  warn: (msg: string) => write('warn', msg),
  error: (msg: string) => write('error', msg),
};
