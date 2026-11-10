import type { NextFunction, Request, Response } from "express";

/**
 * Tiered HTTP caching for the admin API (all responses are behind auth):
 *
 * - Mutations (anything but GET/HEAD): `no-store` — never cache a write result.
 * - Reference-data GETs (geo lists, languages, currencies, vehicle makes/models,
 *   service categories, settings): short public freshness. The payloads are
 *   non-personal catalogs; listing rows look alike for every admin, and the
 *   permission gates on these routes are broad "view/manage" flags. A 60s TTL
 *   with stale-while-revalidate lets a future CDN absorb the repeat traffic.
 * - Everything else (per-admin, RBAC-scoped or user-specific data):
 *   `private, no-cache` — the browser stores the document but must revalidate,
 *   and the strong ETag Express emits turns revalidations into free 304s.
 */

const SAFE_METHODS = new Set(["GET", "HEAD"]);

/** Reference catalogs that are safe to serve from shared caches briefly. */
const PUBLIC_REFERENCE_PREFIXES = [
  "/api/geo",
  "/api/languages",
  "/api/currencies",
  "/api/vehicle-makes",
  "/api/vehicle-models",
  "/api/service-category",
  "/api/settings",
];

export function cachePolicy(req: Request, res: Response, next: NextFunction) {
  if (!SAFE_METHODS.has(req.method.toUpperCase())) {
    res.setHeader("Cache-Control", "no-store");
    return next();
  }

  const isPublicRef = PUBLIC_REFERENCE_PREFIXES.some(
    (p) => req.path === p || req.path.startsWith(`${p}/`),
  );
  res.setHeader(
    "Cache-Control",
    isPublicRef ? "public, max-age=60, stale-while-revalidate=300" : "private, no-cache",
  );
  next();
}
