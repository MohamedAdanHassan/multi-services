/**
 * Write-boundary guards for legacy admin copy (Taxi Service #sub-12, Manage
 * Service Category #sub-13 and any later screen that stores app-rendered text).
 *
 * These values are consumed by the mobile/web apps, which paste them straight
 * into their markup — so anything saved here is stored for other clients to
 * render. The legacy app sanitised on read (rows still carry
 * `<p xss=removed>` artefacts); doing it on write is strictly better: nothing
 * dangerous is ever stored, and a bad save is rejected with a message naming the
 * rule it broke instead of silently rewriting the admin's text.
 *
 * Only values that actually change are inspected, so untouched legacy content is
 * never rewritten by these rules.
 */

export type ContentFieldKind = "html" | "text" | "file" | "link";

/** Per-kind caps, all far above the longest legacy value (~1k characters). */
export const MAX_HTML_FIELD_LEN = 5_000;
export const MAX_TEXT_FIELD_LEN = 5_000;
export const MAX_FILE_FIELD_LEN = 255;
export const MAX_LINK_FIELD_LEN = 500;

/** Image columns hold a bare file name the apps concatenate into an image URL. */
const IMAGE_BASE = /(^|_)img\d*(_|$)/;
/** `link1` / `link2`: app-store links, either a replacement token or a URL. */
const LINK_BASE = /(^|_)link\d*(_|$)/;
/** The one legacy block that ships markup (`desc_*` siblings are plain copy). */
const HTML_BASE = /^desc$/;

/**
 * Classify a `content_cjx_details` field by its base name, i.e. how the apps are
 * known to render it. Modules whose editable columns are known by name (such as
 * `vehicle_category`) assign a kind per column instead of using this guesswork.
 */
export function contentFieldKind(base: string): ContentFieldKind {
  if (IMAGE_BASE.test(base)) return "file";
  if (LINK_BASE.test(base)) return "link";
  if (HTML_BASE.test(base)) return "html";
  return "text";
}

export function contentFieldLimit(kind: ContentFieldKind): number {
  switch (kind) {
    case "file":
      return MAX_FILE_FIELD_LEN;
    case "link":
      return MAX_LINK_FIELD_LEN;
    default:
      return MAX_TEXT_FIELD_LEN;
  }
}

/**
 * Tags that execute, submit, or smuggle a document into the page. Legacy copy
 * only ever used p/strong/li/div/a/b/ul/address/br/span, so this costs nothing.
 */
const DANGEROUS_TAG =
  /<\s*\/?\s*(script|style|iframe|frame|frameset|object|embed|link|meta|base|form|input|button|textarea|select|option|svg|math|applet|xml|template)\b/i;
/** `onerror=` / `onload=` — even bare, because apps splice these values into tags. */
const EVENT_HANDLER = /\bon[a-z]{2,}\s*=/i;
/** Schemes that run code when a value lands in an href/src — refused in every kind. */
const SCRIPTABLE_SCHEME = /(?:javascript|vbscript|livescript|mocha)\s*:/i;
/**
 * Plus `data:`, which only matters once the value can carry markup: rejecting it
 * in plain text would refuse ordinary copy (“see the data: table”), so it is
 * checked for the kinds the apps paste into HTML.
 */
const DANGEROUS_SCHEME = /(?:javascript|vbscript|livescript|mocha|data)\s*:/i;
const CSS_EXPRESSION = /\bexpression\s*\(/i;
/** Anything that looks like the start of a tag. */
const MARKUP = /<[a-zA-Z!/]/;
/**
 * Control characters plus zero-width / directional overrides: invisible to a
 * reviewer, able to flip the meaning of a line of copy or hide a payload.
 */
const INVISIBLE_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069\u200B\u2028\u2029\uFEFF]/;
/** A single legacy file name: no path, no protocol, no traversal. */
const SAFE_FILE_NAME = /^[A-Za-z0-9._-]+$/;
/** `#ANDROID_APP_LINK#` — kept verbatim so the apps can still substitute it. */
const LINK_TOKEN = /^#[A-Za-z0-9_-]+#$/;
const SAFE_URL = /^(?:https?:\/\/|mailto:|tel:|\/(?!\/)|\.\.?\/)/i;

/**
 * Returns a human-readable reason when a value must not be stored, else `null`.
 * The caller turns it into a 400 naming the field.
 */
export function findContentViolation(
  kind: ContentFieldKind,
  value: string,
): string | null {
  if (!value) return null;

  if (INVISIBLE_CHARS.test(value)) {
    return "must not contain control or invisible directional characters";
  }

  if (kind === "file") {
    if (value.length > MAX_FILE_FIELD_LEN) {
      return `file name must be at most ${MAX_FILE_FIELD_LEN} characters`;
    }
    if (!SAFE_FILE_NAME.test(value)) {
      return "must be a bare file name (no “/”, “\\”, “..” or other path characters)";
    }
    if (value === "." || value === ".." || value.includes("..")) {
      return "must be a real file name, not a path traversal";
    }
    return null;
  }

  if (kind === "link") {
    if (value.length > MAX_LINK_FIELD_LEN) {
      return `link must be at most ${MAX_LINK_FIELD_LEN} characters`;
    }
    if (/\s/.test(value)) return "link must not contain spaces";
    if (LINK_TOKEN.test(value)) return null;
    if (!SAFE_URL.test(value)) {
      return "link must be an http(s), mailto: or tel: URL, an app link token, or a site-relative path";
    }
    if (DANGEROUS_SCHEME.test(value)) return "link must not use a scriptable URL scheme";
    return null;
  }

  if (value.length > contentFieldLimit(kind)) {
    return `must be at most ${contentFieldLimit(kind)} characters`;
  }

  if (kind === "text") {
    if (MARKUP.test(value)) return "is plain text and must not contain HTML tags";
    if (EVENT_HANDLER.test(value)) return "must not contain inline event handlers";
    // Apps also splice plain-text values into href/src, where a scriptable scheme
    // runs even though the value itself looks inert.
    if (SCRIPTABLE_SCHEME.test(value)) return "is plain text and must not be a scriptable URL";
    return null;
  }

  // HTML copy: passive markup only.
  if (EVENT_HANDLER.test(value)) return "must not contain inline event handlers";
  if (DANGEROUS_SCHEME.test(value)) return "must not use a scriptable URL scheme";
  if (DANGEROUS_TAG.test(value)) return "must not contain scriptable HTML tags";
  if (CSS_EXPRESSION.test(value)) return "must not contain CSS expressions";
  return null;
}

/** Meta columns go into `<title>`/`<meta>`: markup has no business being there. */
export function findMetaViolation(name: string, value: string, maxLen: number): string | null {
  if (!value) return null;
  if (value.length > maxLen) return `${name} must be at most ${maxLen} characters`;
  const reason = findContentViolation("text", value);
  return reason ? `${name} ${reason}` : null;
}
