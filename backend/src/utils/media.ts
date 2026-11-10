import { existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { AppError } from "../errors/AppError";
import { env } from "../config/env";

/**
 * Two write-asymmetric roots, plus one flat read-only artwork root.
 *
 * - `uploadRoot` (`backend/uploads`, git-ignored) is where every NEW file is
 *   written. `env.media.webImagesRoot` names it, so the upload destinations in the
 *   controllers all point here without further wiring.
 * - `legacyRoot` (`/var/www/ataa/webimages/upload`) is what the legacy PHP panel
 *   wrote to. Thousands of existing rows still name their image by bare filename
 *   and only that directory holds the bytes, so it stays readable forever — but it
 *   is never written to and never deleted from, because the live legacy app shares
 *   those exact files.
 * - `legacyArtworkRoot` (`/var/www/ataa/assets/img/images`) holds the artwork the
 *   legacy apps ship with. Same read-only contract, but FLAT: a stored value is the
 *   whole path, with no module folder in front of it, so it needs its own resolver.
 *
 * Rule of thumb: `uploadDir` for anything being created, `resolveStoredMedia` for
 * anything being read, `deleteUploadedMedia*` for anything being removed. Never
 * reach for a root inline in a read path — a read that only knows the write root
 * silently 404s every pre-existing row, and a delete through a legacy root would
 * destroy files the live legacy PHP panel and the shipped apps still serve.
 */

/** Root new uploads are written under. */
export const uploadRoot: string = path.resolve(env.media.webImagesRoot);

/** Read-only legacy media root; absent on machines that never ran the old panel. */
export const legacyRoot: string = path.resolve(env.media.legacyImagesRoot);

/** Read-only flat artwork root (banner carousel images the legacy apps shipped). */
export const legacyArtworkRoot: string = path.resolve(env.media.legacyArtworkRoot);

/**
 * Read-only root of the legacy install itself. A few tables keep their bytes outside
 * the two media roots above — under `webimages/icons/...` or `assets/img/...` — so a
 * module that edits one of those columns names the path relative to this root instead
 * of hard-coding `/var/www/...`. Same contract as the other legacy roots: read only.
 */
export const legacySiteRoot: string = path.resolve(env.media.legacySiteRoot);

function isInside(root: string, abs: string): boolean {
  return abs === root || abs.startsWith(root + path.sep);
}

/** A real, non-empty regular file. Zero-byte rows are common in the legacy data. */
function isReadableFile(abs: string): boolean {
  return existsSync(abs) && statSync(abs).isFile() && statSync(abs).size > 0;
}

/** Resolve `segments` under `root`, refusing to leave it. */
function joinUnder(root: string, segments: string[]): string {
  const abs = path.resolve(root, ...segments);
  if (!isInside(root, abs)) throw AppError.badRequest("Invalid media path");
  return abs;
}

/**
 * Directory a new upload for `segments` belongs in, created on demand. Always
 * inside `uploadRoot`; throws 400 when the segments try to escape it.
 */
export function uploadDir(...segments: string[]): string {
  const dir = joinUnder(uploadRoot, segments);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Absolute path of a stored media file, looked for in the upload root first and
 * then in the read-only legacy root. Returns null when it exists in neither (or is
 * an empty file), which callers normally map to a 404.
 */
export function resolveStoredMedia(...segments: string[]): string | null {
  const relative = joinUnder(uploadRoot, segments);
  const fromLegacy = path.resolve(legacyRoot, path.relative(uploadRoot, relative));
  for (const candidate of [relative, fromLegacy]) {
    if (isReadableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Same lookup for a table whose stored file names point at the FLAT artwork root:
 * the module folder is tried in the write and legacy upload roots first, then the
 * bare file name is tried in the artwork root, which has no folder in front of it.
 * New uploads still land under `dir`, so a screen can add artwork without ever
 * writing next to the files the legacy apps ship.
 */
export function resolveStoredArtwork(dir: string, filename: string): string | null {
  const base = path.basename(filename);
  const fromRoots = resolveStoredMedia(dir, base);
  if (fromRoots) return fromRoots;
  const fromArtwork = joinUnder(legacyArtworkRoot, [base]);
  return isReadableFile(fromArtwork) ? fromArtwork : null;
}

/** True when `abs` is one of the files this app wrote (i.e. safe to delete). */
export function isManagedMedia(abs: string): boolean {
  return isInside(uploadRoot, abs);
}

/**
 * Resolve a file the LEGACY panel wrote somewhere else inside its own install tree,
 * from the relative path a module composes — `webimages/icons/VehicleCategory/280`,
 * then the stored bare file name. Read-only by contract, and the last segment is
 * always treated as a file name, so a value edited by hand can never walk out of the
 * tree or name a directory. Returns null when the install (or the file) is absent.
 */
export function resolveLegacySiteFile(...segments: string[]): string | null {
  const parts = segments.map((s, i) =>
    i === segments.length - 1 ? path.basename(s) : s,
  );
  const abs = joinUnder(legacySiteRoot, parts);
  return isReadableFile(abs) ? abs : null;
}

/**
 * Remove a file we uploaded, after locating it with `resolveStoredMedia`. Legacy
 * files are left untouched — other rows and the legacy panel still use them.
 * Best-effort by design: the database row is the source of truth, so a stuck file
 * is harmless and a missing one is not an error.
 */
export function deleteUploadedMedia(...segments: string[]): boolean {
  const abs = resolveStoredMedia(...segments);
  if (!abs || !isManagedMedia(abs)) return false;
  try {
    unlinkSync(abs);
    return true;
  } catch {
    return false;
  }
}

/** Ceiling every image upload in this project applies, in bytes. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Extensions an image column may hold — the set the apps can render. */
export const IMAGE_EXTENSIONS: readonly string[] = [".jpg", ".jpeg", ".png", ".webp", ".gif"];

/**
 * True when an uploaded file is a picture we are willing to store. Both the name and
 * the declared MIME type have to agree, so a renamed binary is refused rather than
 * served back with an image content type.
 */
export function isSupportedImage(originalName: string, mimetype: string): boolean {
  const ext = path.extname(originalName).toLowerCase();
  return IMAGE_EXTENSIONS.includes(ext) && /^image\/(jpeg|png|webp|gif)$/.test(mimetype);
}

/** Content type to stream a stored image with, from its extension. */
export function imageContentType(absPath: string): string {
  switch (path.extname(absPath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return "image/jpeg";
  }
}

/**
 * A stored file name is never a path: an upload is written under one module directory
 * and the column keeps only the base name, so reads and deletes strip anything a
 * hand-edited legacy value might carry.
 */
export function storedMediaSegments(dir: string, filename: string): [string, string] {
  return [dir, path.basename(filename)];
}
