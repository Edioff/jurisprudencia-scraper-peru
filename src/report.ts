/**
 * Validation report — the "sanity check before delivering" step.
 *
 * The challenge explicitly rewards validating results (expected counts,
 * samples, consistency) before handing them over. This reads the run's
 * output and checks it against what we expected, surfacing anything that
 * looks off: coverage gaps, missing metadata, duplicate ids, failed or
 * corrupt PDFs. It runs automatically at the end of a scrape and is also
 * available on demand (`npm run report`) against any output directory.
 */

import * as fs from 'fs';
import * as path from 'path';
import { readJsonIfExists } from './core/files';
import { log } from './core/logger';
import { DocumentRecord, ScrapeState } from './types';

export interface FieldCoverage {
  field: string;
  present: number;
  total: number;
  pct: number;
}

export interface ValidationReport {
  site: string;
  generatedAt: string;
  corpusTotal: number | null;
  documentsExtracted: number;
  pagesCompleted: number;
  uniqueUuids: number;
  duplicateUuids: number;
  pdfsDownloaded: number;
  pdfsFailed: number;
  pdfSampleChecked: number;
  pdfSampleValid: number;
  metadataCoverage: FieldCoverage[];
  requiredFields: readonly string[];
  warnings: string[];
  ok: boolean;
}

const PDF_SAMPLE_SIZE = 25;
const MIN_PDF_BYTES = 1024;

/** Build a validation report from an output directory's persisted state.
 *  `requiredFields` are the identity columns whose partial coverage signals a
 *  parsing regression; everything else may legitimately be sparse. */
export function buildReport(
  outDir: string,
  stampIso: string,
  requiredFields: readonly string[] = [],
): ValidationReport {
  const state = readJsonIfExists<ScrapeState>(path.join(outDir, 'state.json'));
  const docs = readJsonIfExists<DocumentRecord[]>(path.join(outDir, 'documents.json')) ?? [];
  if (!state) {
    throw new Error(`No state.json in ${outDir} — nothing to validate. Run a scrape first.`);
  }

  const uuids = docs.map((d) => d.uuid).filter((u): u is string => !!u);
  const uniqueUuids = new Set(uuids).size;
  const warnings: string[] = [];

  // --- metadata completeness across the union of field names ---
  const fieldNames = new Set<string>();
  for (const d of docs) for (const k of Object.keys(d.fields)) fieldNames.add(k);
  const metadataCoverage: FieldCoverage[] = [...fieldNames]
    .map((field) => {
      const present = docs.filter((d) => (d.fields[field] ?? '').trim() !== '').length;
      return { field, present, total: docs.length, pct: pct(present, docs.length) };
    })
    .sort((a, b) => a.pct - b.pct);

  // --- PDF integrity on a sample of what we downloaded ---
  const pdfDir = path.join(outDir, 'pdfs');
  const downloaded = Object.values(state.downloaded);
  const sample = downloaded.slice(0, PDF_SAMPLE_SIZE);
  let pdfSampleValid = 0;
  for (const file of sample) {
    if (isValidPdf(path.join(pdfDir, file))) pdfSampleValid++;
  }

  // --- consistency checks -> warnings ---
  if (duplicate(uuids)) {
    warnings.push(`${uuids.length - uniqueUuids} duplicate uuid(s) among extracted documents`);
  }
  // Only identity fields warrant a warning when incomplete — other columns
  // (a sumilla, a keyword list) are legitimately absent on many documents.
  // A field missing from *every* document has no coverage entry at all; that
  // is the worst case (a total parsing regression), so treat absent as 0%.
  for (const field of requiredFields) {
    const coverage = metadataCoverage.find((x) => x.field === field)?.pct ?? 0;
    if (docs.length > 0 && coverage < 100) {
      warnings.push(`identity field "${field}" present on only ${coverage}% of documents (parsing issue?)`);
    }
  }
  if (state.failed.length > 0) {
    warnings.push(`${state.failed.length} download(s) failed — run \`retry-failed\` to reprocess`);
  }
  if (sample.length > 0 && pdfSampleValid < sample.length) {
    warnings.push(`${sample.length - pdfSampleValid}/${sample.length} sampled PDFs are missing or not valid PDF files`);
  }
  if (state.totalRecords && docs.length > state.totalRecords) {
    warnings.push(`extracted ${docs.length} documents but corpus reports only ${state.totalRecords}`);
  }

  return {
    site: state.site,
    generatedAt: stampIso,
    corpusTotal: state.totalRecords,
    documentsExtracted: docs.length,
    pagesCompleted: state.completedPages.length,
    uniqueUuids,
    duplicateUuids: uuids.length - uniqueUuids,
    pdfsDownloaded: downloaded.length,
    pdfsFailed: state.failed.length,
    pdfSampleChecked: sample.length,
    pdfSampleValid,
    metadataCoverage,
    requiredFields,
    warnings,
    ok: warnings.length === 0,
  };
}

/** Persist the report as JSON and print a readable summary to the log. */
export function writeAndPrintReport(outDir: string, report: ValidationReport): void {
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf-8');

  const line = '─'.repeat(60);
  const pctCorpus =
    report.corpusTotal && report.corpusTotal > 0
      ? ` (${pct(report.documentsExtracted, report.corpusTotal)}% of corpus)`
      : '';
  log.info(line);
  log.info(`Validation report — ${report.site}`);
  log.info(`  Corpus total:        ${report.corpusTotal ?? 'unknown'}`);
  log.info(`  Documents extracted: ${report.documentsExtracted}${pctCorpus}`);
  log.info(`  Pages completed:     ${report.pagesCompleted}`);
  log.info(`  Unique uuids:        ${report.uniqueUuids}${report.duplicateUuids ? ` (${report.duplicateUuids} duplicates!)` : ''}`);
  log.info(`  PDFs downloaded:     ${report.pdfsDownloaded} (sample valid: ${report.pdfSampleValid}/${report.pdfSampleChecked})`);
  log.info(`  PDFs failed:         ${report.pdfsFailed}`);
  log.info(`  Metadata coverage:`);
  for (const c of report.metadataCoverage) {
    const mark = report.requiredFields.includes(c.field) ? ' *' : '  ';
    log.info(`   ${mark}${c.field.padEnd(18)} ${String(c.pct).padStart(3)}%  (${c.present}/${c.total})`);
  }
  if (report.requiredFields.length) log.info(`     (* = identity field, must be 100%)`);
  if (report.warnings.length === 0) {
    log.info(`  ✓ No consistency issues found.`);
  } else {
    log.warn(`  ${report.warnings.length} warning(s):`);
    for (const w of report.warnings) log.warn(`     • ${w}`);
  }
  log.info(`  Full report written to report.json`);
  log.info(line);
}

function isValidPdf(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size < MIN_PDF_BYTES) return false;
    const fd = fs.openSync(filePath, 'r');
    try {
      const head = Buffer.alloc(5);
      fs.readSync(fd, head, 0, 5, 0);
      return head.toString('latin1') === '%PDF-';
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function pct(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 100);
}

function duplicate(values: string[]): boolean {
  return new Set(values).size !== values.length;
}
