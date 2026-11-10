import type { NextFunction, Request, Response } from "express";

/**
 * Lightweight response-time metrics: a fixed-size ring of recent durations per
 * normalized route, from which p50/p95/p99 are computed on demand. No external
 * registry (Prometheus etc.) — this is a single-process API, so an in-memory
 * summary is honest and free.
 */

const MAX_ROUTES = 256; // distinct route keys tracked before LRU eviction
const WINDOW = 1024; // duration samples kept per route (ring buffer)
const SLOW_MS = 200; // anything slower gets a one-line warn

interface RouteBucket {
  durations: Float64Array;
  count: number; // total responses seen (may exceed WINDOW)
  next: number; // write cursor into the ring
  errors: number; // responses with status >= 500
}

const buckets = new Map<string, RouteBucket>();

function bucketFor(key: string): RouteBucket {
  let b = buckets.get(key);
  if (!b) {
    // Bound memory: evict the oldest-inserted key if we hit the cap.
    if (buckets.size >= MAX_ROUTES) {
      const oldest = buckets.keys().next().value;
      if (oldest !== undefined) buckets.delete(oldest);
    }
    b = { durations: new Float64Array(WINDOW), count: 0, next: 0, errors: 0 };
    buckets.set(key, b);
  }
  return b;
}

/** Stable, low-cardinality key: method + mounted route template (or path head). */
function routeKey(req: Request): string {
  const template = req.route?.path; // available once the route has matched
  const path = template ? `${req.baseUrl}${template}` : req.path.split("/").slice(0, 3).join("/");
  return `${req.method} ${path || "/"}`;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

/** Summarize the current window: overall p50/p95/p99 plus per-route detail. */
export function getMetricsSummary() {
  const all: number[] = [];
  const routes = [...buckets.entries()].map(([route, b]) => {
    const n = Math.min(b.count, WINDOW);
    const samples: number[] = [];
    for (let i = 0; i < n; i++) samples.push(b.durations[i]);
    all.push(...samples);
    samples.sort((x, y) => x - y);
    return {
      route,
      count: b.count,
      errors: b.errors,
      p50: +percentile(samples, 50).toFixed(2),
      p95: +percentile(samples, 95).toFixed(2),
      p99: +percentile(samples, 99).toFixed(2),
      max: +(samples[samples.length - 1] ?? 0).toFixed(2),
    };
  });
  all.sort((x, y) => x - y);
  return {
    uptimeSeconds: Math.round(process.uptime()),
    totalResponses: all.length,
    overall: {
      p50: +percentile(all, 50).toFixed(2),
      p95: +percentile(all, 95).toFixed(2),
      p99: +percentile(all, 99).toFixed(2),
    },
    routes: routes.sort((a, b) => b.p95 - a.p95),
  };
}

/** Record per-request latency; must be mounted before anything that can respond. */
export function requestMetrics(req: Request, res: Response, next: NextFunction) {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    // Skip the metrics endpoint itself so polling it does not skew samples.
    if (req.path === "/api/metrics") return;
    const b = bucketFor(routeKey(req));
    b.durations[b.next] = ms;
    b.next = (b.next + 1) % WINDOW;
    b.count += 1;
    if (res.statusCode >= 500) b.errors += 1;
    if (ms > SLOW_MS) {
      console.warn(`slow response: ${req.method} ${req.originalUrl} -> ${res.statusCode} in ${ms.toFixed(0)}ms`);
    }
  });
  next();
}
