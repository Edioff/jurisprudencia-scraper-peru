/**
 * Adapter: OEFA — Repositorio Digital, "Resoluciones del Tribunal de
 * Fiscalización Ambiental" (https://publico.oefa.gob.pe/repdig/consulta/consultaTfa.xhtml).
 *
 * Stack observed: JSF (Mojarra) + PrimeFaces 6.0, client-side state saving.
 *
 * Discovered interaction protocol:
 *  - Search: AJAX POST, source = `...:btnBuscar`, renders `...:pgLista`.
 *    Submitting with every filter empty returns the complete result set.
 *  - Pagination: AJAX POST, source = `...:dt` with `dt_pagination=true`,
 *    `dt_first=<absolute row offset>`; response contains only `<tr>` rows.
 *  - Download: full form POST that emulates the row link
 *    `mojarra.jsfcljs(form, {'<form>:dt:<n>:j_idt63': ..., 'param_uuid': '<uuid>'})`,
 *    answered with the PDF bytes (`Content-Disposition: attachment`).
 */

import * as cheerio from 'cheerio';
import { JsfSession } from '../core/jsf-session';
import { DocumentRecord } from '../types';
import { SearchResult, SiteAdapter } from './adapter';
import { sanitizeFileName } from '../core/files';

const FORM = 'listarDetalleInfraccionRAAForm';
const TABLE = `${FORM}:dt`;
const SEARCH_BUTTON = `${FORM}:btnBuscar`;
const RESULTS_PANEL = `${FORM}:pgLista`;

/** Metadata columns, in the order the table renders them. */
const COLUMNS = [
  'nro',
  'numeroExpediente',
  'administrado',
  'unidadFiscalizable',
  'sector',
  'nroResolucionApelacion',
] as const;

/** The site's empty filter fields, sent verbatim on every request. */
const FILTER_FIELDS: Record<string, string> = {
  [`${FORM}:txtNroexp`]: '',
  [`${FORM}:j_idt21`]: '',
  [`${FORM}:j_idt25`]: '',
  [`${FORM}:idsector`]: '',
  [`${FORM}:j_idt34`]: '',
  [`${FORM}:dt_scrollState`]: '0,0',
};

/** `mojarra.jsfcljs(..., {'form:dt:N:j_idtXX':'...','param_uuid':'<uuid>'}, ...)` */
const DOWNLOAD_ONCLICK = /\{'([^']+)':'[^']*','param_uuid':'([^']+)'\}/;

const TOTAL_RECORDS = /\((\d+)\s+registros?\)/;
const PAGINATOR_ROWS = /paginator:\{[^}]*rows:(\d+)/;

export class OefaAdapter implements SiteAdapter {
  readonly name = 'oefa';
  readonly description = 'OEFA — Resoluciones del Tribunal de Fiscalización Ambiental';
  readonly baseUrl = 'https://publico.oefa.gob.pe';
  readonly pagePath = '/repdig/consulta/consultaTfa.xhtml';

  async search(session: JsfSession): Promise<SearchResult> {
    const res = await session.postAjax({
      'javax.faces.partial.ajax': 'true',
      'javax.faces.source': SEARCH_BUTTON,
      'javax.faces.partial.execute': '@all',
      'javax.faces.partial.render': `${RESULTS_PANEL} ${FORM}:txtNroexp`,
      [SEARCH_BUTTON]: SEARCH_BUTTON,
      [FORM]: FORM,
      ...FILTER_FIELDS,
    });

    const fragment = res.updates.get(RESULTS_PANEL);
    if (!fragment) {
      throw new Error(`Search response did not update ${RESULTS_PANEL} — site layout may have changed`);
    }

    const totalMatch = fragment.match(TOTAL_RECORDS);
    const rowsMatch = fragment.match(PAGINATOR_ROWS);
    if (!totalMatch) throw new Error('Could not read total record count from paginator');

    return {
      totalRecords: Number(totalMatch[1]),
      pageSize: rowsMatch ? Number(rowsMatch[1]) : 10,
      firstPageRows: this.parseRows(fragment, 0),
    };
  }

  async fetchPage(session: JsfSession, pageIndex: number, pageSize: number): Promise<DocumentRecord[]> {
    const res = await session.postAjax({
      'javax.faces.partial.ajax': 'true',
      'javax.faces.source': TABLE,
      'javax.faces.partial.execute': TABLE,
      'javax.faces.partial.render': TABLE,
      [TABLE]: TABLE,
      [`${TABLE}_pagination`]: 'true',
      [`${TABLE}_first`]: String(pageIndex * pageSize),
      [`${TABLE}_rows`]: String(pageSize),
      [`${TABLE}_skipChildren`]: 'true',
      [`${TABLE}_encodeFeature`]: 'true',
      [FORM]: FORM,
      ...FILTER_FIELDS,
    });

    const fragment = res.updates.get(TABLE);
    if (fragment === undefined) {
      throw new Error(`Pagination response did not update ${TABLE}`);
    }
    return this.parseRows(fragment, pageIndex);
  }

  /**
   * Extract rows from a fragment. Handles both shapes the site produces:
   * the full results panel (search) and the bare `<tr>` list (pagination).
   * Orphan `<tr>` elements are dropped by spec-compliant HTML parsers,
   * so bare row lists get wrapped in a table before parsing.
   */
  private parseRows(fragmentHtml: string, pageIndex: number): DocumentRecord[] {
    const html = /^\s*<tr[\s>]/i.test(fragmentHtml)
      ? `<table><tbody>${fragmentHtml}</tbody></table>`
      : fragmentHtml;
    const $ = cheerio.load(html);
    const rows: DocumentRecord[] = [];

    $('tr[data-ri]').each((_i, tr) => {
      const cells = $(tr).find('td');
      if (cells.length < COLUMNS.length) return;

      const fields: Record<string, string> = {};
      COLUMNS.forEach((name, idx) => {
        fields[name] = normalizeText($(cells[idx]).text());
      });

      const onclick = $(tr).find('td a[onclick]').attr('onclick') ?? '';
      const download = onclick.match(DOWNLOAD_ONCLICK);

      rows.push({
        uuid: download ? download[2] : null,
        rowIndex: Number($(tr).attr('data-ri')),
        page: pageIndex,
        fields,
        downloadButtonId: download ? download[1] : null,
      });
    });

    return rows;
  }

  buildDownloadFields(row: DocumentRecord): Record<string, string> {
    if (!row.downloadButtonId || !row.uuid) {
      throw new Error(`Row ${row.rowIndex} has no download link`);
    }
    return {
      [FORM]: FORM,
      ...FILTER_FIELDS,
      [row.downloadButtonId]: row.downloadButtonId,
      param_uuid: row.uuid,
    };
  }

  pdfFileName(row: DocumentRecord, serverFileName: string | null): string {
    // e.g. "0264-2012-OEFA-TFA__Re 236-2013.pdf" — resolution number first
    // (unique, human-searchable), server's original name preserved after it.
    const resolution = row.fields.nroResolucionApelacion || row.fields.numeroExpediente || `row-${row.rowIndex}`;
    const server = serverFileName?.replace(/\.pdf$/i, '');
    const base = server ? `${resolution}__${server}` : resolution;
    return `${sanitizeFileName(base)}.pdf`;
  }
}

/** Collapse runs of whitespace/newlines that JSF leaves inside table cells. */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
