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

import { log, setLogLevel } from './core/logger';
import { runScrape, retryFailed, runReport } from './scraper';
import { StateStore } from './state';
import { getAdapter, listAdapters } from './sites';
import { ScraperOptions } from './types';

const USAGE = `
Usage: npm run scrape -- [flags] | npm run retry-failed -- [flags] | npm run report -- [flags]

Commands:
  scrape          Extract all documents and download their PDFs
  retry-failed    Reprocess downloads recorded as failed (pdf_status='failed')
  export          Regenerate documents.json / .csv / state.json from the database
  report          Validate an existing output directory (sanity-check report)
  verify          Alias for report (coverage, PDF-on-disk, pending/failed)

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
  --page-concurrency <n> Parallel pagination via n independent sessions (default: 1)
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
    pageConcurrency: 1,
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
      case '--page-concurrency':
        opts.pageConcurrency = Math.max(1, parsePositiveInt(flag, next()));
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

  // `export`, `report` and `verify` operate on an existing output directory;
  // resolve the site from the database so the right adapter (and identity
  // fields) is used regardless of the --site flag. `verify` is an alias for
  // `report`.
  if (command === 'export' || command === 'report' || command === 'verify') {
    const site = StateStore.siteOf(opts.outDir);
    if (!site) {
      log.error(`No database found in ${opts.outDir} — run a scrape first.`);
      process.exitCode = 1;
      return;
    }
    const adapter = getAdapter(site);
    const state = new StateStore(opts.outDir, site, { hasDetail: !!adapter.fetchDetail });
    const { documents } = state.exportArtifacts();
    state.close();
    log.info(`Exported ${documents} documents to documents.json / documents.csv / state.json`);
    if (command === 'report' || command === 'verify') runReport(opts.outDir, adapter.requiredFields);
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
