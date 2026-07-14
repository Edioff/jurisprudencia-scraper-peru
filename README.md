# Scraper Challenge — JSF/PrimeFaces Document Repositories

A TypeScript scraper for Peruvian government document repositories built on
**JSF (JavaServer Faces) + PrimeFaces** — implemented with **pure HTTP requests**
(`axios` + `cheerio`), no browser automation of any kind.

It walks the complete result set, extracts every document's metadata, downloads
each associated PDF with a descriptive file name, and survives rate limiting
(HTTP 429), transient failures, session expiry and interruptions.

| Site | Adapter | Stack | Status |
| --- | --- | --- | --- |
| `jurisprudencia.pj.gob.pe/jurisprudenciaweb/faces/page/resultado.xhtml` | `pj` | JSF + **RichFaces 4.2.2** | ✅ Working (208,341 documents / 20,835 pages). Geo-blocked outside Peru — run behind a Peru VPN. |
| `publico.oefa.gob.pe/repdig/consulta/consultaTfa.xhtml` | `oefa` | JSF + **PrimeFaces 6.0** | ✅ Working (1,753 documents / 176 pages). Reachable anywhere — the challenge's no-VPN alternative. |

`pj` is the challenge's primary target; `oefa` is the sanctioned no-VPN
alternative. They run on **different JSF component frameworks** and interact
with their servers quite differently (see [How the sites work](#how-the-sites-work)),
yet share one core — which is the point of the adapter split.

---

## Quick start

```bash
npm install

# Smoke test against PJ (needs a Peru VPN): first 2 pages, max 5 PDFs
npm run scrape -- --site pj --max-pages 2 --max-docs 5

# Full PJ scrape (all pages, all PDFs — resumable, safe to interrupt)
npm run scrape -- --site pj

# Same against OEFA (no VPN needed) — handy for development
npm run scrape -- --site oefa --max-pages 2 --max-docs 5

# Re-attempt any downloads that exhausted their retries
npm run retry-failed -- --site pj

# Metadata only, no PDFs
npm run scrape -- --site pj --skip-pdfs
```

The default site is `oefa` (so `npm run scrape` works with no VPN); pass
`--site pj` for the primary target.

All flags:

```
--site <name>    Site adapter to use (default: oefa)
--out <dir>      Output directory (default: ./output)
--delay <ms>     Politeness delay between requests (default: 600)
--max-pages <n>  Process at most n result pages this run (default: all)
--max-docs <n>   Download at most n PDFs this run (default: unlimited)
--attempts <n>   Max attempts per download before recording failure (default: 5)
--skip-pdfs      Extract metadata only
--verbose        Debug logging
```

Neither full run needs to finish in one sitting — interrupt it (Ctrl+C) at any
point and re-run to resume. PJ is a large corpus (208k documents); the point of
resume + `retry-failed` is exactly that you don't have to download it all at
once, and the challenge only asks the scraper to *demonstrate* it can.

### Output layout

```
output/
├── documents.json   # every extracted document (all table columns + uuid + local pdf name)
├── documents.csv    # same data as CSV
├── state.json       # resume/retry bookkeeping (completed pages, downloaded uuids, failed downloads)
└── pdfs/            # PJ: "Casación-001785-2024__Resolucion_10_....pdf"; OEFA: "264-2012-OEFA-TFA__RTFA N° 264-2012.pdf"
```

---

## How the sites work

The challenge asks you to discover each site's structure. Both are **JSF
(Mojarra)** with no REST API and no stable URLs — every interaction is a POST
against an `.xhtml` page carrying a `JSESSIONID` cookie and a
`javax.faces.ViewState` token. But they run different component frameworks on
top of JSF, and the mechanics diverge enough that they are genuinely two
protocols. This is the interesting part of the challenge, so it's worth
spelling out.

### PJ — RichFaces 4.2.2 (the primary target)

ViewState here is a short server-side handle (`123:456`), not an encrypted
tree. The flow is classic, **non-AJAX** JSF:

- **Search.** GET `inicio.xhtml` for the ViewState and the full search form.
  Then a **full form POST** — the entire form resubmitted, plus the
  "general search" button's params. The server answers `302 → resultado.xhtml`.
  Gotcha: the site sits behind a TLS-terminating proxy that emits `http://`
  Location headers after an `https://` request; the HTTP client upgrades the
  scheme back (`http-client.ts`), otherwise the redirect breaks.
- **Count + pagination.** The results page reports the total in prose
  ("se obtuvieron 208341 resultados") and renders 10 items per page. Paging is
  another full form POST that drives the RichFaces page-number spinner
  (`formBuscador:spinner`) + its "IR" button to jump to any 1-based page.
- **Metadata.** Each result is a `formBuscador:repeat:N:...` block whose
  download link's `onclick` embeds a JS object with **every** field we want
  (uuid, expediente, recurso, sala, fecha, sumilla…). We read metadata straight
  from that object rather than scraping the formatted panel — more robust, and
  `N` is the row's absolute index across the whole result set. The object is
  doubly escaped in the markup (`&quot;` entities *and* `\"`), with `-`
  for dashes; `parseResults` collapses all of it.
- **PDF download.** A plain `GET /jurisprudenciaweb/ServletDescarga?uuid=<uuid>`
  streams the PDF (`Content-Disposition: attachment`). No arming, no ViewState.
- **Flakiness.** The PJ server returns intermittent `500`/`503`s on
  navigation. A same-ViewState retry can't recover those, so search/pagination
  re-initialize the session (fresh ViewState) between attempts (`withReinit`).

### OEFA — PrimeFaces 6.0 (the no-VPN alternative)

Here ViewState is an encrypted ~1.5 KB blob, and interactions are **AJAX**:

- **Search.** A PrimeFaces AJAX POST (`javax.faces.source = ...btnBuscar`) with
  every filter empty. The response is a `<partial-response>` XML whose
  `<update>` nodes carry HTML fragments inside CDATA — including the paginator
  (`Página 1 de 176 (1753 registros)`). Each response returns a **new**
  ViewState that must replace the current one.
- **Pagination.** Another AJAX POST (`dt_pagination=true`,
  `dt_first=<row offset>`). The fragment is a bare `<tr>` list with no parent
  table — spec-compliant HTML parsers drop orphan rows, a real trap, so
  `parseRows` wraps them first. Direct offset jumps work, making resume cheap.
- **PDF download.** A full form POST emulating the row link
  `mojarra.jsfcljs(form, {'form:dt:<n>:j_idt63': …, 'param_uuid': '<uuid>'})`,
  answered with the PDF bytes. A row is only "clickable" while its page is the
  one currently rendered; ask for one the view doesn't have and the server
  silently re-renders the page as HTML instead — which the scraper treats as
  view loss and recovers from.

---

## Architecture

```
src/
├── index.ts            # CLI (scrape / retry-failed, flag parsing)
├── scraper.ts          # orchestration: pages → rows → downloads; resume/recovery policy
├── state.ts            # persistent state: completed pages, downloaded uuids, failed list
├── types.ts            # shared domain types
├── core/               # site-agnostic machinery
│   ├── http-client.ts  # axios wrapper: cookies, politeness delay, manual redirects (+http→https upgrade)
│   ├── jsf-session.ts  # ViewState chaining, <partial-response> parsing, full-page POSTs, resource GETs
│   ├── retry.ts        # exponential backoff + jitter, Retry-After, 429/5xx classification
│   ├── cookie-jar.ts   # minimal session-cookie jar
│   ├── files.ts        # safe file names, atomic JSON writes, CSV export
│   └── logger.ts       # leveled, timestamped logging
└── sites/
    ├── adapter.ts      # SiteAdapter contract
    ├── oefa.ts         # OEFA (PrimeFaces): AJAX search/pagination, form-POST download
    ├── pj.ts           # PJ (RichFaces): full-form search/pagination, servlet GET download
    └── index.ts        # registry
```

The core owns everything site-independent — the session + ViewState lifecycle,
retry/backoff, the pagination loop, resume, and the record-and-continue
download policy. Each adapter owns only what differs: how to run the search,
how to page, how a row maps to metadata, and how to fetch its PDF. That the two
adapters target **different JSF frameworks** (PrimeFaces vs RichFaces) with
different transports — AJAX partial-responses vs full-page POSTs, a form-POST
download vs a resource GET — is the real test of that boundary, and it holds:
neither adapter needed a change to the core's contract beyond the download
method returning bytes.

### Error handling

Several failure domains, handled separately:

| Failure | Detection | Response |
| --- | --- | --- |
| **HTTP 429** | status code | Honors `Retry-After` when sent (RFC 9110 — parsed for 503 too); otherwise exponential backoff `1s → 2s → 4s → 8s → 16s` (±20 % jitter, capped 60 s). After 5 attempts the document is recorded in `state.json` and the scraper moves on. `retry-failed` reprocesses the list. |
| Transient 5xx / network errors | status / no response | Same backoff policy, on **every** request: navigation (init, search, pagination) is retried inside the JSF session layer, downloads by the orchestrator. |
| **Flaky-server 500s (PJ)** | status after backoff | RichFaces navigation 500s that a same-ViewState retry can't fix trigger a session re-init (fresh ViewState) and retry — `withReinit` in `pj.ts`. |
| **Session / view expiry** | partial-response error/redirect, or HTML where a PDF was expected | Re-initialize the session, re-run the search, re-paginate to the current page, retry once. |
| Interruption (Ctrl+C) | SIGINT | Finishes the in-flight document, persists state, exits. Re-running resumes: completed pages are skipped and already-downloaded uuids are never re-fetched. |

State writes are atomic (write-to-temp + rename), so a crash can't corrupt the
resume data. Every payload is validated before being trusted: downloaded files
must start with `%PDF-`, partial responses must contain the expected nodes.

### Politeness

Requests are globally spaced by a configurable delay (600 ms default) — the
scraper never issues concurrent requests against a site. Downloads are
sequential by design: these are shared government servers and the challenge
explicitly rewards not hammering them.

## Adding a site

Implement `SiteAdapter` (`src/sites/adapter.ts`) — `search`, `fetchPage`,
`downloadPdf`, `pdfFileName` — and register it in `src/sites/index.ts`. The
core (session, ViewState, retries, resume, orchestration) is reused as-is.
`oefa.ts` (PrimeFaces/AJAX) and `pj.ts` (RichFaces/full-form) are the two
reference implementations — pick whichever is closer to your target.

## Tests

```bash
npm test
```

24 unit tests (Node's built-in runner, no extra dependencies) cover the pure
logic against fixtures captured from **both** live sites:

- **OEFA:** partial-response parsing (including JSF's split-CDATA escaping of
  literal `]]>`), row extraction from both fragment shapes.
- **PJ:** metadata + uuid extraction from the doubly-escaped RichFaces download
  link, the absolute `repeat:N` row index, form-field harvesting, and picking
  the general-search button over the specialized one.
- **Shared:** 429/backoff/Retry-After semantics (incl. 503), retry exhaustion
  with accurate attempt counts, cookie handling, CSV escaping, Content-Disposition
  and file-name sanitization.

## Requirements

- Node.js ≥ 18
- Dependencies: `axios`, `cheerio` (runtime); `typescript`, `ts-node` (dev)

```bash
npm run build   # compile to dist/
npm start       # run the compiled CLI
```
