// Write matrix for "Manage Service/Content" — Delivery Runner (#sub-144, row 287) and its
// Delivery Genie sibling (#sub-141, row 280), both in the legacy `vehicle_category` table.
//
// The screen is edit-only and its whole point is that the `:app` segment picks the ROW, so
// every phase below asserts three things at once: the write landed where it should, the bytes
// next to it did not move, and the OTHER app's row is byte-for-byte unchanged. Reading the
// table directly is not optional here — a merge that silently rewrote all 26 languages, or an
// exclusivity statement that promoted the wrong row, both answer 200 and return a DTO that
// looks right until you diff the columns.
//
// Every phase rolls itself back, most of them through the screen's own routes (that round-trip
// is worth testing too) and the rest by writing the pristine value from `b144.mjs snapshot`
// back: the OTP column reads `''` on both rows and the API refuses to store that, so only SQL
// can put it back, which is itself the finding.
//
// Two behaviours below are the ones a reader may expect to be different, so they are asserted
// rather than assumed: blanking one language's name is ACCEPTED (the legacy form posted empty
// inputs too, and the write-boundary guard only refuses markup, over-long and invisible text),
// and a null setting is refused by the payload schema before the service's “absent means keep”
// rule can ever run. The audit check waits for its row on purpose: the log insert is
// fire-and-forget, so a save answers before its own event exists.
//
//   node scripts/b144.mjs snapshot
//   node scripts/b144-write.mjs
//   node scripts/b144.mjs restore
//   node scripts/b144.mjs fingerprint after && diff .lh/b144-before.txt .lh/b144-after.txt
import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import mysql from "mysql2/promise";
import "dotenv/config";

const API = process.env.B144_API ?? "http://localhost:4000/api";
const EMAIL = "admin.test@ondemand.local";
const PASSWORD = "TestPass123!";
const TABLE = "vehicle_category";
const ID = "iVehicleCategoryId";
const GENIE = 280;
const RUNNER = 287;
const DUMP = path.resolve("..", ".lh", "b144-rows.json");
/** Where a new upload for the per-row slots lands, so an orphan can be looked for. */
const UPLOAD_ROOT = path.resolve("uploads");

const db = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

const dump = JSON.parse(readFileSync(DUMP, "utf8"));
/** Pristine values by row id and column, as `b144.mjs snapshot` wrote them. */
const pristine = new Map(
  dump.rows.map((r) => [Number(r[ID]), new Map(dump.cols.map((c) => [c, r[c]]))]),
);
if (!pristine.has(RUNNER) || !pristine.has(GENIE)) {
  console.error("the snapshot does not hold both rows — run `node scripts/b144.mjs snapshot`");
  process.exit(1);
}

let pass = 0;
const failures = [];

function ok(label, cond, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq(label, actual, want) {
  ok(label, String(actual) === String(want), `got ${JSON.stringify(actual)}, want ${JSON.stringify(want)}`);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

let cookie = "";

async function call(method, pathname, body, isForm = false) {
  const headers = { "X-Requested-With": "XMLHttpRequest" };
  if (cookie) headers.cookie = cookie;
  let payload;
  if (body !== undefined) {
    if (!isForm) headers["Content-Type"] = "application/json";
    payload = isForm ? body : JSON.stringify(body);
  }
  const res = await fetch(`${API}${pathname}`, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, json, text, headers: res.headers };
}

const get = (p) => call("GET", p);
const put = (p, b) => call("PUT", p, b);
const patch = (p, b) => call("PATCH", p, b);

/** A refusal's text, service wording or zod `details` alike. */
function message(res) {
  const err = res.json?.error;
  if (!err) return JSON.stringify(res.json ?? "").slice(0, 200);
  const details = (err.details ?? []).map((d) => d.message).join("; ");
  return [err.message, details].filter(Boolean).join(" — ").slice(0, 300);
}

function refused(label, res, phrase) {
  ok(
    label,
    res.status === 400 && message(res).includes(phrase),
    `status ${res.status}: ${message(res)}`,
  );
}

function notFound(label, res, phrase) {
  ok(
    label,
    res.status === 404 && message(res).includes(phrase),
    `status ${res.status}: ${message(res)}`,
  );
}

async function login() {
  const res = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "X-Requested-With": "XMLHttpRequest", "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const setCookies = res.headers.getSetCookie?.() ?? [];
  cookie = setCookies.map((c) => c.split(";")[0]).filter((c) => c.startsWith("at=")).join("; ");
  ok("login as the test super admin", res.status === 200 && cookie !== "", `status ${res.status}`);
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

async function one(sql, params) {
  const [rows] = await db.query(sql, params);
  return rows[0];
}

/** Every column this screen can move, for one row, as text. */
const WATCHED_EXTRA = [
  "tPromoteBannerTitle", "vServiceCatTitleHomepage", "eStatus", "eOTPCodeEnable",
  "ePromoteBanner", "iDisplayOrder", "iDisplayOrderHomepage", "vListLogo3",
  "vPromoteBannerImage", "vHomepageFullLogo", "vHomepageLogoOurServices",
];
async function bytes(id) {
  const cols = dump.cols.filter(
    (c) => /^vCategory_[A-Z]+$/.test(c) || WATCHED_EXTRA.includes(c),
  );
  const row = await one(
    `SELECT ${cols.map((c) => `\`${c}\``).join(", ")} FROM ${TABLE} WHERE ${ID} = ? LIMIT 1`,
    [id],
  );
  return { cols, row };
}

/** `label: value` for the columns whose stored text matters to a claim. */
async function value(id, column) {
  const r = await one(`SELECT \`${column}\` AS v FROM ${TABLE} WHERE ${ID} = ? LIMIT 1`, [id]);
  return r ? String(r.v ?? "") : null;
}

function diffCols(cols, before, after) {
  return cols.filter((c) => String(before[c] ?? "") !== String(after[c] ?? ""));
}

/** Rows whose starting bytes a phase promises to return to, filled once the run has read them. */
const touched = new Map();

/** Prove a row came back to where the run started, byte for byte. */
async function isWhole(label, id) {
  const { cols, row } = await bytes(id);
  const moved = diffCols(cols, touched.get(id), row);
  ok(label, moved.length === 0, moved.join(", "));
}

/**
 * Put the pristine snapshot values back. One of them cannot be written by a plain
 * statement in this session: `eOTPCodeEnable = ''` is the enum's out-of-range member 0,
 * which STRICT_TRANS_TABLES refuses with `Data truncated` — precisely why the API refuses
 * to save it and why the rollback is SQL rather than the screen. The strict flags are
 * dropped for this one statement and the mode is put back straight after it, session-local;
 * the server's global mode is never touched.
 */
const UNSETTABLE_ENUMS = new Set(["eOTPCodeEnable"]);

async function resetPristine(id, columns) {
  const want = pristine.get(id);
  const needsRelax = columns.some((c) => want.get(c) === "" && UNSETTABLE_ENUMS.has(c));
  const [mode] = await db.query("SELECT @@SESSION.sql_mode AS m");
  if (needsRelax) await db.query("SET SESSION sql_mode = 'NO_ENGINE_SUBSTITUTION'");
  try {
    await db.query(
      `UPDATE ${TABLE} SET ${columns.map((c) => `\`${c}\` = ?`).join(", ")} WHERE ${ID} = ? LIMIT 1`,
      [...columns.map((c) => want.get(c)), id],
    );
  } finally {
    if (needsRelax) await db.query(`SET SESSION sql_mode = ${db.escape(mode[0].m)}`);
  }
}

async function promotedIds() {
  const [rows] = await db.query(
    `SELECT ${ID} AS id FROM ${TABLE} WHERE ePromoteBanner = 'Yes' ORDER BY ${ID}`,
  );
  return rows.map((r) => Number(r.id));
}

async function auditMaxId() {
  const r = await one(`SELECT COALESCE(MAX(id), 0) AS m FROM admin_audit_log`);
  return Number(r.m);
}

/** Events logged after `since`, newest first. */
async function auditEvents(since) {
  const [rows] = await db.query(
    `SELECT event FROM admin_audit_log WHERE id > ? ORDER BY id DESC LIMIT 25`,
    [since],
  );
  return rows.map((r) => r.event);
}

/**
 * The audit insert is fire-and-forget (`audit.logQuiet`), so a save answers before its own
 * log row exists. Wait for `want` to land rather than declaring the event name missing.
 */
async function auditEventsSettled(since, want) {
  let events = [];
  for (let i = 0; i < 30; i += 1) {
    events = await auditEvents(since);
    if (events.includes(want)) break;
    await sleep(100);
  }
  return events;
}

const names = (s) => s?.names ?? {};
const settingsOf = (s) => s?.settings ?? {};

// ---------------------------------------------------------------------------

await login();

/** The shipped language codes, taken from the screen itself rather than hardcoded. */
const detail0 = (await get(`/genie-service-content/runner/${RUNNER}`)).json?.item;
const CODES = (detail0?.languages ?? []).map((l) => l.code);
eq("the runner detail lists the shipped languages", CODES.length, 26);
const HOME = "vServiceCatTitleHomepage";
const PROMO = "tPromoteBannerTitle";

const genieStart = (await bytes(GENIE)).row;
const runnerStart = (await bytes(RUNNER)).row;
touched.set(RUNNER, runnerStart);
touched.set(GENIE, genieStart);

console.log("\n--- cross-app write isolation: the app in the URL is the row you may touch ---");
{
  const r1 = await put(`/genie-service-content/runner/${GENIE}`, { names: { EN: "hijacked" } });
  notFound("PUT /runner/280 (Genie's row) is 404", r1, "No Delivery Runner service content row #280");
  await isWhole("  and the Genie row's bytes are untouched", GENIE);

  const r2 = await put(`/genie-service-content/genie/${RUNNER}`, { names: { EN: "hijacked" } });
  notFound("PUT /genie/287 (Runner's row) is 404", r2, "No Delivery Genie service content row #287");
  await isWhole("  and the Runner row's bytes are untouched", RUNNER);

  const r3 = await patch(`/genie-service-content/runner/${GENIE}/status`, { status: "Inactive" });
  notFound("PATCH /runner/280/status is 404", r3, "No Delivery Runner service content row #280");
  eq("  the Genie row is still Active", await value(GENIE, "eStatus"), "Active");

  const r4 = await patch(`/genie-service-content/genie/${RUNNER}/status`, { status: "Inactive" });
  notFound("PATCH /genie/287/status is 404", r4, "No Delivery Genie service content row #287");
  eq("  the Runner row is still Active", await value(RUNNER, "eStatus"), "Active");

  const r5 = await put(`/genie-service-content/runner/${GENIE}`, { settings: { ePromoteBanner: "Yes" } });
  notFound("a cross-app promote attempt is 404 too", r5, "No Delivery Runner service content row #280");
  eq("  nothing was promoted", (await promotedIds()).length, 0);
}

console.log("\n--- one language, one column: a name edit lands where the editor sent it ---");
{
  const before = await bytes(RUNNER);
  const want = "Runner Delivery AR";
  const res = await put(`/genie-service-content/runner/${RUNNER}`, { names: { AR: want } });
  eq("PUT /runner/287 {names:{AR}} is accepted", res.status, 200);
  eq("  the fresh DTO reads it back", names(res.json?.item).AR, want);
  eq("  the column really holds it", await value(RUNNER, "vCategory_AR"), want);

  const after = await bytes(RUNNER);
  const moved = diffCols(before.cols, before.row, after.row).filter((c) => /^vCategory_/.test(c));
  ok("only vCategory_AR moved, none of the other 25 languages", moved.join(",") === "vCategory_AR", moved.join(", "));
  await isWhole("the Genie row's 26 names are byte-identical", GENIE);

  const item = (await get(`/genie-service-content/runner/${RUNNER}`)).json?.item;
  eq("the list's name count is unchanged by one language", item?.namesFilled, 26);

  // The audit event is named per app: a Runner save must not be logged as a Genie save.
  const since = await auditMaxId();
  await put(`/genie-service-content/runner/${RUNNER}`, { names: { EN: "Delivery Runner EN" } });
  const events = await auditEventsSettled(since, "service_content_runner_updated");
  ok("the Runner save logs service_content_runner_updated", events.includes("service_content_runner_updated"), events.join(", "));
  ok("  and logs no genie event", !events.some((e) => e.startsWith("service_content_genie")), events.join(", "));
  await put(`/genie-service-content/runner/${GENIE}`, { names: { EN: "x" } }); // 404, logs nothing
  const since2 = await auditMaxId();
  await put(`/genie-service-content/genie/${GENIE}`, { names: { EN: "Delivery Genie" } });
  const gevents = await auditEventsSettled(since2, "service_content_genie_updated");
  ok("a Genie save still logs its own, byte-identical event name", gevents.includes("service_content_genie_updated"), gevents.join(", "));
  await resetPristine(GENIE, ["vCategory_EN"]);
  await isWhole("both rollbacks leave no trace", GENIE);

  // Blank the name back through the screen, then prove the column is empty only there.
  await put(`/genie-service-content/runner/${RUNNER}`, { names: { AR: "", EN: "Delivery Runner" } });
  eq("a blank name is legal and lands as empty (the legacy form allowed it)", await value(RUNNER, "vCategory_AR"), "");
  const blanked = (await get(`/genie-service-content/runner/${RUNNER}`)).json?.item;
  eq("  the list then counts 25 filled languages", blanked?.namesFilled, 25);
  ok("  and the display name falls back to another language", (blanked?.displayName ?? "").length > 0, String(blanked?.displayName));
  await resetPristine(RUNNER, ["vCategory_AR", "vCategory_EN"]);
  await isWhole("restored, the Runner row is byte-identical again", RUNNER);
}

console.log("\n--- names: what the screen refuses to store ---");
{
  const res = await put(`/genie-service-content/runner/${RUNNER}`, { names: { EN: "<script>alert(1)</script>" } });
  refused("HTML in a name is refused", res, "must not contain HTML tags");
  const long = await put(`/genie-service-content/runner/${RUNNER}`, { names: { EN: "x".repeat(201) } });
  refused("a 201-character name is refused", long, "must be at most 200 characters");
  const invis = await put(`/genie-service-content/runner/${RUNNER}`, { names: { EN: "a\u200bb" } });
  refused("a zero-width character is refused", invis, "control or invisible directional");
  const nope = await put(`/genie-service-content/runner/${RUNNER}`, { names: { XX: "no such language" } });
  refused("an unknown language code is refused by name", nope, "Unknown language code: “XX”");
  const nottext = await put(`/genie-service-content/runner/${RUNNER}`, { names: { EN: 7 } });
  refused("a non-text name is refused by the payload schema", nottext, "number");
  const tooMany = await put(`/genie-service-content/runner/${RUNNER}`, {
    names: Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`L${i}`, "Delivery Runner"])),
  });
  refused("more languages than one save may carry is refused", tooMany, "at most 40 languages");
  const emptyGroup = await put(`/genie-service-content/runner/${RUNNER}`, { names: {} });
  refused("an empty group is refused rather than a silent no-op", emptyGroup, "Send at least the names that changed");
  const nothing = await put(`/genie-service-content/runner/${RUNNER}`, {});
  refused("a body with no group at all is refused", nothing, "at least one of `names`, `settings` or `copy`");
  await isWhole("none of the refusals wrote a byte", RUNNER);
  await isWhole("  nor on the sibling row", GENIE);
}

console.log("\n--- settings: the unset enum value is readable, never writable ---");
{
  eq("the OTP column is stored as '' today", await value(RUNNER, "eOTPCodeEnable"), "");
  const blank = await put(`/genie-service-content/runner/${RUNNER}`, { settings: { eOTPCodeEnable: "" } });
  refused(
    "saving that '' back is refused with the choices the form offers",
    blank,
    "is unset on this row and cannot be saved as blank — choose No / Yes",
  );
  await isWhole("  and nothing was written", RUNNER);

  const yes = await put(`/genie-service-content/runner/${RUNNER}`, { settings: { eOTPCodeEnable: "Yes" } });
  eq("choosing Yes writes Yes", yes.status, 200);
  eq("  in the column", await value(RUNNER, "eOTPCodeEnable"), "Yes");
  eq("  and in the fresh DTO", settingsOf(yes.json?.item).eOTPCodeEnable, "Yes");
  const no = await put(`/genie-service-content/runner/${RUNNER}`, { settings: { eOTPCodeEnable: "No" } });
  eq("and choosing No writes No", await value(RUNNER, "eOTPCodeEnable"), "No");
  ok("  the DTO follows", settingsOf(no.json?.item).eOTPCodeEnable === "No");
  // The screen cannot put the unset value back; only the snapshot can.
  await resetPristine(RUNNER, ["eOTPCodeEnable"]);
  eq("restored from the snapshot, it reads '' again", await value(RUNNER, "eOTPCodeEnable"), "");

  const bogus = await put(`/genie-service-content/runner/${RUNNER}`, { settings: { eStatus: "Inactive" } });
  refused("a setting this screen does not own is refused by name", bogus, "Unknown setting: “eStatus”");
  const maybe = await put(`/genie-service-content/runner/${RUNNER}`, { settings: { ePromoteBanner: "Maybe" } });
  refused("an enum outside the DDL's members is refused", maybe, "must be one of: No / Yes");
  const abc = await put(`/genie-service-content/runner/${RUNNER}`, { settings: { iDisplayOrder: "abc" } });
  refused("a word in a numeric column is refused", abc, "must be a number");
  const half = await put(`/genie-service-content/runner/${RUNNER}`, { settings: { iDisplayOrder: 6.5 } });
  refused("a fraction in a whole-number column is refused", half, "must be a whole number");
  const huge = await put(`/genie-service-content/runner/${RUNNER}`, { settings: { iDisplayOrderHomepage: 10000 } });
  refused("an order past the DDL's range is refused", huge, "must be between 0 and 9999");
  const many = await put(`/genie-service-content/runner/${RUNNER}`, {
    settings: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`iDisplayOrder${i}`, 1])),
  });
  refused("more settings than one save may carry is refused", many, "at most 8 settings");
  const nullish = await put(`/genie-service-content/runner/${RUNNER}`, { settings: { ePromoteBanner: null } });
  eq("a setting sent as null never reaches the merge rule that would skip it", nullish.status, 400);

  const order = await put(`/genie-service-content/runner/${RUNNER}`, {
    settings: { iDisplayOrder: 7, iDisplayOrderHomepage: 62 },
  });
  eq("both orders round-trip", order.status, 200);
  eq("  iDisplayOrder", await value(RUNNER, "iDisplayOrder"), "7");
  eq("  iDisplayOrderHomepage", await value(RUNNER, "iDisplayOrderHomepage"), "62");
  await isWhole("the Genie row's own 5 / 4 did not move", GENIE);
  await put(`/genie-service-content/runner/${RUNNER}`, { settings: { iDisplayOrder: 6, iDisplayOrderHomepage: 61 } });
  await isWhole("and the Runner row is back to 6 / 61", RUNNER);
}

console.log("\n--- blobs: the editor sends what changed, the service keeps the rest ---");
{
  const homeBefore = await value(RUNNER, HOME);
  const homeObj = JSON.parse(homeBefore);
  eq("the home column carries 26 keys", Object.keys(homeObj).length, 26);
  ok("  and no sub-title key at all", !Object.keys(homeObj).some((k) => k.startsWith("vServiceCatSubTitleHomepage")));

  const res = await put(`/genie-service-content/runner/${RUNNER}`, {
    copy: { [HOME]: { [`${HOME}_EN`]: "Runner home title" } },
  });
  eq("changing one language of one base is accepted", res.status, 200);
  const after = JSON.parse(await value(RUNNER, HOME));
  eq("  that key is the new text", after[`${HOME}_EN`], "Runner home title");
  const survivors = CODES.filter((c) => c !== "EN");
  ok(
    "  and the other 25 keys are verbatim, not rebuilt from the request",
    survivors.every((c) => after[`${HOME}_${c}`] === homeObj[`${HOME}_${c}`]),
    survivors.filter((c) => after[`${HOME}_${c}`] !== homeObj[`${HOME}_${c}`]).join(", "),
  );
  eq("  the key count did not change", Object.keys(after).length, 26);
  eq("the promote-title column of the same row did not move",
    await value(RUNNER, PROMO), pristine.get(RUNNER).get(PROMO));

  const homeEdited = await value(RUNNER, HOME);
  const again = await put(`/genie-service-content/runner/${RUNNER}`, {
    copy: { [HOME]: { [`${HOME}_EN`]: "Runner home title" } },
  });
  eq("re-sending a stored value verbatim is accepted", again.status, 200);
  eq("  and writes nothing at all — the bytes are identical", await value(RUNNER, HOME), homeEdited);

  const sub = await put(`/genie-service-content/runner/${RUNNER}`, {
    copy: { [HOME]: { vServiceCatSubTitleHomepage_EN: "Two wheels, one runner" } },
  });
  eq("a sub-title the row never carried can be added", sub.status, 200);
  const withSub = JSON.parse(await value(RUNNER, HOME));
  eq("  the column now has 27 keys", Object.keys(withSub).length, 27);
  eq("  and the new one holds the text", withSub.vServiceCatSubTitleHomepage_EN, "Two wheels, one runner");
  ok("  the titles all survived the second merge", CODES.every((c) => withSub[`${HOME}_${c}`] !== undefined));

  const promoBefore = await value(RUNNER, PROMO);
  const promoObj = JSON.parse(promoBefore);
  eq("the promote-title column is 26 keys, every one blank", Object.keys(promoObj).length, 26);
  ok("  as the Runner row stores it", Object.values(promoObj).every((v) => v === ""));
  const filled = await put(`/genie-service-content/runner/${RUNNER}`, {
    copy: { [PROMO]: { [`${PROMO}_EN`]: "Ride now" } },
  });
  eq("filling one of them is accepted", filled.status, 200);
  const promoAfter = JSON.parse(await value(RUNNER, PROMO));
  eq("  that key holds the text", promoAfter[`${PROMO}_EN`], "Ride now");
  ok("  and the 25 blanks are still blanks, not keys the merge dropped", CODES.filter((c) => c !== "EN").every((c) => promoAfter[`${PROMO}_${c}`] === ""));
  await put(`/genie-service-content/runner/${RUNNER}`, { copy: { [PROMO]: { [`${PROMO}_EN`]: "" } } });
  eq("clearing it again leaves the stored shape", await value(RUNNER, PROMO), promoBefore);

  const homeNow = await value(RUNNER, HOME);
  const promoNow = await value(RUNNER, PROMO);
  const unknownBlock = await put(`/genie-service-content/runner/${RUNNER}`, { copy: { tNoSuch: { tNoSuch_EN: "x" } } });
  refused("an unknown text block is refused by name", unknownBlock, "Unknown text block: “tNoSuch”");
  const wrongBase = await put(`/genie-service-content/runner/${RUNNER}`, { copy: { [PROMO]: { vServiceCatTitleHomepage_EN: "x" } } });
  refused("a base that column does not carry is refused", wrongBase, "is not part of “Promotional banner title”");
  const wrongLang = await put(`/genie-service-content/runner/${RUNNER}`, { copy: { [HOME]: { [`${HOME}_XX`]: "x" } } });
  refused("a blob key in an unknown language is refused", wrongLang, "does not name a known language");
  const longTitle = await put(`/genie-service-content/runner/${RUNNER}`, {
    copy: { [HOME]: { [`${HOME}_EN`]: "t".repeat(256) } },
  });
  refused("a title past 255 characters is refused", longTitle, "must be at most 255 characters");
  const longSub = await put(`/genie-service-content/runner/${RUNNER}`, {
    copy: { [HOME]: { vServiceCatSubTitleHomepage_EN: "s".repeat(1001) } },
  });
  refused("a sub-title past its own, larger cap is refused too", longSub, "must be at most 1000 characters");
  const notText = await put(`/genie-service-content/runner/${RUNNER}`, { copy: { [HOME]: { [`${HOME}_EN`]: 5 } } });
  refused("a non-text blob field never reaches the column", notText, "string");
  const xss = await put(`/genie-service-content/runner/${RUNNER}`, {
    copy: { [HOME]: { [`${HOME}_EN`]: "<a href='javascript:alert(1)'>go</a>" } },
  });
  refused("markup in copy is refused", xss, "must not contain HTML tags");
  eq("no refusal rewrote a byte of the home copy", await value(RUNNER, HOME), homeNow);
  eq("  nor of the promote titles", await value(RUNNER, PROMO), promoNow);

  await resetPristine(RUNNER, [HOME, PROMO]);
  eq("both blobs are byte-identical to the snapshot again", await value(RUNNER, HOME), homeBefore);
  eq("  including the promote titles' 26 blanks", await value(RUNNER, PROMO), promoBefore);
  await isWhole("the Runner row is whole again", RUNNER);
}

console.log("\n--- the promote banner is one flag across the whole table ---");
{
  eq("nothing is promoted at the start", (await promotedIds()).length, 0);
  // Seed the sibling by hand: this is the state the legacy tooltip warns about, and the
  // screen's own routes could not have produced it without already testing the toggle.
  await db.query(`UPDATE ${TABLE} SET ePromoteBanner = 'Yes' WHERE ${ID} = ? LIMIT 1`, [GENIE]);
  eq("the Genie row holds it", (await promotedIds()).join(","), String(GENIE));
  // Everything the exclusivity is allowed to leave behind, i.e. the row as the hand-seed
  // put it: compared against the run's start this state itself would look like a change.
  const genieSeeded = await bytes(GENIE);

  const res = await put(`/genie-service-content/runner/${RUNNER}`, { settings: { ePromoteBanner: "Yes" } });
  eq("promoting the Runner row is accepted", res.status, 200);
  eq("  and the response counts what it cleared", res.json?.promotedCleared, 1);
  eq("  only the Runner row is promoted now", (await promotedIds()).join(","), String(RUNNER));
  eq("  the fresh DTO says so", settingsOf(res.json?.item).ePromoteBanner, "Yes");
  eq("  the Genie row lost the flag", await value(GENIE, "ePromoteBanner"), "No");
  const genieAfter = await bytes(GENIE);
  // The flag itself is the one column the exclusivity is supposed to move; anything else
  // that differs here would be collateral damage in a row this save never mentioned.
  const movedGenie = diffCols(genieAfter.cols, genieSeeded.row, genieAfter.row).filter(
    (c) => c !== "ePromoteBanner",
  );
  ok("  and lost nothing else — every other column of that row is verbatim",
    movedGenie.length === 0, movedGenie.join(", "));

  const back = await put(`/genie-service-content/genie/${GENIE}`, { settings: { ePromoteBanner: "Yes" } });
  eq("promoting from the other screen reports the Runner row", back.status, 200);
  ok("  with the cleared count naming one row", back.json?.promotedCleared === 1, String(back.json?.promotedCleared));
  eq("  and the table agrees", (await promotedIds()).join(","), String(GENIE));

  const off = await put(`/genie-service-content/genie/${GENIE}`, { settings: { ePromoteBanner: "No" } });
  eq("switching it off leaves nothing promoted", off.status, 200);
  eq("  as promised", (await promotedIds()).length, 0);

  await resetPristine(GENIE, ["ePromoteBanner"]);
  await isWhole("the Genie row is byte-identical to the snapshot", GENIE);
  await isWhole("and the Runner row never kept a flag", RUNNER);
}

console.log("\n--- status: one row's switch, nothing else ---");
{
  const off = await patch(`/genie-service-content/runner/${RUNNER}/status`, { status: "Inactive" });
  eq("the Runner row can be switched off", off.status, 200);
  eq("  in the DTO", off.json?.item?.status, "Inactive");
  eq("  in the column", await value(RUNNER, "eStatus"), "Inactive");
  await isWhole("the Genie row did not move", GENIE);

  const scoped = await get(`/genie-service-content/runner/list`);
  eq("the app's list still shows its own row, now Inactive", scoped.json?.items?.[0]?.status, "Inactive");
  const other = await get(`/genie-service-content/genie/list`);
  eq("  and the other app's list is unaffected", other.json?.items?.[0]?.status, "Active");

  const bad = await patch(`/genie-service-content/runner/${RUNNER}/status`, { status: "Paused" });
  eq("a status the DDL does not have is refused", bad.status, 400);

  const on = await patch(`/genie-service-content/runner/${RUNNER}/status`, { status: "Active" });
  eq("and it comes back", on.json?.item?.status, "Active");
  await isWhole("the Runner row's other bytes never moved during the flip", RUNNER);
}

console.log("\n--- a save repeating everything the row already holds ---");
{
  const detail = (await get(`/genie-service-content/runner/${RUNNER}`)).json?.item;
  const verbatim = {
    names: { ...detail.names },
    settings: {
      ePromoteBanner: detail.settings.ePromoteBanner,
      iDisplayOrder: Number(detail.settings.iDisplayOrder),
      iDisplayOrderHomepage: Number(detail.settings.iDisplayOrderHomepage),
    },
    copy: Object.fromEntries(
      detail.blobs.map((b) => [b.key, { ...b.values }]),
    ),
  };
  const res = await put(`/genie-service-content/runner/${RUNNER}`, verbatim);
  eq("the save without the unset OTP is accepted", res.status, 200);
  await isWhole("  and rewrote nothing — the row is byte-identical", RUNNER);

  const withOtp = await put(`/genie-service-content/runner/${RUNNER}`, {
    ...verbatim,
    settings: { ...verbatim.settings, eOTPCodeEnable: detail.settings.eOTPCodeEnable },
  });
  refused(
    "adding the stored-but-unwritable OTP value back refuses the whole save",
    withOtp,
    "cannot be saved as blank",
  );
  await isWhole("  leaving the row untouched rather than half-saved", RUNNER);
}

console.log("\n--- artwork: the columns, the bytes, and the orphan a refusal must not leave ---");
{
  const dir = path.join(UPLOAD_ROOT, "VehicleCategory");
  const files = () => (existsSync(dir) ? readdirSync(dir) : []);
  const png = new Blob([Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c636000000200010000050001f1a2c7ff0000000049454e44ae426082", "hex")], {
    type: "image/png",
  });

  const before = files().length;
  const form = new FormData();
  form.append("file", png, "runner-test.png");
  const cross = await call("POST", `/genie-service-content/runner/${GENIE}/image/promote`, form, true);
  notFound("POST /runner/280/image/promote (Genie's row) is 404", cross, "No Delivery Runner service content row #280");
  eq("  and the file multer already wrote is unlinked again", files().length, before);

  const emptyForm = new FormData();
  const nofile = await call("POST", `/genie-service-content/runner/${RUNNER}/image/promote`, emptyForm, true);
  refused("a multipart POST with no file is refused", nofile, "No file uploaded.");
  const txt = new FormData();
  txt.append("file", new Blob(["not an image"], { type: "text/plain" }), "note.txt");
  const wrong = await call("POST", `/genie-service-content/runner/${RUNNER}/image/promote`, txt, true);
  refused("a file that is not an image is refused", wrong, "Unsupported file type");
  eq("  and the column still names nothing", await value(RUNNER, "vPromoteBannerImage"), "");
  eq("  still no orphan on disk", files().length, before);

  const up = new FormData();
  up.append("file", png, "runner-promote.png");
  const res = await call("POST", `/genie-service-content/runner/${RUNNER}/image/promote`, up, true);
  eq("attaching a banner image to the Runner row is accepted", res.status, 200);
  const stored = String(res.json?.item?.images?.find((i) => i.slot === "promote")?.value ?? "");
  ok("  the column names the new file", /\.png$/.test(stored), stored);
  ok("  the file is inside this app's upload root", files().includes(stored), `${stored} in ${files().join(",")}`);
  const stream = await call("GET", `/genie-service-content/runner/${RUNNER}/image/promote`);
  eq("  and it streams back", stream.status, 200);
  eq("    as an image", stream.headers.get("content-type"), "image/png");

  await resetPristine(RUNNER, ["vPromoteBannerImage"]);
  eq("the column is empty again, as the snapshot held it", await value(RUNNER, "vPromoteBannerImage"), "");
  const orphan = path.join(dir, stored);
  if (existsSync(orphan)) unlinkSync(orphan);
  eq("  and this run leaves no uploaded file behind", files().length, before);
  await isWhole("the whole Runner row matches its starting bytes", RUNNER);
  await isWhole("the Genie row matches its own", GENIE);
}

console.log(`\nb144-write: ${pass} ok, ${failures.length} failed`);
if (failures.length) console.log(failures.map((f) => ` - ${f}`).join("\n"));
console.log("expected next: node scripts/b144.mjs restore  (it should report 0 columns rewritten)");
console.log("               node scripts/b144.mjs fingerprint after && diff .lh/b144-before.txt .lh/b144-after.txt");

await db.end();
process.exit(failures.length ? 1 : 0);
