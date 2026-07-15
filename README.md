# Scraper de jurisprudencia peruana (JSF: RichFaces / PrimeFaces)

Scraper en **TypeScript** para dos repositorios de documentos del Estado peruano,
hecho con **peticiones HTTP puras** (`axios` + `cheerio`). **No usa automatización
de navegador** (nada de Puppeteer, Playwright ni Selenium): se conversa con el
servidor a mano, entendiendo su protocolo.

Recorre el listado completo, extrae **toda** la información de cada documento,
descarga su PDF con un nombre descriptivo, y aguanta lo que un scraper de verdad
tiene que aguantar: rate limiting (HTTP 429), caídas intermitentes del servidor,
expiración de sesión e interrupciones a medio camino (lo puedes cortar y
reanudar).

| Sitio | Adapter | Framework | Estado |
| --- | --- | --- | --- |
| `jurisprudencia.pj.gob.pe/.../resultado.xhtml` | `pj` | JSF + **RichFaces 4.2.2** | ✅ Funciona (208.341 documentos / 20.835 páginas). Geo-bloqueado fuera de Perú → correr con **VPN de Perú**. |
| `publico.oefa.gob.pe/repdig/consulta/consultaTfa.xhtml` | `oefa` | JSF + **PrimeFaces 6.0** | ✅ Funciona (1.753 documentos / 176 páginas). Accesible desde cualquier lugar → es el **alterno sin VPN**. |

`pj` es el objetivo principal del reto; `oefa` es el alterno permitido para
desarrollar sin VPN. Lo interesante es que **corren sobre frameworks JSF
distintos** y se comportan muy diferente (ver [Cómo funcionan los sitios](#cómo-funcionan-los-sitios-el-reverse-engineering)),
pero comparten **un mismo núcleo**. Esa es justamente la gracia de separar el
núcleo de los *adapters*.

---

## Requisitos

- **Node.js ≥ 20** (por `better-sqlite3`, que trae binarios precompilados; no
  necesitas compilador).
- Dependencias de runtime: `axios`, `cheerio`, `better-sqlite3`.
- Dependencias de desarrollo: `typescript`, `ts-node`, tipos.
- **Solo para `--site pj`: salida a internet por IP peruana.** El sitio del PJ
  está geo-bloqueado fuera de Perú. Yo desarrollé y probé todo con **NordVPN**
  conectado a un servidor de Perú, pero sirve cualquier VPN o proxy con salida
  peruana: el bloqueo es puramente geográfico, no hay anti-bot por IP (ver
  [En producción](#en-producción)). OEFA no necesita nada de esto.

```bash
npm install
```

---

## Inicio rápido

> **Nota para Windows / PowerShell.** PowerShell se **come el `--`** que separa
> los argumentos de `npm`, y entonces `npm` interpreta mal las banderas
> (`--site`, `--out`…). Por eso en Windows lo más limpio es llamar a `ts-node`
> directo, sin `npm run`:
>
> ```powershell
> npx ts-node src/index.ts scrape --site pj --out output --concurrency 10 --max-pages 5
> ```
>
> En macOS/Linux sí funciona la forma normal con `npm run ... -- ...`:
>
> ```bash
> npm run scrape -- --site pj --out output --concurrency 10 --max-pages 5
> ```

Ejemplos (uso la forma `npx ts-node`, que sirve en todos lados):

```bash
# Prueba rápida contra PJ (requiere VPN de Perú): primeras 5 páginas
npx ts-node src/index.ts scrape --site pj --out output --max-pages 5

# Scrape completo de PJ (todas las páginas; se puede interrumpir y reanudar)
npx ts-node src/index.ts scrape --site pj --out output

# Lo mismo contra OEFA (no necesita VPN) — cómodo para desarrollar
npx ts-node src/index.ts scrape --site oefa --out salida-oefa --max-pages 5

# Reintentar solo los PDFs que quedaron marcados como fallidos
npx ts-node src/index.ts retry-failed --site pj --out output

# Regenerar documents.json / documents.csv / state.json desde la base de datos
npx ts-node src/index.ts export --out output

# Reporte de validación (sanity check) de una corrida existente
npx ts-node src/index.ts report --out output
```

### Comandos

| Comando | Qué hace |
| --- | --- |
| `scrape` | Recorre el listado, extrae metadata + ficha, descarga los PDFs. **Reanuda** lo que ya estaba hecho. |
| `retry-failed` | Reprocesa solo los documentos con la descarga marcada como `failed`. |
| `export` | Vuelca la base de datos a `documents.json`, `documents.csv` y `state.json`. |
| `report` | Valida una corrida y escribe/imprime el reporte de sanidad. |
| `verify` | Alias de `report` (cobertura, PDFs en disco, pendientes/fallidos). |

### Banderas

```
--site <name>      Adapter a usar: pj | oefa (default: oefa)
--out <dir>        Carpeta de salida (default: ./output)
--delay <ms>       Espera entre inicios de petición (default: 600)
--max-pages <n>    Procesar como máximo n páginas en esta corrida (default: todas)
--max-docs <n>     Descargar como máximo n PDFs en esta corrida (default: sin tope)
--attempts <n>     Intentos por descarga antes de marcarla como fallida (default: 5)
--concurrency <n>  Descargas en paralelo, donde el sitio lo permita (default: 1)
--page-concurrency <n>  Paginación en paralelo con n sesiones independientes (default: 1)
--proxies <file>   Rotar por los proxies de <file>, uno por línea (default: directo)
--skip-details     No traer la ficha; quedarse solo con la metadata del listado
--skip-pdfs        Solo metadata, sin descargar PDFs
--verbose          Log de depuración
```

Por defecto, el scraper de PJ extrae la **ficha completa de ~40 campos** de cada
documento (el "Ver Ficha"), no solo los ~9 del listado. Con `--skip-details`
haces una pasada más rápida, solo de listado.

Ninguna corrida completa tiene que terminar de una sentada: la interrumpes con
`Ctrl+C` cuando quieras y al volver a correr **reanuda** donde iba. PJ es un
corpus grande (208 mil documentos); el punto de la reanudación + `retry-failed`
es precisamente ese, que no tienes que bajarlo todo de un tirón.

---

## Cómo se guarda la data (SQLite)

Toda la corrida vive en una base de datos **SQLite** dentro de la carpeta de
salida: `output/documents.db`. Los archivos `documents.json`, `documents.csv` y
`state.json` son **exportaciones** que se generan desde ahí (al final de cada
corrida, o cuando corres `export`).

### ¿Por qué SQLite y no solo un JSON?

Al principio esto guardaba todo en un `documents.json`. Con un corpus de 208 mil
documentos ese enfoque se cae por dos razones:

1. **No escala.** Un array JSON de 208 mil objetos hay que cargarlo entero en
   memoria para leerlo o consultarlo, y se reescribe completo en cada página. Es
   caro y frágil.
2. **No es consultable.** Para saber "¿qué páginas me faltan?" o "¿cuáles PDFs
   fallaron?" tocaría recorrer el archivo entero a mano.

Una base de datos embebida es la respuesta honesta a ese tamaño: **un solo
archivo**, indexado por `uuid`, con consultas de reanudación que son una línea de
SQL. `better-sqlite3` es síncrono y trae binarios precompilados, así que
`npm install` no necesita compilador y no añade fricción.

Los PDFs **sí** quedan como archivos en `output/pdfs/` (el reto los pide así),
amarrados a su documento por la columna `pdf_file` ↔ el `uuid`.

### Las tres tablas

```sql
-- documents: la data. Una fila por documento.
CREATE TABLE documents (
  doc_key      TEXT PRIMARY KEY,   -- el uuid, o una clave sintética si el doc no tiene
  uuid         TEXT,
  page         INTEGER,
  row_index    INTEGER,
  recurso      TEXT,               -- campos de identidad "promovidos" para consultar fácil
  nro_exp      TEXT,
  list_data    TEXT,               -- JSON: los ~9 campos del listado
  resolucion   TEXT,               -- JSON: sección DATOS DE LA RESOLUCIÓN
  proceso      TEXT,               -- JSON: sección DATOS DEL PROCESO
  procedencia  TEXT,               -- JSON: sección DATOS DE PROCEDENCIA
  extra        TEXT,               -- JSON: cualquier campo fuera de esas 3 secciones
  pdf_file     TEXT,               -- nombre del PDF en pdfs/
  pdf_status   TEXT,               -- pending | in_progress | done | failed
  ficha_status TEXT,               -- pending | in_progress | done | failed | na
  attempts     INTEGER,
  last_error   TEXT,
  updated_at   TEXT
);

-- pages: la máquina de estados de la paginación.
CREATE TABLE pages (
  page       INTEGER PRIMARY KEY,
  status     TEXT,                 -- pending | in_progress | done | failed
  row_count  INTEGER,
  attempts   INTEGER,
  last_error TEXT,
  updated_at TEXT
);

-- runs: el historial de ejecuciones (una fila por corrida).
CREATE TABLE runs (
  run_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  site           TEXT,
  command        TEXT,     -- 'scrape' | 'retry-failed'
  started_at     TEXT,     -- cuándo empezó
  finished_at    TEXT,     -- cuándo terminó (null mientras corre)
  status         TEXT,     -- running | completed | interrupted | failed
  corpus_total   INTEGER,  -- total que reporta el sitio para la búsqueda
  pages_done     INTEGER,  -- páginas completadas al cierre de la corrida
  docs_extracted INTEGER,  -- cuántos documentos salieron
  pdfs_done      INTEGER,  -- cuántos PDFs se bajaron
  pdfs_failed    INTEGER,  -- cuántos quedaron fallidos
  pending        INTEGER   -- cuántos faltan por bajar (corpus_total - pdfs_done)
);
```

La idea es simple: **`documents` es la data, `pages` es el progreso, `runs` es el
historial de corridas** (cuándo corrió, cuándo terminó, con qué estado, cuántos
salieron y cuántos faltan). Los 46 campos de cada documento no se guardan como 46
columnas fijas (los dos sitios tienen campos distintos), sino agrupados en
columnas JSON. Eso mantiene el esquema estable para ambos sitios y para cualquier
variación entre documentos.

La tabla `documents` en [DB Browser for SQLite](https://sqlitebrowser.org), con
las columnas de identidad promovidas (`recurso`, `nro_exp`), las de secciones
(`list_data`, `resolucion`, `proceso`, `procedencia`) y las de estado
(`pdf_status`, `ficha_status`):

![Tabla documents en DB Browser](docs/img/documents.png)

### La máquina de estados (el porqué)

Cada unidad de trabajo —una página y un documento— avanza por estados explícitos.
Eso es lo que hace que la reanudación sea **precisa**: al reiniciar se rehace
exactamente lo que **no** quedó en `done`, y si el proceso se muere a mitad de un
ítem, ese ítem queda en `in_progress`, así que se reintenta en vez de saltárselo
en silencio.

```mermaid
stateDiagram-v2
    [*] --> pending
    pending --> in_progress: empieza a procesar
    in_progress --> done: éxito
    in_progress --> failed: se agotaron los reintentos
    failed --> in_progress: retry-failed / re-run
    done --> [*]
```

- **`pending`** — descubierto, todavía no procesado.
- **`in_progress`** — empezó a procesarse (si hay un crash aquí, se reintenta).
- **`done`** — completado con éxito.
- **`failed`** — se agotaron los reintentos; queda registrado para `retry-failed`.
- **`na`** — no aplica (por ejemplo, el estado de la ficha en OEFA, que no tiene modal).

La tabla `pages` durante una corrida — se ve la máquina de estados en vivo: las
páginas terminadas en `done` y la que se está procesando en `in_progress`:

![Tabla pages con una página in_progress](docs/img/pages.png)

Con eso, reanudar es esto (y nada más):

```sql
-- Páginas que faltan:
SELECT page FROM pages WHERE status != 'done';
-- PDFs por (re)intentar, incluidos los que fallaron por 429:
SELECT uuid, pdf_file FROM documents WHERE pdf_status IN ('pending','failed');
```

Los `documents.json` / `.csv` / `state.json` son **exports** derivados de la DB.
Si prefieres abrir la data en Excel, ahí tienes el CSV; si quieres la fuente de
verdad consultable, ahí está la `.db`.

### Ejemplo real de lo que queda guardado

Salida de una corrida real, consultando la DB (2 páginas, 20 documentos):

```text
Estados por página:     [ { status: 'done', n: 2 } ]
Estados de descarga:    pdf:   [ { pdf_status: 'done', n: 20 } ]
Estados de ficha:       ficha: [ { ficha_status: 'done', n: 20 } ]

Un documento (recurso: Casación | nro_exp: 001785-2024):
  RESOLUCION : { fechaDeLaResolucion: "09/07/2026", tipoDeResolucion: "Ejecutoria Suprema",
                 juecesSupremos: "CAMPOS BARRANZUELA, PRADO SALDARRIAGA, PEÑA FARFAN, ...",
                 ponente: "ALTABAS KAJATT DE MILLA", sumilla: "En el caso, solo los ...", ... }
  PROCESO    : { sala: "Sala Penal Permanente", distritoJudicialDeProcedencia: "Callao",
                 especialidad: "Penal", materiaDeLaCausa: "Delitos contra la Libertad",
                 nDeExpedienteDeLaSalaSuperior: "2506-2019-0", ... }
  PROCEDENCIA: { expedienteDeProcedencia: "2506-2019-0", fechaDeDemanda: "", ... }
```

Y la tabla `runs` tras una corrida real de PJ (20 páginas → 200 documentos, 200
PDFs bajados, 0 fallidos, y `pending` = lo que falta del corpus):

![Tabla runs con una corrida de PJ](docs/img/runs.png)

### Estructura de la carpeta de salida

```
output/
├── documents.db     # ← la fuente de verdad (SQLite: documents, pages, runs)
├── documents.json   # export: cada documento (metadata + las 3 secciones de la ficha)
├── documents.csv    # export: lo mismo, aplanado a columnas (secciones con prefijo res:/proc:/proce:)
├── state.json       # export: resumen de progreso (páginas hechas, uuids bajados, fallidos, historial de runs)
├── report.json      # reporte de validación
└── pdfs/            # los PDFs con nombre descriptivo:
                     #   PJ  → "Casación-001785-2024__Resolucion_10_....pdf"
                     #   OEFA→ "264-2012-OEFA-TFA__RTFA N° 264-2012.pdf"
```

### Muestra incluida en el repo

Como PJ está geo-bloqueado a Perú y quien revise puede no tener VPN, el repo
incluye una **muestra real de PJ** en `sample/`: la base `documents.db` (200
documentos con su ficha completa de ~40 campos), más los exports
`documents.json` / `.csv`, `state.json` y `report.json`. Ábrela con
[DB Browser for SQLite](https://sqlitebrowser.org) para ver el resultado sin
correr nada.

De los PDFs, la corrida completa descargó los 200 (así lo confirma
`report.json`), pero versionarlos todos serían ~72 MB de binarios en git, así
que **intencionalmente se commitearon solo 5** en `sample/pdfs/` — suficientes
para abrirlos y comprobar que la descarga funciona de punta a punta y que el
nombre descriptivo (`{recurso}-{expediente}__{archivo}.pdf`) es real. El resto
queda excluido por `.gitignore`.

---

## La ficha completa, por secciones

El reto pide extraer **los datos de cada documento**, y el listado es apenas un
resumen: cada fila tiene un botón **"Ver Ficha"** que abre un modal con ~40
campos más (el colegiado de jueces, ponente, fallo/sentido, distrito judicial,
materia, régimen procesal, N° de expediente de la sala superior, y toda la
historia de procedencia del proceso).

El modal viene organizado en **tres secciones**, y así mismo se guardan (cada una
en su columna JSON):

- **`resolucion`** → *DATOS DE LA RESOLUCIÓN* (fecha, tipo, jueces, ponente, fallo, sumilla, palabras clave…).
- **`proceso`** → *DATOS DEL PROCESO* (sala, distrito judicial, materia, régimen procesal, N° de expediente…).
- **`procedencia`** → *DATOS DE PROCEDENCIA* (fechas de demanda/calificación/origen, fallos previos…).
- **`extra`** → cualquier par etiqueta/valor que aparezca **fuera** de esas tres secciones.

### ¿Y si no todos los modales tienen la misma estructura?

Esa fue la duda de fondo, y el parser está hecho para que **no importe**. No
asume una lista fija de campos: recorre el modal y mete cada par `etiqueta→valor`
bajo el encabezado de sección que lo precede. Consecuencias:

- Si un documento **omite** un campo → simplemente no aparece esa llave (no se rompe).
- Si trae un campo **nuevo** → entra como una llave más en su sección.
- Si aparece algo **fuera** de las tres secciones conocidas → cae en `extra`.

Así, aunque la estructura varíe entre documentos, se captura fielmente lo que
haya y **no se pierde nada**. Un detalle real que esto resuelve: la etiqueta
"Tipo de Resolución" aparece tanto en *DATOS DE LA RESOLUCIÓN* como en *DATOS DE
PROCEDENCIA*; al agrupar por sección, cada una queda en su columna sin pisarse.

---

## Cómo funcionan los sitios (el reverse engineering)

El reto pide descubrir la estructura de cada sitio. Los dos son **JSF (Mojarra)**
sin API REST ni URLs estables: cada interacción es un POST contra una página
`.xhtml` que carga una cookie `JSESSIONID` y un token `javax.faces.ViewState`.
Pero corren frameworks distintos encima de JSF, y las mecánicas divergen lo
suficiente como para ser, en la práctica, dos protocolos. Esta es la parte
jugosa, así que vale la pena detallarla.

### PJ — RichFaces 4.2.2 (el objetivo principal)

Aquí el ViewState es un identificador corto del lado servidor (`123:456`), no un
árbol cifrado. El flujo es JSF clásico, **sin AJAX**:

- **Búsqueda.** GET a `inicio.xhtml` para sacar el ViewState y el formulario
  completo. Luego un **POST del formulario entero** reenviado, más los parámetros
  del botón de "búsqueda general". El servidor responde `302 → resultado.xhtml`.
  *Trampa:* el sitio está detrás de un proxy que termina el TLS y devuelve la
  cabecera `Location` en `http://` después de una petición `https://`; el cliente
  HTTP vuelve a subir el esquema a `https` (`http-client.ts`), si no el redirect
  se rompe.
- **Conteo + paginación.** La página de resultados reporta el total en prosa
  ("se obtuvieron 208341 resultados") y muestra 10 ítems por página. Paginar es
  otro POST del formulario completo que mueve el *spinner* de número de página de
  RichFaces (`formBuscador:spinner`) + su botón "IR" para saltar a cualquier
  página (1-based).
- **Metadata del listado.** Cada resultado es un bloque `formBuscador:repeat:N:...`
  cuyo `onclick` del enlace lleva un objeto JS con ~9 campos (uuid, expediente,
  recurso, sala, fecha, sumilla…). Leemos la metadata directo de ese objeto en
  vez de raspar el panel visual — es más robusto, y `N` es el índice absoluto de
  la fila en todo el corpus. Ese objeto viene **doblemente escapado** en el HTML
  (entidades `&quot;` *y* `\"`), con los guiones como `-`; `parseResults`
  colapsa todo eso.
- **Detalle completo (el modal "Ver Ficha").** Ver [la sección de arriba](#la-ficha-completa-por-secciones).
  Es un AJAX de RichFaces (`render=@component`) que re-renderiza el popup; el
  scraper lo dispara por cada fila y parsea la grilla de etiqueta/valor
  (`fetchDetail` + `parseFicha`). Es una llamada **con estado** (la fila tiene que
  estar en la vista actual), así que las fichas se traen secuencialmente por
  página; si el servidor tira un ViewExpired (es inestable), se re-establece la
  página y se reintenta. Se desactiva con `--skip-details`.
- **Descarga del PDF.** Un simple `GET /jurisprudenciaweb/ServletDescarga?uuid=<uuid>`
  entrega el PDF (`Content-Disposition: attachment`). Sin *arming*, sin ViewState.
- **Inestabilidad.** El servidor de PJ devuelve `500`/`503` intermitentes al
  navegar. Un reintento con el mismo ViewState no los arregla, así que la
  búsqueda/paginación **re-inicializan la sesión** (ViewState fresco) entre
  intentos (`withReinit` en `pj.ts`).

### OEFA — PrimeFaces 6.0 (el alterno sin VPN)

Aquí el ViewState es un blob cifrado de ~1.5 KB, y las interacciones son **AJAX**:

- **Búsqueda.** Un POST AJAX de PrimeFaces (`javax.faces.source = ...btnBuscar`)
  con todos los filtros vacíos. La respuesta es un XML `<partial-response>` cuyos
  nodos `<update>` traen fragmentos de HTML dentro de CDATA — incluido el
  paginador (`Página 1 de 176 (1753 registros)`). Cada respuesta trae un
  ViewState **nuevo** que reemplaza al actual.
- **Paginación.** Otro POST AJAX (`dt_pagination=true`, `dt_first=<offset de fila>`).
  El fragmento es una lista de `<tr>` sueltos, sin tabla padre — los parsers de
  HTML que cumplen el estándar botan las filas huérfanas, una trampa real, así
  que `parseRows` las envuelve en una tabla primero. Los saltos por offset
  funcionan directo, lo que hace barata la reanudación.
- **Descarga del PDF.** Un POST del formulario que emula el enlace de la fila
  (`mojarra.jsfcljs(form, {'form:dt:<n>:j_idt63': …, 'param_uuid': '<uuid>'})`),
  respondido con los bytes del PDF. Una fila solo es "clickeable" mientras su
  página es la que está renderizada; si pides una que la vista no tiene, el
  servidor re-renderiza la página como HTML — que el scraper trata como pérdida
  de vista y recupera.

---

## Arquitectura

```
src/
├── index.ts            # CLI (scrape / retry-failed / export / report, parseo de banderas)
├── scraper.ts          # orquestación: páginas → filas → fichas → descargas; reanudación/recuperación/concurrencia
├── report.ts           # reporte de validación (cobertura, integridad de identidad, chequeo de PDFs)
├── state.ts            # capa de estado sobre SQLite: máquina de estados + exports
├── types.ts            # tipos de dominio compartidos
├── core/               # maquinaria agnóstica del sitio
│   ├── db.ts           # SQLite: esquema (documents/pages/runs) y consultas
│   ├── http-client.ts  # wrapper de axios: cookies, rate limiter, redirects manuales (+upgrade http→https), proxy
│   ├── jsf-session.ts  # encadenado de ViewState, parseo de <partial-response>, POSTs de página, GETs de recurso
│   ├── retry.ts        # backoff exponencial + jitter, Retry-After, clasificación 429/5xx
│   ├── concurrency.ts  # map con concurrencia acotada (pool de workers)
│   ├── proxy.ts        # pool de proxies round-robin opcional (apagado por defecto)
│   ├── cookie-jar.ts   # jar mínimo de cookies de sesión
│   ├── files.ts        # nombres de archivo seguros, escritura atómica de JSON, export a CSV
│   └── logger.ts       # log con niveles y timestamp
└── sites/
    ├── adapter.ts      # el contrato SiteAdapter
    ├── oefa.ts         # OEFA (PrimeFaces): búsqueda/paginación AJAX, descarga por form-POST
    ├── pj.ts           # PJ (RichFaces): búsqueda/paginación por form completo, ficha, descarga por servlet GET
    └── index.ts        # registro de adapters
```

El núcleo se encarga de todo lo que es independiente del sitio: el ciclo de vida
de sesión + ViewState, el retry/backoff, el bucle de paginación, la reanudación,
el almacenamiento en SQLite y la política de "registrar y seguir" en las
descargas. Cada *adapter* se encarga solo de lo que cambia: cómo hacer la
búsqueda, cómo paginar, cómo se mapea una fila a metadata y cómo bajar su PDF.

Que los dos adapters apunten a **frameworks JSF distintos** (PrimeFaces vs
RichFaces) con transportes distintos —respuestas AJAX parciales vs POSTs de
página completa, descarga por form-POST vs GET de recurso— es la verdadera prueba
de esa frontera, y aguanta: ninguno de los dos necesitó tocar el contrato del
núcleo.

### Manejo de errores

Varios tipos de falla, tratados por separado:

| Falla | Detección | Respuesta |
| --- | --- | --- |
| **HTTP 429** | código de estado | Respeta `Retry-After` si viene (RFC 9110 — también parseado para 503); si no, backoff exponencial `1s → 2s → 4s → 8s → 16s` (±20 % de jitter, tope 60 s). Tras 5 intentos, el documento queda como `failed` en la DB y el scraper sigue. `retry-failed` lo reprocesa. |
| 5xx transitorios / errores de red | estado / sin respuesta | Misma política de backoff, en **toda** petición: la navegación (init, búsqueda, paginación) se reintenta en la capa de sesión JSF; las descargas, en el orquestador. |
| **500s de servidor inestable (PJ)** | estado tras el backoff | Los 500 de navegación de RichFaces que un reintento con el mismo ViewState no arregla disparan una re-inicialización de sesión (ViewState fresco) y reintento — `withReinit` en `pj.ts`. |
| **Expiración de sesión / vista** | error/redirect en el partial-response, o HTML donde se esperaba un PDF | Re-inicializa la sesión, rehace la búsqueda, re-pagina hasta la página actual, reintenta una vez. |
| **Página que devuelve 0 filas** | 0 filas con corpus no vacío | Se marca `failed` (no `done`), para que una corrida posterior la re-baje en vez de perder esos documentos. |
| Interrupción (Ctrl+C) | SIGINT | Termina el documento en curso, guarda el estado, sale. Al re-correr reanuda: salta las páginas `done` y nunca re-baja un uuid ya descargado. |

Las escrituras de los exports son atómicas (a archivo temporal + rename), y la
DB commitea cada operación, así que un crash no corrompe la data de reanudación.
Todo lo que llega se valida antes de confiar en ello: los archivos descargados
tienen que empezar con `%PDF-`, y los partial-response tienen que traer los nodos
esperados.

### Cortesía, concurrencia y proxies

Los **inicios** de petición se espacian con un delay configurable (600 ms por
defecto) mediante un rate limiter chiquito, así que incluso con concurrencia el
scraper nunca ráfaguea. Son servidores públicos compartidos y el reto premia
explícitamente no martillarlos.

**Concurrencia (`--concurrency N`, default 1).** Las descargas pueden correr en
un pool acotado, pero solo donde de verdad es seguro. La restricción interesante
es el ViewState: muta en cada POST de navegación, así que **la paginación no se
puede paralelizar dentro de una misma sesión** — dos peticiones de página
concurrentes se corromperían la vista. Las descargas son distintas según el
sitio, y cada adapter declara su capacidad:

- **PJ** — `ServletDescarga?uuid=` es un GET sin estado (solo la cookie + el
  uuid), así que las descargas paralelizan sin problema.
- **OEFA** — la descarga es un form-POST que necesita la fila renderizada en la
  vista actual, así que se queda secuencial pase lo que pase con `--concurrency`.

**Nota honesta sobre velocidad:** para estos objetivos los PDFs son grandes
(hasta ~13 MB) y el enlace (por VPN, en el caso de PJ) está limitado por ancho de
banda, así que las descargas en paralelo se reparten el mismo tubo — la ganancia
acá es marginal. La concurrencia rinde cuando el cuello de botella es la latencia
(muchas peticiones chiquitas), no el ancho de banda. Está construida, es
correcta y viene apagada por defecto; el valor es el **diseño consciente del
framework**, no una promesa de velocidad a ciegas.

**Paginación en paralelo (`--page-concurrency N`, default 1).** Como la
paginación no se puede paralelizar *dentro* de una sesión (el ViewState), la vía
para paralelizarla es tener **varias sesiones independientes**, cada una con su
propio ViewState. Con `--page-concurrency N` se levantan N sesiones que sacan
páginas de una **cola compartida** (el que está libre toma la siguiente), y
**comparten un solo rate limiter**, así que aunque uses 5 sesiones el ritmo
global hacia el servidor sigue siendo el mismo (no lo vuelve un martillo). Es la
versión "en un proceso" del sharding horizontal que describo en
[En producción](#en-producción-cómo-escalaría-esto). Apagada por defecto: son
servidores gubernamentales inestables y multiplicar sesiones hay que pedirlo a
conciencia.

**Recomendación de uso (según pruebas reales):**

- **PJ** → `--page-concurrency 1` o `2`. Su servidor es inestable (tira `500`/`503`
  seguido); con 3+ sesiones se dispara la carga de navegación y el servidor
  buckea más — el scraper se recupera de todos los 500 (0 documentos perdidos),
  pero la corrida se vuelve más lenta y ruidosa. La ganancia real en PJ viene de
  **`--concurrency 10`** (descargas en paralelo, GETs sin estado), no de paginar
  en paralelo.
- **OEFA / un servidor estable** → puedes subir `--page-concurrency` (3–5) sin
  problema; ahí sí rinde.
- Regla simple: **paralelizar descargas (`--concurrency`) casi siempre ayuda;
  paralelizar páginas (`--page-concurrency`) solo si el servidor lo aguanta.**

**Rotación de proxies (`--proxies <file>`, apagado por defecto).** Estos
objetivos no tienen anti-bot por IP, así que el scraper va directo. La capacidad
está cableada detrás de una interfaz limpia (`core/proxy.ts`, round-robin sobre
una lista, un proxy por petición, sostenido a través de los redirects) para el
día en que el mismo motor apunte a un sitio que sí limita por IP — usando el
soporte de proxy nativo de axios, sin dependencia extra. Se activa con un archivo
de líneas `http://user:pass@host:port`.

### Validación (sanity check antes de entregar)

Cada scrape termina con un reporte de validación — y `report` lo regenera contra
una corrida existente. Es el paso de "revisar que la data tiene sentido antes de
entregarla" que pide el reto, y chequea:

- **Cobertura** — documentos extraídos vs el total del corpus, páginas completadas.
- **Integridad de identidad** — los campos que deben existir en todo documento
  (p. ej. `recurso` + `nroexp` en PJ) se alertan si bajan del 100 % — una señal
  rápida de una regresión de parseo. Los campos genuinamente opcionales (una
  sumilla, una lista de palabras) se muestran pero nunca se alertan, para que el
  reporte no llore lobo.
- **Duplicados** — uuids repetidos entre los documentos extraídos.
- **Integridad de PDFs** — se confirma que **todos** los documentos marcados como
  descargados tienen su archivo en disco, y una muestra se chequea además por la
  cabecera `%PDF-` y un tamaño no trivial.
- **Fallidos** — cuántas descargas quedan en la lista de reintentos.

Y al terminar cada corrida se imprime un bloque de resumen con los números de la
tabla `runs`:

```text
════════════ Run summary ════════════
  Pages completed:  176/176
  Documents:        1753
  PDFs:  OK 1751  ·  failed 2  ·  pending 0
  Status:           completed
══════════════════════════════════════
```

```text
Validation report — pj
  Corpus total:        208331
  Documents extracted: 20 (0% of corpus)
  Pages completed:     2
  Unique uuids:        20
  PDFs downloaded:     20 (sample valid: 20/20)
  PDFs failed:         0
  Metadata coverage:
    normaDI              5%  (1/20)
    sumilla             30%  (6/20)
    palabras            35%  (7/20)
   *recurso            100%  (20/20)
   *nroexp             100%  (20/20)
    pretensiones       100%  (20/20)
    ...
    (* = campo de identidad, debe ser 100%)
  ✓ No consistency issues found.
```

Una corrida real de PJ con `--concurrency 20` (20 páginas → 200 PDFs): el bloque
de resumen y el reporte de validación al final, con `PDFs missing/disk: 0` y sin
inconsistencias:

![Corrida de PJ con el resumen y el reporte de validación](docs/img/terminal-run.png)

---

## Docker

Para que corra **idéntico en cualquier máquina** (misma versión de Node, mismas
dependencias, sin "en mi PC sí funciona") hay un `Dockerfile` multi-stage: una
etapa compila el TypeScript y otra deja solo las dependencias de runtime + el
`dist/`.

```bash
# Construir la imagen
docker build -t scraper-jurisprudencia .

# OEFA (sin VPN), guardando la salida en ./output del host
docker run --rm -v "$(pwd)/output:/data" scraper-jurisprudencia \
  scrape --site oefa --out /data

# Cualquier otro comando (report, export, retry-failed…)
docker run --rm -v "$(pwd)/output:/data" scraper-jurisprudencia report --out /data
```

**Ojo con PJ:** el contenedor resuelve la portabilidad, **no** el geo-bloqueo.
Para `--site pj` sigues necesitando salir por Perú: la red del host con VPN de
Perú (`--network host` en Linux) o pasarle proxies peruanos con `--proxies`.
OEFA no necesita nada de eso.

## En producción: cómo escalaría esto

Tal como está, el scraper corre en una máquina y guarda todo local (SQLite + PDFs
en disco). Es lo correcto para el reto. Si esto alimentara una base de
jurisprudencia de verdad —refrescada a diario, con millones de documentos— así lo
llevaría a producción.

### 1. Conectarlo al pipeline existente (buckets + DB central)

Hoy la fuente de verdad es `documents.db` y los PDFs viven en `output/pdfs/`. En
prod eso pasa a infraestructura compartida:

- **PDFs → object storage** (GCS / S3). En vez de escribir a disco, cada PDF se
  sube a un bucket (`gs://jurisprudencia-pe/pj/<uuid>.pdf`) y en la DB se guarda
  la ruta del objeto, no el nombre de archivo local.
- **Metadata → una DB gestionada** (Postgres, o BigQuery si el consumo es
  analítico). La SQLite se vuelve un Postgres central: la misma forma de tablas
  (`documents` / `pages` / `runs`), pero compartida por todos los workers.

Lo bueno es que **el scraper casi no cambia**: `state.ts` es la única capa que
toca el almacenamiento. Pasar de SQLite → Postgres y de disco → bucket es
reescribir esa capa (otra implementación de `Db` + un *uploader* de PDFs), no la
lógica de scraping. Ese es justamente el motivo de tener el almacenamiento
aislado detrás de `state.ts`.

### 2. Proxies rotativos peruanos

PJ está **geo-bloqueado a Perú**, así que en prod no dependería de una VPN manual
sino de un pool de **exit nodes peruanos**. El dato clave de este portal: en el
recon **no vi anti-bot por IP** (ni Akamai, ni PerimeterX, ni rate-limit por IP),
solo el geo-bloqueo. Eso cambia mucho el cálculo de costo:

| Tipo de proxy | Velocidad | Costo aprox. | ¿Sirve para PJ? |
|---|---|---|---|
| **Datacenter PE** | Rápido | ~US$0.5–2 / IP-mes | ✅ **Sí** — solo hay que estar geo-en-Perú; sin anti-bot no toca "parecer humano". |
| **Residencial PE** | Lento | ~US$5–15 / GB | Overkill aquí — se justificaría solo si el portal empezara a bloquear datacenter. |
| **Móvil PE** | Muy lento | ~US$20–50 / GB | Innecesario para este caso. |

O sea: para PJ bastan **proxies datacenter peruanos** (baratos y rápidos), porque
el único requisito es la geo. La arquitectura ya está lista (`--proxies`,
`core/proxy.ts`: round-robin, un proxy por request, sostenido entre redirects);
en prod solo se puebla la lista con los exit nodes PE, y si algún día apareciera
un límite por IP, la rotación diluye el rate repartiendo las peticiones entre
muchas IPs.

### 3. Volverlo un servicio en la nube (Cloud Run)

Empaquetado en un contenedor, corre como **Cloud Run Job** (batch) disparado por
**Cloud Scheduler** para el refresco diario. El truco de escala es el **sharding**:

- Las 20.835 páginas de PJ se reparten en rangos y se lanzan N tareas en paralelo
  (Cloud Run Jobs con `--tasks N`), cada una tomando su rango.
- Cada tarea tiene su **propia sesión JSF** (su propio ViewState), así que la
  restricción de "no paralelizar la paginación dentro de una sesión" no aplica
  *entre* workers — cada uno pagina lo suyo.
- Todos escriben al **Postgres central**, y la máquina de estados coordina: un
  worker toma páginas `pending`, las marca `in_progress`, y si se muere, otro las
  retoma (el `SELECT ... WHERE status != 'done'` ya está pensado para eso).

### 4. Más concurrencia (horizontal, no solo vertical)

Hoy la concurrencia está topada por el ancho de banda de una sola VPN. En cloud,
con IP peruana nativa y varios workers, se escala **horizontalmente**: en vez de
10 descargas concurrentes en 1 proceso, 50 tareas × 10 = 500 descargas en
paralelo, cada una con su sesión y su propio tubo de red. El rate-limiter
por-worker sigue evitando martillar al servidor desde una misma IP.

### 5. Logs y observabilidad

- **Logs estructurados en JSON** (en vez de texto) → Cloud Logging, filtrables por
  `run_id`, `uuid` o página.
- **Métricas**: páginas/min, PDFs/min, tasa de 429, fallidos, latencia por
  request → Prometheus / Cloud Monitoring, con **alertas** (p. ej. "429 > 5 % en
  5 min", o "0 páginas nuevas en 10 min" = algo se rompió).
- La **trazabilidad por documento ya existe**: cada fila guarda `attempts` y
  `last_error`, así que sabes exactamente por qué falló cada PDF.

## Agregar un sitio nuevo

Implementa el contrato `SiteAdapter` (`src/sites/adapter.ts`) — `search`,
`fetchPage`, `downloadPdf`, `pdfFileName` (y opcionalmente `fetchDetail`) — y
regístralo en `src/sites/index.ts`. El núcleo (sesión, ViewState, reintentos,
reanudación, SQLite, orquestación) se reutiliza tal cual. `oefa.ts`
(PrimeFaces/AJAX) y `pj.ts` (RichFaces/form completo) son las dos
implementaciones de referencia — arranca de la que se parezca más a tu objetivo.

## Tests

```bash
npm test
```

42 tests unitarios (con el runner incorporado de Node, sin dependencias extra)
cubren la lógica pura contra *fixtures* capturados de **ambos** sitios en vivo
— incluida una respuesta **real** del modal "Ver Ficha" (`tests/ficha-real-response.xml`,
capturada tal cual del sitio) que valida el parseo de la ficha de punta a punta:

- **OEFA:** parseo de partial-response (incluido el escape de CDATA partido de
  JSF para el `]]>` literal), extracción de filas de las dos formas de fragmento.
- **PJ:** extracción de metadata + uuid del enlace de descarga doblemente
  escapado de RichFaces (incluido un valor que contiene comillas — una trampa
  real), el índice de fila absoluto `repeat:N`, cosecha de campos del formulario,
  elegir el botón de búsqueda general sobre el especializado, y el parseo del
  modal "Ver Ficha" agrupado en sus **tres secciones** (etiquetas con acentos
  convertidas a slug, valores vacíos preservados, etiquetas repetidas dentro y
  entre secciones que no se pisan).
- **Almacenamiento (SQLite):** la máquina de estados y la reanudación (el estado
  persiste al reabrir la DB), el registro de fallidos, que un re-scrape nunca
  pierda una descarga ya hecha, el export a JSON/CSV en UTF-8 con las columnas de
  secciones, y que se niegue a mezclar dos sitios en una misma carpeta.
- **Compartido:** semántica de 429/backoff/Retry-After (incl. 503), agotamiento
  de reintentos con conteo exacto de intentos, manejo de cookies, escape de CSV,
  Content-Disposition y saneo de nombres de archivo, el pool de concurrencia
  acotada, y el parseo de proxies.

## Compilar

```bash
npm run build   # compila a dist/
npm start       # corre el CLI compilado
```
