/**
 * CLI entry point.
 *
 *   npm run scrape                      # full scrape with defaults (site: oefa)
 *   npm run scrape -- --max-pages 3     # smoke test: first 3 pages only
 *   npm run scrape -- --skip-pdfs       # metadata only, no downloads
 *   npm run retry-failed                # reprocess downloads that exhausted retries
 *
 * Flags: --site <name> --out <dir> --delay <ms> --max-pages <n> --max-docs <n>
 *        --attempts <n> --skip-pdfs --verbose
 */

import { join } from 'path';
import { log, setLogLevel } from './core/logger';
import { readJsonIfExists } from './core/files';
import { runScrape, retryFailed, runReport } from './scraper';
import { getAdapter, listAdapters } from './sites';
import { ScraperOptions } from './types';

const USAGE = `
Usage: npm run scrape -- [flags] | npm run retry-failed -- [flags] | npm run report -- [flags]

Commands:
  scrape          Extract all documents and download their PDFs
  retry-failed    Reprocess downloads recorded as failed in state.json
  report          Validate an existing output directory (sanity-check report)

Flags:
  --site <name>    Site adapter to use (default: oefa). Available: ${listAdapters()
    .map((a) => a.name)
    .join(', ')}
  --out <dir>      Output directory (default: ./output)
  --delay <ms>     Politeness delay between request starts (default: 600)
  --max-pages <n>  Process at most n result pages this run (default: all)
  --max-docs <n>   Download at most n PDFs this run (default: unlimited)
  --attempts <n>   Max attempts per download before recording failure (default: 5)
  --concurrency <n> Parallel PDF downloads, where the site allows it (default: 1)
  --proxies <file> Rotate through proxy URLs listed in <file>, one per line (default: direct)
  --skip-details   Skip the per-document detail (ficha) fetch, keep list metadata only
  --skip-pdfs      Extract metadata only, skip PDF downloads
  --verbose        Debug logging
`;

function parseArgs(argv: string[]): { command: string; opts: ScraperOptions } {
  const [command, ...rest] = argv;
  const opts: ScraperOptions = {
    site: 'oefa',
    outDir: 'output',
    delayMs: 600,
    maxPages: 0,
    maxDocs: 0,
    skipPdfs: false,
    maxAttempts: 5,
    concurrency: 1,
    proxiesFile: '',
    skipDetails: false,
    verbose: false,
  };

  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const next = (): string => {
      const value = rest[++i];
      if (value === undefined) throw new Error(`Missing value for ${flag}`);
      return value;
    };
    switch (flag) {
      case '--site':
        opts.site = next();
        break;
      case '--out':
        opts.outDir = next();
        break;
      case '--delay':
        opts.delayMs = parsePositiveInt(flag, next());
        break;
      case '--max-pages':
        opts.maxPages = parsePositiveInt(flag, next());
        break;
      case '--max-docs':
        opts.maxDocs = parsePositiveInt(flag, next());
        break;
      case '--attempts':
        opts.maxAttempts = Math.max(1, parsePositiveInt(flag, next()));
        break;
      case '--concurrency':
        opts.concurrency = Math.max(1, parsePositiveInt(flag, next()));
        break;
      case '--proxies':
        opts.proxiesFile = next();
        break;
      case '--skip-pdfs':
        opts.skipPdfs = true;
        break;
      case '--skip-details':
        opts.skipDetails = true;
        break;
      case '--verbose':
        opts.verbose = true;
        break;
      default:
        throw new Error(`Unknown flag: ${flag}`);
    }
  }
  return { command: command ?? '', opts };
}

function parsePositiveInt(flag: string, value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${flag} expects a non-negative integer, got "${value}"`);
  return n;
}

async function main(): Promise<void> {
  const { command, opts } = parseArgs(process.argv.slice(2));
  if (opts.verbose) setLogLevel('debug');

  // `report` reads an existing output dir; resolve the site from its state so
  // the right identity fields are checked regardless of the --site flag.
  if (command === 'report') {
    const state = readJsonIfExists<{ site: string }>(join(opts.outDir, 'state.json'));
    const required = state ? getAdapter(state.site).requiredFields : [];
    runReport(opts.outDir, required);
    return;
  }

  const adapter = getAdapter(opts.site);

  switch (command) {
    case 'scrape':
      await runScrape(adapter, opts);
      break;
    case 'retry-failed':
      await retryFailed(adapter, opts);
      break;
    default:
      console.log(USAGE.trim());
      process.exitCode = command ? 1 : 0;
      if (command) log.error(`Unknown command: ${command}`);
  }
}

main().catch((err) => {
  log.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
