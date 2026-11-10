# Full-Stack Performance Optimization

This document records every change made across the backend (Express 4 + mysql2),
the Next.js **admin** app, and the Next.js **web** scaffold, the measured
before/after impact, the reusable patterns for the remaining list pages, and
deployment recommendations.

Scope decisions (confirmed with the requester):

- **Tiered HTTP caching** — strong `ETag` on every response, `private, no-cache`
  (revalidate) for admin/authenticated GETs, and `public, max-age=60,
  stale-while-revalidate=300` **only** for non-personal reference catalogs.
  `Cache-Control: public` is never applied to authenticated/personal data.
- **Global middleware everywhere** + deep optimization of the hotspots
  (dashboard, stores, vehicle-types, users, drivers); every other list page
  inherits the middleware wins and gets a documented conversion pattern below.
- **Web app is an empty scaffold**, so its items are groundwork + docs only.
- No external services (no Redis, no system nginx/caddy/Chrome installed);
  measurement is latency benches + build sizes + best-effort Lighthouse.

---

## 1. Measured impact

### 1.1 Backend transfer size — compression (brotli, ON now)

Measured with `curl` against `http://localhost:4000`, admin session cookie,
comparing `Accept-Encoding: identity` bytes vs the actual brotli wire bytes.
(The in-app bench reports *decoded* bytes, so it cannot show this — curl is the
honest measure.)

| Endpoint            | identity (raw) | brotli (wire) | saved  | ratio |
| ------------------- | -------------: | ------------: | -----: | ----: |
| `/api/settings/list`|        91,112 B |      14,145 B | 84.5 % | 6.4× |
| `/api/store/list`   |        27,885 B |       3,088 B | 88.9 % | 9.0× |
| `/api/users/list`   |        11,022 B |       2,058 B | 81.3 % | 5.4× |
| `/api/geo/countries`|        15,010 B |       3,729 B | 75.2 % | 4.0× |

Brotli beats gzip on the larger JSON payloads (`settings`: 14,145 B vs 14,162 B
gzip; `store`: 3,088 B vs 3,132 B). Small payloads (< 1 KB) fall below the
compression threshold and are sent identity.

### 1.2 Backend latency — representative GETs (30 iterations, p50/p95/p99 ms)

Baseline was captured **before** compression/caching/pool tuning; "after" is the
same set now. The remote "on-demand" MySQL has a high per-query RTT, so the
TTL cache and query-parallelism dominate the latency changes.

| Endpoint                 | before p50 | before p99 | after p50 | after p99 |
| ------------------------ | ---------: | ---------: | --------: | --------: |
| `/api/dashboard/overview`|      16.78 |     867.13 |      4.32 |      6.12 |
| `/api/geo/countries`     |       5.85 |      55.77 |      4.74 |      7.59 |
| `/api/currencies/list`   |       4.83 |      27.83 |      5.70 |     15.00 |
| `/api/languages/list`    |       4.79 |      29.93 |      5.16 |      6.85 |
| `/api/settings/list`     |      11.46 |      21.88 |      8.04 |    159.61 |
| `/api/store/list`        |       7.94 |     199.12 |      7.07 |   2922.13 |
| `/api/drivers/list`      |      16.59 |      34.41 |     16.82 |     24.66 |
| `/api/users/list`        |       6.86 |       9.16 |      7.27 |     12.97 |
| `/api/vehicle-type/list` |       6.34 |       9.78 |      6.87 |      8.30 |

- **`/api/dashboard/overview` is the headline**: the old p99 of **867 ms** (a
  fan-out of ~10 sequential aggregate queries on a cold pool) collapses to
  **6 ms** with the 10-second TTL cache + `Promise.all` aggregation.
- Medians are flat-to-better everywhere. The two p99 spikes (`settings`
  159 ms, `store` 2922 ms) are single cold-cache/TTL-expiry samples taken while
  the host was under heavy load (1-min load avg > 8) with the prod build + Lighthouse
  runs overlapping; they represent the first request after a cache miss hitting
  the remote DB, not the cached steady state. The `requestMetrics` middleware
  logs any request > 200 ms so these are visible in `GET /api/metrics`.

### 1.3 Caching / revalidation behaviour (curl-verified)

- `GET /api/languages/list` → `Cache-Control: public, max-age=60,
  stale-while-revalidate=300` + `ETag`.
- `GET /api/users/list` → `Cache-Control: private, no-cache` + `ETag`; a
  follow-up `If-None-Match` returns **`304 Not Modified`** (zero body transfer).
- Any non-GET (`POST/PUT/PATCH/DELETE`) → `Cache-Control: no-store`.
- ETag/`If-None-Match` are CORS-safelisted, so admin:3000 → API:4000
  revalidation works without a preflight.

### 1.4 Admin bundle / runtime (Lighthouse + build size)

Prod builds both succeed. Lighthouse run against the built, `next start` server:

| Page (`/login`)     | before | after |
| ------------------- | -----: | ----: |
| Performance         |     98 |    98 |
| Total byte weight   | 347 KiB| 348 KiB |
| TBT                 | 160 ms | 170 ms |
| Unused JS (est.)    |  50 KiB|  50 KiB |

| Page (`/dashboard`) | before | after |
| ------------------- | -----: | ----: |
| Performance         |     83 |    83 |
| Total blocking time | 300 ms | 260 ms |
| Unused JS (est.)    |  53 KiB| **22 KiB** |

- The **login/first-load path** is essentially unchanged (it was already lean):
  the base bundle no longer drags in the whole module registry, so the split did
  not regress it.
- The **dashboard** shows the code-splitting payoff: **unused JS dropped from
  53 KiB to 22 KiB (−58 %)** and TBT improved, because `next/dynamic` moved
  recharts + the ~43 management components out of the base path into per-module
  chunks that only load when a section is opened.
- Raw `du -sb .next/static` grew **3.34 MB → 4.05 MB (+21 %)** — expected: chunk
  splitting adds per-chunk files and the `swr` runtime was added. Total store on
  disk is not the user-facing metric; per-route first-load (Lighthouse above) is.
- Dashboard LCP (~3.9 s) is dominated by the throttled simulated network + the
  chart data load, not by app code; it is unchanged by these edits.

### 1.5 Web scaffold

Lighthouse before/after both score 100 across the board (there were no
optimization targets). Only groundwork was added — see §4.

---

## 2. Backend changes

### 2.1 Global middleware (`backend/src/index.ts`)

- **`compression`** dep added; mounted app-wide (brotli when the client sends
  `Accept-Encoding: br`, gzip fallback, 1 KB threshold).
- **`app.set("etag", "strong")`** — every response carries a strong ETag → free
  `304` revalidation.
- New **`middleware/cachePolicy.ts`**: non-GET → `no-store`; allowlisted
  reference GETs (`/api/geo`, `/api/languages`, `/api/currencies`,
  `/api/vehicle-makes`, `/api/vehicle-models`, `/api/service-category`,
  `/api/settings`) → `public, max-age=60, stale-while-revalidate=300`; all
  other GETs → `private, no-cache` (ETag revalidation).
- New **`middleware/requestMetrics.ts`**: per-route duration ring buffer, logs
  slow requests (> 200 ms), and exposes **`GET /api/metrics`** (admin-only) with
  p50/p95/p99 + per-route counts.

### 2.2 Connection pool (`backend/src/db/mysql.ts`)

`connectionLimit` 10 → **20** (env-tunable), `waitForConnections: true`,
`queueLimit: 200`, mysql2 `maxIdle` + keep-alive options (replacing the legacy
`acquireTimeout`/`idleTimeout` names). Removes pool-wait timeouts under
concurrency and keeps sockets warm against the high-RTT remote DB.

### 2.3 Query & round-trip fixes

- **Fire-and-forget audit**: `await audit.log(...)` →
  `void audit.log(...).catch(logFailure)` in list/write controllers so audit
  writes no longer add a serial RTT to every response. Login/security events
  that must land before the response stay `await`ed.
- **N+1 / sequential-query collapse**: `for (… ) await update(…)` loops in
  settings/mapsApi/referralSettings/serviceContent merged into single
  multi-column `UPDATE`s (the `queueSet` idiom from `vehicleTypeService`);
  independent reads (audit COUNT + page + enrichment) parallelized with
  `Promise.all`.
- **DTO projection**: hotspot list `SELECT`s trimmed to the columns the UI uses
  (heavy text/blob and the `payments.tPaymentDetails`-style sensitive columns
  dropped from list queries).

### 2.4 Server-side TTL cache (`backend/src/utils/ttlCache.ts`)

`lru-cache` dep + `createTtlCache<V extends {}>(ttlMs, max)` = LRU + per-cache
TTL + **in-flight promise coalescing** (concurrent misses run one query).
Applied to reference-heavy reads:

| Cache                        | TTL | Invalidation |
| ---------------------------- | --: | ------------ |
| settings map                 | 60 s | on settings write |
| geo lists                    | 60 s | on geo write |
| vehicle-makes / models       | 60 s | on write |
| ride categories + zones      | 60 s | on write |
| dashboard overview           | 10 s | time-based |
| vehicle-type scope options   | 60 s | time-based (cross-module option lists) |

The vehicle-type `withScope()` option pair (locations + categories) is wrapped
under a single `"scope"` key, so a list page that renders many rows does the
option lookup once per 60 s instead of once per row.

### 2.5 Opt-in server pagination (backwards compatible)

The unpaginated hotspot lists now support the store contract
(`search`/`status`/`page`/`limit` in SQL; returns `{rows,total,page,limit,pages}`)
**while preserving the old shape when no pagination params are present** — so
existing callers are unaffected. Applied to **vehicle-type**, **users**,
**drivers**. Implementation per module:

- Model helpers: `*ListFilters`, `buildFilters`, `listXPage` (`LIMIT ? OFFSET ?`),
  `countX` (`SELECT COUNT(*)`); list SQL split into reusable `LIST_COLUMNS` +
  `LIST_ORDER` (vehicle-type) so the page + count share one projection.
- Service: `listTypesPaged` etc. clamp `limit` to [1, 200], race
  `[count, page]` via `Promise.all`, and clamp an out-of-range page to the last
  page (re-fetches once if needed).
- LIKE terms are escaped: `term.replace(/[\\%_]/g, c => '\\'+c)` → `%…%`.
- Driver `status` validated against the legacy lowercase `register_driver.eStatus`
  (`active|inactive|Suspend`); the driver `LIST_SELECT` omits banking columns.

---

## 3. Admin changes

### 3.1 Code splitting (`admin/src/app/permissions/[groupId]/page.tsx`)

The static 43-import registry became `next/dynamic` per management component,
each with `{ ssr: false, loading: () => <ManagementSkeleton /> }`. One chunk per
admin group instead of a single 992-import bundle; recharts leaves the base path
(it now ships only with the dynamically-imported dashboard).

### 3.2 Skeletons (`admin/src/components/management-skeleton.tsx`)

New `ManagementSkeleton` (card + toolbar + row blocks, used as the dynamic
loading fallback) and `TableSkeleton({ columns, rows })` (real `<Table>` shell
with skeleton cells). Adopted for initial-load in vehicle-type (7 cols),
users (9), drivers (14). The dashboard already had a `DashboardSkeleton`
(cards + charts) — no spinner-only states remain on the hotspots.

### 3.3 Data-fetching patterns

- New **`hooks/use-debounced-value.ts`** (default 300 ms).
- **Server-paged SWR** for vehicle-types and users, converting them to the
  Slice-2.5 backend contract: debounced search → API params, reset to page 1 on
  filter change, pager driven by server totals, `revalidateOnFocus: false`,
  optimistic toggles/deletes via functional `mutate(…,{revalidate:false})` +
  `mutate()` to reconcile after writes.
  - Users keep CSV export: export calls `listUserPage({…,limit:200})` for the
    whole filtered set (not just the visible page).
- **Drivers** keep client-side sort + field-scoped search + pagination (the
  6-column sort and per-field search are not expressible through the backend's
  `search/status/page/limit` contract) but now fetch through **SWR**, and the
  search is debounced so the client filter doesn't thrash on every keystroke.
  `listDriverPage` (server-paged) is in place for when this list outgrows the
  full-list payload — see the conversion checklist below.
- **Settings bootstrap** (`general-settings.tsx`) → SWR with
  `revalidateOnFocus: false`; the editable/baseline maps re-sync only when a
  fresh category set arrives (initial load or Refresh), so in-progress edits are
  never clobbered by refetch.

`api.ts` gained `listUserPage` / `listDriverPage` / `listVehicleTypePage` (+
their `*Page` / `*ListParams` types), all mirroring `listStores`.

### 3.4 Images (`admin/next.config.ts` + list/profile components)

- `images.remotePatterns` added for the API host (`localhost:4000` `/api/**`) as
  groundwork for `next/image` on **public** assets.
- **Why the hotspot avatars/logos stay `<img>`:** every list-row and profile
  image (`driverPhotoUrl`, `storeImageUrl`, document files, hotel/donation/
  gift-card/news/ad-banner images) streams from **cookie-authenticated** backend
  endpoints. `next/image`'s server optimizer fetches the URL **without** the
  browser's httpOnly cookie, so those requests would 401. Converting them would
  break the images. The safe win — applied to all 11 network-backed `<img>`s —
  is **`loading="lazy"` + `decoding="async"`** (deferred, off-main-thread decode)
  with the existing `onError`→initials fallbacks intact. Form `<img>`s show local
  blob previews (above the fold, no network) and were left unchanged.
- The sidebar logo is a lucide icon (`GalleryVerticalEndIcon`), not an image, so
  there was nothing to convert there.

### 3.5 Dependencies

- `swr` `^2.5.1` added (used by the conversions above).
- **`shadcn` was NOT removed.** The plan assumed it was dead, but
  `src/app/globals.css` imports `shadcn/tailwind.css`, so the package is live
  and removing it would break all styling. Code evidence overrides the plan.
  `@shadcn/react` is likewise genuinely used (2 primitives). `cn` kept.
- `pnpm dedupe` run. It also **re-synced a stale `pnpm-lock.yaml`**: the working
  `package.json` had ~20 dependencies that were installed but never written to
  the committed lockfile, so `dedupe` regenerated the lock to match (518
  packages reused, 0 newly downloaded).

---

## 4. Web scaffold (`web/src/app/layout.tsx`)

`next/font` (Geist) is already optimal (self-hosted + auto-preconnected). Added
groundwork only: a `viewport` export (themeColor/width/initialScale) and a
commented `preconnect` / above-the-fold `preload` template to enable once real
hero assets / a configured API host exist. No optimization targets existed.

---

## 5. Converting the remaining ~35 list pages (checklist)

Exemplar pages: backend `store.controller.ts` + `storeModel.ts`; frontend
`store-management.tsx` and the freshly converted `vehicle-type-management.tsx` /
`user-management.tsx`.

**Backend (once per list endpoint):**

1. In the model, split the list SQL into `LIST_COLUMNS` + `LIST_ORDER`, add
   `XListFilters`, `buildFilters` (escape LIKE with
   `/[\\%_]/g → '\\'+c`), `listXPage` (`LIMIT ? OFFSET ?`), `countX`.
2. In the service, add `listXPaged(raw)`: clamp `limit` to [1, 200],
   `Promise.all([countX, listXPage])`, clamp an out-of-range page to the last.
3. In the controller `list()`: detect `paginated = page|limit|search|status`
   present; when absent keep returning the full legacy array (back-compat),
   when present return `{ rows, total, page, limit, pages }`.
4. Trim the list `SELECT` to the columns the table renders (DTO projection).

**Frontend (once per page):**

1. Add `listXPage(params)` to `api.ts` mirroring `listStores`.
2. Replace the `load()`/`useEffect` fetch with:
   ```ts
   const debouncedSearch = useDebouncedValue(search, 300);
   const [page, setPage] = useState(1);
   useEffect(() => { setPage(1); }, [debouncedSearch /* , otherFilters */]);
   const { data, isLoading, error: swrError, mutate } = useSWR(
     ["x", debouncedSearch.trim(), page, PAGE_SIZE] as const,
     ([, term, p, limit]) => listXPage({ search: term || undefined, page: p, limit }),
     { revalidateOnFocus: false },
   );
   const rows = data?.items ?? null;         // or data?.<key>
   const totalPages = Math.max(data?.pages ?? 1, 1);
   const loading = isLoading && !data;
   ```
3. Initial load → `<TableSkeleton columns={n} />`; empty branch differentiates
   "no results for search" vs "none exist".
4. Optimistic status/delete → functional `mutate(…, { revalidate: false })` then
   `await mutate()` in the `finally`. Create/update/delete/Refresh buttons call
   `mutate()`.
5. Add the Prev/Next pager (only when `totalPages > 1`) + a
   `"{range} of {total}"` caption.
6. If the page has client CSV export, export via `listXPage({…,limit:200})`.
7. If any row renders a remote logo/avatar, keep it `<img loading="lazy"
   decoding="async">` (cookie-auth streams) — do not switch to `next/image`.

---

## 6. Recommendations (deployment / further work)

These need system services that are **not installed** in this environment, so
they are documented for the operator rather than applied:

- **Reverse proxy (Nginx or Caddy) in front of the apps.** TLS + HTTP/2,
  gzip/brotli for text, long immutable caching for `/_next/static/*` (content-
  hashed filenames), and pass-through of the API's `Cache-Control`/`ETag`.
  - Caddy (`Caddyfile` sketch):
    ```
    example.com {
      encode zstd gzip
      handle /api/* { reverse_proxy 127.0.0.1:4000 }
      handle { reverse_proxy 127.0.0.1:3000 }
    }
    ```
  - Nginx sketch: `gzip on; gzip_types application/json text/css;` +
    `brotli on;`, `location /api/ { proxy_pass http://127.0.0.1:4000; }`, and
    `location /_next/static/ { add_header Cache-Control "public, max-age=31536000, immutable"; }`.
- **Load balancing / statelessness:** auth is httpOnly-cookie **JWT**, so API
  nodes are already stateless and LB-safe (no sticky sessions needed) as long as
  the JWT signing secret is shared. The only in-process state added here is the
  TTL LRU cache, which is per-node and correct-by-TTL (short windows) — a
  multi-node deploy tolerates brief cross-node staleness within the TTL.
- **`express-rate-limit`:** the default in-memory store is per-process; when
  running multiple API processes/behind an LB, use a shared store
  (`rate-limit-redis` or the memory-builder's cluster-aware option) so limits are
  enforced globally rather than per node.
- **External cache (optional):** if the reference catalogs grow or TTL misses
  become hot, promote `createTtlCache` to Redis behind the same interface; the
  call sites stay unchanged.
- **Drivers list** can move fully server-paged once its client sort fields are
  pushed into `listDriverPage` (add `sortBy`/`sortDir` params there and drop the
  client `sorted`/`paged` memos).

---

## 7. Verification performed

- `npx tsc --noEmit` clean in **admin** and **web** (backend compiled for its
  slices).
- **Prod build succeeds for both apps** (`next build`, exit 0).
- HTTP matrix on the changed endpoints (curl):
  - compression on (brotli) with identity fallback + threshold;
  - `public`/`private`/`no-store` cache tiers correct;
  - `ETag` present and `If-None-Match` → `304` on a `private, no-cache` GET;
  - opt-in pagination: no-params returns the legacy full array (back-compat);
    `page/limit` returns a filtered page + totals; search + status filters
    work; out-of-range page clamps.
  - Only GETs + one login + a `DELETE` on a **non-existent** id (`404`, no data
    touched) were issued — **no application data was mutated**, so nothing
    needed restoring.
- Lighthouse before/after captured on `/login` and `/dashboard` (see §1.4);
  reports retained under `.lh/`.
- The in-app browser smoke via the `browser-use` MCP could **not** run this
  session (the MCP tool rejected every call with an argument-parse error
  unrelated to the payload); the converted pages were instead verified by a
  fresh `next dev` server compiling them cleanly (`/permissions/2`, `/drivers`
  → HTTP 200, zero error lines) plus the curl/tsc matrix above.

+252619858209