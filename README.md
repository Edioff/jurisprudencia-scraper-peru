# Scraper Challenge — JSF/PrimeFaces Document Repositories

A TypeScript scraper for Peruvian government document repositories built on
**JSF (JavaServer Faces) + PrimeFaces** — implemented with **pure HTTP requests**
(`axios` + `cheerio`), no browser automation of any kind.

It walks the complete result set, extracts every document's metadata, downloads
each associated PDF with a descriptive file name, and survives rate limiting
(HTTP 429), transient failures, session expiry and interruptions.

| Site | Adapter | Status |
| --- | --- | --- |
| `publico.oefa.gob.pe/repdig/consulta/consultaTfa.xhtml` | `oefa` | ✅ Working (1,753 documents / 176 pages) |
| `jurisprudencia.pj.gob.pe/jurisprudenciaweb/faces/page/resultado.xhtml` | `pj` | 🔜 The site is geo-blocked outside Peru (HTTP 403); the adapter plugs into the same core (see [Adding a site](#adding-a-site)) |

---

## Quick start

```bash
npm install

# Smoke test: first 2 pages, max 5 PDFs
npm run scrape -- --max-pages 2 --max-docs 5

# Full scrape (all pages, all PDFs — resumable, safe to interrupt)
npm run scrape

# Re-attempt any downloads that exhausted their retries
npm run retry-failed

# Metadata only, no PDFs
npm run scrape -- --skip-pdfs
```

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

The full OEFA run is ~1,940 HTTP requests. With the default 600 ms politeness
delay plus download time it takes a few hours; it does **not** need to finish in
one sitting — interrupt it (Ctrl+C) at any point and re-run to resume.

### Output layout

```
output/
├── documents.json   # every extracted document (all table columns + uuid + local pdf name)
├── documents.csv    # same data as CSV
├── state.json       # resume/retry bookkeeping (completed pages, downloaded uuids, failed downloads)
└── pdfs/            # e.g. "264-2012-OEFA-TFA__RTFA N° 264-2012.pdf"
```

---

## How the site works (discovery notes)

The challenge asks you to discover the site's structure; this is what reverse
engineering it revealed, and what the scraper replicates:

**Stack:** JSF (Mojarra) + PrimeFaces 6.0 with *client-side state saving*.
There is no REST API and no stable URLs — every interaction is a POST against
the same `.xhtml` page, driven by two tokens:

1. **`JSESSIONID`** — ordinary session cookie, set on the first GET.
2. **`javax.faces.ViewState`** — an encrypted ~1.5 KB blob embedded in a hidden
   input. It encodes the entire server-side component tree state. Every AJAX
   response returns a **new** ViewState that must replace the previous one;
   sending a stale or foreign token makes the server silently ignore your
   action and re-render the page.

**Search.** The results table is exposed by submitting the filter form empty
(PrimeFaces AJAX POST, `javax.faces.source = ...btnBuscar`). The response is a
`<partial-response>` XML document whose `<update>` nodes carry HTML fragments
inside CDATA — including the paginator, which reports the total
(`Página 1 de 176 (1753 registros)`).

**Pagination.** Another AJAX POST (`...dt_pagination=true`,
`...dt_first=<absolute row offset>`). The fragment returned is a bare `<tr>`
list (no surrounding table — spec-compliant HTML parsers drop orphan rows, a
real trap; see `parseRows`). Direct jumps to any offset work, which is what
makes resuming cheap.

**PDF download.** Each row's link runs
`mojarra.jsfcljs(form, {'form:dt:<n>:j_idt63': ..., 'param_uuid': '<uuid>'})` —
a **full form POST** (not AJAX) answered with the raw PDF bytes and a
`Content-Disposition: attachment` file name. Two hard-won rules:

- A row can only be "clicked" while its page is the one rendered in the current
  ViewState. Ask for a row the view doesn't have and the server returns a
  normal HTML page instead of a PDF — silently. The scraper treats any non-PDF
  answer as view loss and recovers (re-init → re-search → re-paginate → retry).
- Download responses do **not** rotate the ViewState, so the last one received
  keeps working for the following downloads and pagination calls.

---

## Architecture

```
src/
├── index.ts            # CLI (scrape / retry-failed, flag parsing)
├── scraper.ts          # orchestration: pages → rows → downloads; resume/recovery policy
├── state.ts            # persistent state: completed pages, downloaded uuids, failed list
├── types.ts            # shared domain types
├── core/               # site-agnostic machinery
│   ├── http-client.ts  # axios wrapper: cookies, politeness delay, manual redirects
│   ├── jsf-session.ts  # ViewState chaining + <partial-response> parsing
│   ├── retry.ts        # exponential backoff + jitter, Retry-After, 429 classification
│   ├── cookie-jar.ts   # minimal session-cookie jar
│   ├── files.ts        # safe file names, atomic JSON writes, CSV export
│   └── logger.ts       # leveled, timestamped logging
└── sites/
    ├── adapter.ts      # SiteAdapter contract
    ├── oefa.ts         # OEFA: form ids, columns, download parameters
    └── index.ts        # registry
```

The split follows how these government sites are built: the **JSF mechanics
are identical across them** (ViewState chaining, partial responses, paginated
DataTable, file-stream POSTs) while form ids, columns and download parameters
differ. The core owns the former; a ~150-line adapter owns the latter.

### Error handling

Two failure domains, handled separately:

| Failure | Detection | Response |
| --- | --- | --- |
| **HTTP 429** | status code | Honors `Retry-After` when sent (RFC 9110 — parsed for 503 as well); otherwise exponential backoff `1s → 2s → 4s → 8s → 16s` (±20 % jitter, capped 60 s). After 5 attempts the document is recorded in `state.json` and the scraper moves on. `npm run retry-failed` reprocesses the list. |
| Transient 5xx / network errors | status / no response | Same backoff policy. Applies to **every** request: navigation (init, search, pagination) is retried inside the JSF session layer, downloads by the orchestrator, which owns the record-and-continue policy. |
| **Session / view expiry** | `<partial-response>` error node, redirect, or HTML where a PDF was expected | Re-initialize the session, re-run the search, re-paginate to the current page, retry once. |
| Interruption (Ctrl+C) | SIGINT | Finishes the in-flight document, persists state, exits. Re-running resumes: completed pages are skipped and already-downloaded uuids are never re-fetched. |

State writes are atomic (write-to-temp + rename), so a crash can't corrupt the
resume data. Every payload is validated before being trusted: PDFs must start
with `%PDF-`, partial responses must contain the expected update nodes.

### Politeness

Requests are globally spaced by a configurable delay (600 ms default) — the
scraper never issues concurrent requests against the site. Downloads are
sequential by design: these are shared government servers and the challenge
explicitly rewards not hammering them.

## Adding a site

Implement `SiteAdapter` (`src/sites/adapter.ts`) — form/component ids, column
names, download parameters — and register it in `src/sites/index.ts`. The JSF
core (session, ViewState, retries, resume) is reused as-is. `oefa.ts` is the
reference implementation.

## Tests

```bash
npm test
```

Unit tests (Node's built-in runner, no extra dependencies) cover the pure
logic against fixtures captured from the live site: partial-response parsing
(including JSF's split-CDATA escaping of literal `]]>`), row extraction from
both fragment shapes, 429/backoff/Retry-After semantics, retry exhaustion,
cookie handling, CSV escaping and file-name sanitization.

## Requirements

- Node.js ≥ 18
- Dependencies: `axios`, `cheerio` (runtime); `typescript`, `ts-node` (dev)

```bash
npm run build   # compile to dist/
npm start       # run the compiled CLI
```
