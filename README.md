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

Commands: `scrape`, `retry-failed`, `report` (validate an existing output dir).

All flags:

```
--site <name>     Site adapter to use (default: oefa)
--out <dir>       Output directory (default: ./output)
--delay <ms>      Politeness delay between request starts (default: 600)
--max-pages <n>   Process at most n result pages this run (default: all)
--max-docs <n>    Download at most n PDFs this run (default: unlimited)
--attempts <n>    Max attempts per download before recording failure (default: 5)
--concurrency <n> Parallel PDF downloads, where the site allows it (default: 1)
--proxies <file>  Rotate through proxy URLs in <file>, one per line (default: direct)
--skip-pdfs       Extract metadata only
--verbose         Debug logging
```

Neither full run needs to finish in one sitting — interrupt it (Ctrl+C) at any
point and re-run to resume. PJ is a large corpus (208k documents); the point of
resume + `retry-failed` is exactly that you don't have to download it all at
once, and the challenge only asks the scraper to *demonstrate* it can.

### Output layout

```
output/
├── documents.json   # every extracted document (all metadata fields + uuid + local pdf name)
├── documents.csv    # same data as CSV
├── state.json       # resume/retry bookkeeping (completed pages, downloaded uuids, failed downloads)
├── report.json      # validation report (see below)
└── pdfs/            # PJ: "Casación-001785-2024__Resolucion_10_....pdf"; OEFA: "264-2012-OEFA-TFA__RTFA N° 264-2012.pdf"
```

### Validation (sanity checks before delivering)

Every scrape ends with a validation report — and `npm run report -- --out <dir>`
regenerates it against an existing run. It's the "check the data makes sense
before handing it over" step the challenge asks for, and it checks:

- **Coverage** — documents extracted vs the corpus total, pages completed.
- **Identity integrity** — the fields that must exist on every document
  (e.g. `recurso` + `nroexp` for PJ) are flagged if under 100% — a fast signal
  of a parsing regression. Genuinely-optional fields (a sumilla, a keyword
  list) are shown but never warned on, so the report doesn't cry wolf.
- **Duplicates** — repeated uuids among extracted documents.
- **PDF integrity** — a sample of downloaded files is checked for the `%PDF-`
  header and a non-trivial size.
- **Failures** — how many downloads are pending in the retry list.

```
Validation report — pj
  Corpus total:        208341
  Documents extracted: 30 (0% of corpus)
  Unique uuids:        30
  PDFs downloaded:     30 (sample valid: 25/25)
  Metadata coverage:
   *recurso            100%  (30/30)
   *nroexp             100%  (30/30)
    sumilla             40%  (12/30)
    (* = identity field, must be 100%)
  ✓ No consistency issues found.
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
├── index.ts            # CLI (scrape / retry-failed / report, flag parsing)
├── scraper.ts          # orchestration: pages → rows → downloads; resume/recovery/concurrency policy
├── report.ts           # validation report (coverage, identity integrity, PDF checks)
├── state.ts            # persistent state: completed pages, downloaded uuids, failed list
├── types.ts            # shared domain types
├── core/               # site-agnostic machinery
│   ├── http-client.ts  # axios wrapper: cookies, rate limiter, manual redirects (+http→https upgrade), proxy
│   ├── jsf-session.ts  # ViewState chaining, <partial-response> parsing, full-page POSTs, resource GETs
│   ├── retry.ts        # exponential backoff + jitter, Retry-After, 429/5xx classification
│   ├── concurrency.ts  # bounded-concurrency map (worker pool)
│   ├── proxy.ts        # optional round-robin proxy pool (off by default)
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

### Politeness, concurrency and proxies

Request **starts** are spaced by a configurable delay (600 ms default) via a
small rate limiter — so even under concurrency the scraper never bursts. These
are shared government servers and the challenge explicitly rewards not
hammering them.

**Concurrency (`--concurrency N`, default 1).** Downloads can run in a bounded
pool, but only where it's actually safe. The interesting constraint is the
ViewState: it mutates on every navigation POST, so **pagination can't be
parallelized within one session** — two concurrent page requests would corrupt
each other's view. Downloads are different per site, and each adapter declares
its capability:

- **PJ** — `ServletDescarga?uuid=` is a stateless GET (just the cookie + uuid),
  so downloads parallelize safely. The pool skips session recovery here (there
  is no shared view to lose) and relies on plain retry.
- **OEFA** — the download is a form POST that needs the row rendered in the
  current view, so it stays sequential regardless of `--concurrency`.

Honest note on speed: for these targets the PDFs are large (up to ~13 MB) and
the link (via VPN, for PJ) is bandwidth-bound, so parallel downloads mostly
split the same pipe — the win is marginal here. Concurrency pays off when the
bottleneck is latency (many small requests), not bandwidth. It's built,
correct and off by default; the value is the framework-aware design, not a
blanket speed claim.

**Proxy rotation (`--proxies <file>`, default off).** The targets have no
IP-based anti-bot, so the scraper goes direct. The capability is wired in
behind a clean interface (`core/proxy.ts`, round-robin over a list, one proxy
per request, kept across redirect hops) for the day the same engine is pointed
at a source that rate-limits by IP — using axios' built-in proxy support, so
no extra dependency. Enable it with a file of `http://user:pass@host:port`
lines.

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

28 unit tests (Node's built-in runner, no extra dependencies) cover the pure
logic against fixtures captured from **both** live sites:

- **OEFA:** partial-response parsing (including JSF's split-CDATA escaping of
  literal `]]>`), row extraction from both fragment shapes.
- **PJ:** metadata + uuid extraction from the doubly-escaped RichFaces download
  link (including a value that itself contains quotes — a real trap), the
  absolute `repeat:N` row index, form-field harvesting, and picking the
  general-search button over the specialized one.
- **Shared:** 429/backoff/Retry-After semantics (incl. 503), retry exhaustion
  with accurate attempt counts, cookie handling, CSV escaping, Content-Disposition
  and file-name sanitization, the bounded-concurrency pool, and proxy parsing.

## Requirements

- Node.js ≥ 18
- Dependencies: `axios`, `cheerio` (runtime); `typescript`, `ts-node` (dev)

```bash
npm run build   # compile to dist/
npm start       # run the compiled CLI
```
