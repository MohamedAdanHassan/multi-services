import { AppError } from "../../../errors/AppError";
import * as model from "../models/pushModel";
import type { PushAudience, PushSegment } from "../models/pushModel";

/**
 * Business rules for Marketing Tools → Send Push-Notification (#sub-114).
 *
 * The sub-group grants exactly one capability, `manage-send-push-notification`,
 * so every route here answers to that same name: there is no view/send split to
 * honour and nothing is invented.
 *
 * What "send" means in this panel is deliberately narrow. The legacy screen did
 * two separate things: it wrote one `pushnotification_log` row per recipient, and
 * it asked the PHP push service to hand the message to Firebase. Only the first
 * half is reproduced here, because this backend holds no push credential and the
 * legacy key sits in `configurations` marked `eSensitive`. The recorded rows are
 * the same rows the legacy panel wrote and the dashboard reads, so the history is
 * real; the panel says in its own words that no device was contacted.
 *
 * Recipient resolution follows the legacy rules rather than a cleaner guess,
 * including its two filters that are easy to miss: an account with an empty
 * `iGcmRegId` was skipped, and accounts sharing one `vFirebaseDeviceToken`
 * collapsed into a single recipient (the logged-in one).
 */

/** The legacy message box capped at 100 characters. */
const MAX_MESSAGE_LEN = 100;
/** How many named recipients a preview returns; the rest are only counted. */
const SAMPLE_LIMIT = 100;
/** Never let one click record more rows than the legacy batcher handled. */
const MAX_RECIPIENTS = 25_000;

const AUDIENCES: readonly string[] = ["driver", "rider", "company"];
const SEGMENTS: readonly string[] = ["all", "logged", "inactive"];

function cleanAudience(value: unknown): PushAudience {
  if (!AUDIENCES.includes(String(value))) {
    throw AppError.badRequest("Audience must be one of: driver, rider, company.");
  }
  return value as PushAudience;
}

function cleanSegment(value: unknown): PushSegment {
  if (value === undefined || value === null || value === "") return "all";
  if (!SEGMENTS.includes(String(value))) {
    throw AppError.badRequest("Segment must be one of: all, logged, inactive.");
  }
  return value as PushSegment;
}

/** A 2-letter country code, or '' for "every country". */
function cleanCountry(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  const code = String(value).trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) throw AppError.badRequest("Country must be a 2-letter code.");
  return code;
}

/**
 * The legacy panel warned that symbols and emoji break a push, so they are
 * refused here instead of being recorded and failing later. Newlines survive
 * (normalised to \n); everything else in the C0 range does not.
 */
function cleanMessage(value: unknown): string {
  const raw = String(value ?? "").replace(/\r\n?/g, "\n").trim();
  if (!raw) throw AppError.badRequest("Message is required.");
  if (raw.length > MAX_MESSAGE_LEN) {
    throw AppError.badRequest(`Message must be at most ${MAX_MESSAGE_LEN} characters.`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(raw)) {
    throw AppError.badRequest("Message contains control characters.");
  }
  if (/\p{Extended_Pictographic}/u.test(raw)) {
    throw AppError.badRequest("Message must not contain emoji or symbols.");
  }
  return raw;
}

export interface Recipient {
  id: number;
  name: string;
  country: string;
  loggedIn: boolean;
}

/** Audience + segment + country, cleaned. Shared by the preview and the send. */
function cleanAudienceFilter(input: unknown) {
  const body = (input ?? {}) as Record<string, unknown>;
  return {
    audience: cleanAudience(body.audience),
    segment: cleanSegment(body.segment),
    country: cleanCountry(body.country),
  };
}

/**
 * The complete device-folded recipient list, before any preview cap.
 *
 * Devices, not accounts, decide who is reached: the first row per token wins, and
 * `resolveAudience` ordered logged-in rows first for exactly that reason. Accounts
 * with no stored token cannot collide, so they are all kept — a deliberate fix to
 * the legacy collapse, which folded them into a single recipient.
 */
async function resolveFull(audience: PushAudience, segment: PushSegment, country: string) {
  const [tokened, everyone] = await Promise.all([
    model.resolveAudience(audience, segment, country, true),
    model.resolveAudience(audience, segment, country, false),
  ]);

  const seen = new Set<string>();
  const kept: Recipient[] = [];
  let sharedToken = 0;
  for (const row of tokened) {
    if (row.token && seen.has(row.token)) {
      sharedToken += 1;
      continue;
    }
    if (row.token) seen.add(row.token);
    kept.push({ id: row.id, name: row.name, country: row.country, loggedIn: row.loggedIn });
  }

  return {
    kept,
    sharedToken,
    // Eligible accounts the legacy rules never reach for want of a registration id.
    noToken: Math.max(0, everyone.length - tokened.length),
  };
}

export interface AudiencePlan {
  audience: PushAudience;
  segment: PushSegment;
  country: string;
  /** Rows a send would record: tokened, and one per shared device. */
  reached: number;
  /** Eligible accounts the legacy rules skip for want of a registration id. */
  noToken: number;
  /** Extra accounts folded into another recipient because they share a device. */
  sharedToken: number;
  recipients: Recipient[];
  truncated: boolean;
}

/**
 * Resolve the audience exactly as a send would, and report the arithmetic rather
 * than only the headline number — an operator deciding what "all providers" means
 * deserves to see who is left out.
 */
export async function plan(input: unknown): Promise<AudiencePlan> {
  const { audience, segment, country } = cleanAudienceFilter(input);
  const resolved = await resolveFull(audience, segment, country);

  return {
    audience,
    segment,
    country,
    reached: resolved.kept.length,
    noToken: resolved.noToken,
    sharedToken: resolved.sharedToken,
    recipients: resolved.kept.slice(0, SAMPLE_LIMIT),
    truncated: resolved.kept.length > SAMPLE_LIMIT,
  };
}

export interface CountryCount {
  code: string;
  name: string;
  recipients: number;
}

/** Countries present in the audience, so the filter never offers an empty one. */
export async function countries(input: unknown): Promise<CountryCount[]> {
  const body = (input ?? {}) as Record<string, unknown>;
  return model.audienceCountries(cleanAudience(body.audience), cleanSegment(body.segment));
}

export interface SendResult {
  audience: PushAudience;
  segment: PushSegment;
  country: string;
  message: string;
  recorded: number;
  noToken: number;
  sharedToken: number;
  dateTime: string;
}

/**
 * Record a broadcast: resolve the recipients on the server, fold them to devices,
 * and write one log row each. `recipients` narrows the resolved set (the legacy
 * multi-select did the same) and is always intersected, so no id outside the
 * chosen audience can be recorded.
 */
export async function send(input: unknown, ip: string): Promise<SendResult> {
  const body = (input ?? {}) as Record<string, unknown>;
  const { audience, segment, country } = cleanAudienceFilter(body);
  const message = cleanMessage(body.message);

  // Always the full resolution: the 100-name preview cap is a display concern, and
  // intersecting a picked subset with a capped list would reject valid recipients.
  const resolved = await resolveFull(audience, segment, country);
  let chosen = resolved.kept;

  if (body.recipients !== undefined && body.recipients !== null) {
    if (!Array.isArray(body.recipients)) {
      throw AppError.badRequest("recipients must be a list of id numbers.");
    }
    const ids = new Set(body.recipients.map((v) => Number(v)));
    if ([...ids].some((n) => !Number.isInteger(n) || n <= 0)) {
      throw AppError.badRequest("recipients must be positive integer ids.");
    }
    if (!ids.size) throw AppError.badRequest("Pick at least one recipient.");
    const foreign = resolved.kept.filter((r) => !ids.has(r.id)).length;
    const picked = resolved.kept.filter((r) => ids.has(r.id));
    if (!picked.length) {
      // Loud rather than silent: a stale picker must not quietly empty a send.
      throw AppError.badRequest(
        `None of the ${ids.size} picked recipient(s) are in this audience any more ` +
          `(${foreign} other id(s) were offered). Reload the audience and try again.`,
      );
    }
    chosen = picked;
  }

  if (!chosen.length) {
    throw AppError.badRequest("No recipient in this audience has a device to reach.");
  }
  if (chosen.length > MAX_RECIPIENTS) {
    throw AppError.badRequest(`A single send may not exceed ${MAX_RECIPIENTS} recipients.`);
  }

  const dateTime = await model.serverNow();
  const recorded = await model.insertLogRows(
    chosen.map((r) => ({ audience, userId: r.id, message })),
    dateTime,
    ip,
  );

  return {
    audience,
    segment,
    country,
    message,
    recorded,
    noToken: resolved.noToken,
    sharedToken: resolved.sharedToken,
    dateTime,
  };
}

/** Recent recorded notifications, newest first. */
export async function history(limitRaw: unknown): Promise<{
  rows: model.LogRow[];
  total: number;
  maxId: number;
}> {
  // An empty `?limit=` is "no preference", not a bad number, so '' is folded into
  // the default before the range check (z.coerce would have turned it into 0).
  const raw =
    limitRaw === undefined || limitRaw === null || limitRaw === "" ? 100 : Number(limitRaw);
  if (!Number.isInteger(raw) || raw < 1 || raw > 500) {
    throw AppError.badRequest("limit must be an integer between 1 and 500.");
  }
  const [rows, totals] = await Promise.all([model.recentLog(raw), model.logTotals()]);
  return { rows, ...totals };
}
