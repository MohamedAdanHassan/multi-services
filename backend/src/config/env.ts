import "dotenv/config";
import path from "node:path";

/** Backend project root — works from `src/` (tsx) and from `dist/` (compiled). */
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

function required(name: string, value: string | undefined): string {
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalInt(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Environment variable ${name} must be a number`);
  return n;
}

function optionalBool(name: string, def: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  return raw === "1" || raw.toLowerCase() === "true";
}

function parseList(name: string, def: string[]): string[] {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

const nodeEnv = process.env.NODE_ENV ?? "development";
const isProd = nodeEnv === "production";

export const env = {
  nodeEnv,
  isProd,
  port: optionalInt("PORT", 4000),
  trustProxy: optionalBool("TRUST_PROXY", isProd),
  publicUrl: process.env.PUBLIC_URL ?? "http://localhost:4000",

  // Media roots.
  //
  // `webImagesRoot` is the WRITE root: every new upload lands inside the project
  // (`backend/uploads`, git-ignored). Driver photos live under
  // `${webImagesRoot}/Driver/<iDriverId>/<vImage>` and are streamed through the
  // /api/drivers/:id/photo endpoint (never served raw).
  //
  // `legacyImagesRoot` is a READ-ONLY fallback: the directory the legacy PHP panel
  // wrote to, still holding ~3k files that database rows name by bare filename.
  // Reads try the write root first and fall back to it; writes and deletions never
  // touch it. See src/utils/media.ts.
  //
  // `legacyArtworkRoot` is a second, FLAT read-only root: the in-app artwork the
  // legacy product shipped with (the `banners` carousel images its apps still load
  // from `/assets/img/images/<file>`). It is consulted for a bare file name only —
  // there is no module folder in front of it — and it is never written to either.
  //
  // `legacySiteRoot` is the legacy install itself. Some tables name their artwork by a
  // bare file name but keep the bytes OUTSIDE `webimages/upload`: the vehicle-category
  // icons live under `webimages/icons/VehicleCategory/<rowId>`, and the homepage "Our
  // services" artwork under `assets/img/home-new/services`. A screen editing those
  // columns reads them through `resolveLegacySiteFile`, read-only by contract.
  media: {
    webImagesRoot: process.env.WEB_IMAGES_ROOT
      ? path.resolve(process.env.WEB_IMAGES_ROOT)
      : path.join(PROJECT_ROOT, "uploads"),
    legacyImagesRoot:
      process.env.LEGACY_WEB_IMAGES_ROOT || "/var/www/ataa/webimages/upload",
    legacyArtworkRoot:
      process.env.LEGACY_ARTWORK_ROOT || "/var/www/ataa/assets/img/images",
    legacySiteRoot: process.env.LEGACY_SITE_ROOT || "/var/www/ataa",
  },

  // Database dumps (Utility → DB Backup, #sub-133) are written to a dedicated,
  // non web-served directory and streamed back only through the authenticated
  // download endpoint. `mysqldumpPath` lets operators pin a specific binary.
  backup: {
    root: process.env.BACKUP_ROOT || "./backups",
    mysqldumpPath: process.env.MYSQLDUMP_PATH || "mysqldump",
  },

  db: {
    host: required("DB_HOST", process.env.DB_HOST),
    port: optionalInt("DB_PORT", 3306),
    user: required("DB_USER", process.env.DB_USER),
    password: required("DB_PASSWORD", process.env.DB_PASSWORD),
    database: required("DB_NAME", process.env.DB_NAME),
    connectionLimit: optionalInt("DB_CONNECTION_LIMIT", 20),
  },

  jwt: {
    accessSecret: required("JWT_ACCESS_SECRET", process.env.JWT_ACCESS_SECRET),
    refreshSecret: required("JWT_REFRESH_SECRET", process.env.JWT_REFRESH_SECRET),
    issuer: process.env.JWT_ISSUER ?? "ondemand-backend",
    audience: process.env.JWT_AUDIENCE ?? "ondemand-admin",
    accessTtlSeconds: optionalInt("JWT_ACCESS_TTL", 15 * 60),
    refreshTtlSeconds: optionalInt("JWT_REFRESH_TTL", 7 * 24 * 60 * 60),
  },

  cookies: {
    secure: optionalBool("COOKIE_SECURE", isProd),
    sameSite: (process.env.COOKIE_SAME_SITE as "lax" | "strict" | "none") ?? (isProd ? "none" : "lax"),
    domain: process.env.COOKIE_DOMAIN || undefined,
  },

  cors: {
    origins: parseList("CORS_ORIGINS", ["http://localhost:3000"]),
    credentials: optionalBool("CORS_CREDENTIALS", true),
  },

  rateLimit: {
    standardWindowMs: optionalInt("RATE_STANDARD_WINDOW_MS", 15 * 60 * 1000),
    standardMax: optionalInt("RATE_STANDARD_MAX", 300),
    authWindowMs: optionalInt("RATE_AUTH_WINDOW_MS", 15 * 60 * 1000),
    authMax: optionalInt("RATE_AUTH_MAX", 10),
  },

  lockout: {
    maxFailedAttempts: optionalInt("LOCKOUT_MAX_ATTEMPTS", 5),
    lockMinutes: optionalInt("LOCKOUT_LOCK_MINUTES", 15),
  },

  password: {
    bcryptRounds: optionalInt("BCRYPT_ROUNDS", 12),
    resetTtlMinutes: optionalInt("RESET_TOKEN_TTL_MINUTES", 30),
    resetMaxAttempts: optionalInt("RESET_TOKEN_MAX_ATTEMPTS", 5),
  },

  tls: {
    enabled: optionalBool("TLS_ENABLED", false),
    keyPath: process.env.TLS_KEY_PATH || undefined,
    certPath: process.env.TLS_CERT_PATH || undefined,
  },
} as const;
