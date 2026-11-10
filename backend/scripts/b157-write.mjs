// Write matrix for Delivery Runner → Delivery Charges (#sub-157).
//
// There is no runner slice of `delivery_charges` to write into. The table has no service-line
// column at all, and `delivery_charges.php` used `?eType=runner` only to re-suffix the five
// keys it checked and rename its page script (lines 13–31), leaving a list query of
// `WHERE 1 = 1` (lines 106, 131). So every write below moves the row the Genie menu (#sub-154)
// lists, edits and deletes, and each phase re-reads through the *other* menu to prove it:
// a create through runner appears in genie's list, money written by runner is the money genie
// reads, a band genie froze is frozen for runner too, and either menu can delete a scheme the
// other one made. The only thing the `:app` segment changes is which key family guards the
// call, which is also why the audit log must stay app-agnostic.
//
// Two live facts are worked with rather than around: `location_master` holds NO zone tagged
// `eFor='UserDeliveryCharge'`, so the zones the band rules need are seeded here and dropped
// again; and the table ships exactly ONE row (#1, All locations, band 0→200), which this run
// edits and puts back byte-for-byte but never deletes, so the install's own pricing survives
// even if a phase throws.
//
//   node scripts/b157.mjs snapshot
//   node scripts/b157-write.mjs
//   node scripts/b157.mjs restore
import { setTimeout as sleep } from "node:timers/promises";
import mysql from "mysql2/promise";
import "dotenv/config";

const API = process.env.B157_API ?? "http://localhost:4000/api";
const EMAIL = "admin.test@ondemand.local";
const PASSWORD = "TestPass123!";
/** `readScreenMeta` caches the switches for 60s, so a flipped one has to age out. */
const TTL = 65_000;
const OPEN = 100_000_000;
const DISTANCE_FLAG = "ENABLE_CUSTOM_DELIVERY_CHARGE_ORDER";
const BUY_FLAG = "ENABLE_BUY_ANY_SERVICE_MODULE";
/** The one scheme this install shipped. Borrowed, never deleted. */
const SHIPPED = 1;
/** A real zone id, tagged for a different screen, so it must be refused here. */
const FOREIGN_ZONE = 3;

const db = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

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
  ok(
    label,
    String(actual) === String(want),
    `got ${JSON.stringify(actual)}, want ${JSON.stringify(want)}`,
  );
}

/** Float columns come back as numbers or numeric strings, so compare values, not storage. */
function numEq(label, actual, want) {
  const a = Number(actual);
  ok(
    label,
    Number.isFinite(a) && a === Number(want),
    `got ${JSON.stringify(actual)}, want ${want}`,
  );
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

let cookie = "";

async function call(method, pathname, body) {
  const headers = { "X-Requested-With": "XMLHttpRequest" };
  if (cookie) headers.cookie = cookie;
  let payload;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${API}${pathname}`, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, json, text };
}

const get = (p) => call("GET", p);
const post = (p, b) => call("POST", p, b);
const put = (p, b) => call("PUT", p, b);
const patch = (p, b) => call("PATCH", p, b);
const del = (p, b) => call("DELETE", p, b);

/** A refusal's text, however it arrived: the service states its own reason, while a
 * route-level zod failure only says "Validation failed" and hides the wording under
 * `details`. Both are searched, so a test can name the phrase either way. */
function message(res) {
  const err = res.json?.error;
  if (!err) return JSON.stringify(res.json ?? "").slice(0, 200);
  const details = (err.details ?? []).map((d) => d.message).join("; ");
  return [err.message, details].filter(Boolean).join(" — ").slice(0, 300);
}

/** Refused, with the phrase the screen would show the admin. */
function refused(label, res, phrase) {
  ok(
    label,
    res.status === 400 && message(res).includes(phrase),
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

async function columns() {
  const [rows] = await db.query("SHOW COLUMNS FROM delivery_charges");
  return rows.map((c) => c.Field);
}

async function row(id) {
  return one(
    `SELECT iDeliveyChargeId AS id, iLocationId, iDistanceRangeFrom AS dFrom, iDistanceRangeTo AS dTo,
            fOrderPriceValue AS orderPrice, fDeliveryChargeAbove AS above, fDeliveryChargeBelow AS below,
            fFreeOrderPriceSubtotal AS freeSubtotal, iFreeDeliveryRadius AS freeRadius,
            fDeliveryChargeBuyAnyService AS anySvc,
            fDeliveryChargeBuyAnyServiceCancelledOrder AS anySvcCancel, eStatus
       FROM delivery_charges WHERE iDeliveyChargeId = ? LIMIT 1`,
    [id],
  );
}

/** Every column of one row, as the table stores it — for the "no per-app stamping" check. */
async function wholeRow(id) {
  const cols = await columns();
  const [rows] = await db.query(
    `SELECT ${cols.map((c) => `\`${c}\``).join(", ")} FROM delivery_charges
      WHERE iDeliveyChargeId = ? LIMIT 1`,
    [id],
  );
  return { cols, row: rows[0] ?? null };
}

async function liveCount() {
  const r = await one("SELECT COUNT(*) AS n FROM delivery_charges WHERE eStatus <> 'Deleted'");
  return Number(r.n);
}

async function totalCount() {
  const r = await one("SELECT COUNT(*) AS n FROM delivery_charges");
  return Number(r.n);
}

async function liveAtZone(locationId) {
  const r = await one(
    "SELECT COUNT(*) AS n FROM delivery_charges WHERE eStatus <> 'Deleted' AND iLocationId = ?",
    [locationId],
  );
  return Number(r.n);
}

async function nextId() {
  const r = await one("SELECT COALESCE(MAX(iDeliveyChargeId), 0) + 1 AS n FROM delivery_charges");
  return Number(r.n);
}

async function setFlag(name, value) {
  await db.query("UPDATE configurations SET `vValue` = ? WHERE vName = ?", [value, name]);
}

async function flagValue(name) {
  const r = await one("SELECT `vValue` AS v FROM configurations WHERE vName = ? LIMIT 1", [name]);
  return r?.v;
}

/** A zone the location dropdown can offer, tagged the way the legacy form filters it. */
const seeded = [];
async function seedZone(name) {
  const r = await one("SELECT COALESCE(MAX(iLocationId), 0) + 1 AS n FROM location_master");
  const id = Number(r.n);
  await db.query(
    `INSERT INTO location_master (iLocationId, iCountryId, vLocationName, tLatitude, tLongitude,
        eStatus, eFor, eSiteDemo, tCentroidLattitude, tCentroidLongitude, vLocationAddress)
      VALUES (?, 213, ?, '', '', 'Active', 'UserDeliveryCharge', 'No', '', '', ?)`,
    [id, name, name],
  );
  seeded.push(id);
  return id;
}

async function cleanUp() {
  await setFlag(DISTANCE_FLAG, "Yes");
  await setFlag(BUY_FLAG, "Yes");
  if (seeded.length) {
    await db.query(
      `DELETE FROM location_master WHERE iLocationId IN (${seeded.map(() => "?").join(",")})`,
      seeded,
    );
  }
}

/** A complete, legal body for one band of one location. */
function charge(from, to, over = {}) {
  return {
    fOrderPriceValue: 100,
    fDeliveryChargeAbove: 10,
    fDeliveryChargeBelow: 8,
    fFreeOrderPriceSubtotal: 500,
    iFreeDeliveryRadius: 5,
    fDeliveryChargeBuyAnyService: 20,
    fDeliveryChargeBuyAnyServiceCancelledOrder: 6,
    iDistanceRangeFrom: from,
    iDistanceRangeTo: to,
    ...over,
  };
}

/** The same body with the two Buy Any Service amounts left out, for the switch-off half. */
function noBuy(settings) {
  const out = { ...settings };
  delete out.fDeliveryChargeBuyAnyService;
  delete out.fDeliveryChargeBuyAnyServiceCancelledOrder;
  return out;
}

/** The ids one menu lists, so "genie sees it too" is a comparison, not a hope. */
async function listedIds(app, query = "") {
  const res = await get(`/delivery-charge/${app}/list${query}`);
  return (res.json?.items ?? []).map((i) => i.id);
}

/** The audit INSERT is deliberately not awaited, so a test has to poll for the row. */
async function sawAudit(event, sinceId) {
  for (let i = 0; i < 20; i += 1) {
    const [rows] = await db.query(
      "SELECT id FROM admin_audit_log WHERE event = ? AND id > ? LIMIT 1",
      [event, sinceId],
    );
    if (rows.length) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

const created = [];
/** Rows that are still live because the run only edited or deactivated them. */
let made = 0;
/** Two of the schemes this run creates, kept out of the section blocks so a later phase can
 * edit, freeze, deactivate or delete them: the 0→50 band of zone one, and the scheme genie
 * made in zone four. Ids are not known in advance — the table is keyless and counts from 1. */
let z2a = 0;
let genieTwin = 0;

async function createVia(app, locationId, settings) {
  const res = await post(`/delivery-charge/${app}`, { locationId, settings });
  const id = res.json?.item?.id ?? 0;
  if (res.status === 201) {
    created.push(id);
    made += 1;
  }
  return { ...res, id };
}

// ---------------------------------------------------------------------------

await login();

const baseline = await liveCount();
const totalBefore = await totalCount();
const shipped = await wholeRow(SHIPPED);
const auditMark = Number((await one("SELECT COALESCE(MAX(id),0) AS id FROM admin_audit_log", [])).id);

console.log(
  `\nbaseline: ${baseline} live row(s) of ${totalBefore} total; #${SHIPPED} = location ${
    (await row(SHIPPED))?.iLocationId
  }, band ${(await row(SHIPPED))?.dFrom}→${(await row(SHIPPED))?.dTo}`,
);

try {
  const z1 = await seedZone("ZZ b157 zone one");
  const z2 = await seedZone("ZZ b157 zone two");
  const z3 = await seedZone("ZZ b157 zone three");
  const z4 = await seedZone("ZZ b157 zone four");
  const z5 = await seedZone("ZZ b157 zone five");
  console.log(`seeded zones ${[z1, z2, z3, z4, z5].join(" ")} as eFor='UserDeliveryCharge' (dropped at the end)`);

  // =========================================================================
  console.log("\n--- the table both menus price, before anything is written ---");
  {
    eq("one live scheme today", baseline, 1);
    eq("runner lists the shipped row", (await listedIds("runner")).join(","), String(SHIPPED));
    eq("genie lists the same row", (await listedIds("genie")).join(","), String(SHIPPED));
    const asRunner = await get("/delivery-charge/runner/list");
    const asGenie = await get("/delivery-charge/genie/list");
    ok("runner list body == genie list body",
      JSON.stringify(asRunner.json) === JSON.stringify(asGenie.json), "the two lists differ");
    eq("distance-wise is on, so a scheme owns one band", asRunner.json?.features?.distanceWise, true);
    ok("Buy Any Service is on, and it is the *Genie* feature both menus test",
      asRunner.json?.features?.buyAnyService === true, JSON.stringify(asRunner.json?.features));
  }

  // =========================================================================
  console.log("\n--- a create through the runner menu is genie's row from the first second ---");
  {
    const wantId = await nextId();
    const made1 = await createVia("runner", 0, charge(300, 400, { fOrderPriceValue: 120 }));
    eq("POST /delivery-charge/runner (band 300-400 of All locations) -> 201", made1.status, 201);
    eq("  it took the next free id of the shared table", made1.id, wantId);
    const stored = await row(made1.id);
    eq("  the location is the sentinel, not a runner-only scope", stored?.iLocationId, 0);
    eq("  the band is stored", `${stored?.dFrom}-${stored?.dTo}`, "300-400");
    eq("  and the row starts Active, the way the legacy form left it", stored?.eStatus, "Active");
    ok("genie's list carries the row runner created",
      (await listedIds("genie")).includes(made1.id), (await listedIds("genie")).join(","));
    eq("  the live count grew by exactly one", await liveCount(), baseline + 1);
    const asRunner = await get(`/delivery-charge/runner/${made1.id}`);
    const asGenie = await get(`/delivery-charge/genie/${made1.id}`);
    ok("the two menus read the new row identically",
      JSON.stringify(asRunner.json) === JSON.stringify(asGenie.json), "details differ");
    numEq("  the DTO carries the money it stored", asGenie.json?.item?.settings?.fOrderPriceValue, 120);

    const open = await createVia("runner", z1, charge(0, OPEN));
    eq("POST an open-ended band of a seeded zone -> 201", open.status, 201);
    const gList = await get("/delivery-charge/genie/list");
    const seen = (gList.json?.items ?? []).find((i) => i.id === open.id);
    eq("genie reports it as open-ended", seen?.distanceOpen, true);
    eq("  at the sentinel of the band columns", seen?.distanceTo, OPEN);

    // Both menus write the same 12 columns and nothing else: no app marker, no copy.
    const byRunner = await createVia("runner", z3, charge(0, 25));
    const byGenie = await createVia("genie", z4, charge(0, 25));
    genieTwin = byGenie.id;
    eq("a twin scheme created through genie instead -> 201", byGenie.status, 201);
    const a = await wholeRow(byRunner.id);
    const b = await wholeRow(byGenie.id);
    const differing = a.cols.filter(
      (c) =>
        c !== "iDeliveyChargeId" &&
        c !== "iLocationId" &&
        String(a.row?.[c]) !== String(b.row?.[c]),
    );
    ok("the two rows differ in nothing but their id and their zone",
      differing.length === 0, `columns ${differing.join(", ")}`);
    eq("  which is the whole table's column list", a.cols.length, 12);
  }

  // =========================================================================
  console.log("\n--- the band rules are one table's rules, asked from either menu ---");
  {
    const clash = await post("/delivery-charge/genie", { locationId: 0, settings: charge(350, 380) });
    refused("a genie band inside the band runner created -> 400", clash, "already covers");
    ok("  and it names the band as the list would", message(clash).includes("300 – 400"), message(clash));

    const overShipped = await post("/delivery-charge/runner", { locationId: 0, settings: charge(100, 150) });
    refused("a runner band inside the shipped row's band -> 400", overShipped, "already covers");

    const notZero = await post("/delivery-charge/runner", { locationId: z2, settings: charge(10, 50) });
    refused("a first band that does not start at 0 -> 400", notZero, "must start at 0");

    const first = await createVia("runner", z2, charge(0, 50));
    z2a = first.id;
    eq("the same zone from 0 -> 201", first.status, 201);

    const adjacent = await post("/delivery-charge/genie", { locationId: z2, settings: charge(50, 100) });
    eq("an adjacent band through the other menu -> 201", adjacent.status, 201);
    created.push(adjacent.json?.item?.id ?? 0);
    made += 1;

    const inside = await post("/delivery-charge/genie", { locationId: z2, settings: charge(25, 75) });
    refused("a band spanning two bands runner laid out -> 400", inside, "already covers");

    const reversed = await post("/delivery-charge/runner", { locationId: z2, settings: charge(600, 500) });
    refused("a band that ends before it starts -> 400", reversed, "must be greater than");

    const foreign = await post("/delivery-charge/runner", { locationId: FOREIGN_ZONE, settings: charge(0, 50) });
    refused("a zone tagged for another screen -> 400", foreign, "not a delivery-charge zone");

    const ghost = await post("/delivery-charge/runner", { locationId: 987654, settings: charge(0, 50) });
    refused("a zone that does not exist -> 400", ghost, "not a delivery-charge zone");

    const noLocation = await post("/delivery-charge/runner", { settings: charge(700, 800) });
    ok("a create with no location at all -> 400", noLocation.status === 400, `status ${noLocation.status}`);

    const empty = await post("/delivery-charge/runner", { locationId: 0, settings: {} });
    refused("an empty settings map -> 400", empty, "at least one value");

    const text = await post("/delivery-charge/runner", {
      locationId: 0,
      settings: charge(700, 800, { fOrderPriceValue: "twelve" }),
    });
    refused("a non-numeric amount -> 400", text, "must be a number");

    const bogusKey = await post("/delivery-charge/runner", {
      locationId: 0,
      settings: { fOrderPriceValue: 10, iRunnerOnlyColumn: 1 },
    });
    refused("a column this table does not own -> 400", bogusKey, "Unknown delivery-charge value");

    const store = await post("/delivery-charge/store", { locationId: 0, settings: charge(700, 800) });
    ok("POST /delivery-charge/store -> 400 (no such menu)", store.status === 400, `status ${store.status}`);

    eq("and none of the refusals wrote anything", await liveCount(), baseline + made);
  }

  // =========================================================================
  console.log("\n--- money written by the runner is the money genie reads ---");
  {
    const target = z2a; // the 0→50 band of zone one, laid out by the runner menu
    const stored = await row(target);
    console.log(`  editing #${target} (location ${stored?.iLocationId}, band ${stored?.dFrom}→${stored?.dTo})`);

    const byRunner = await put(`/delivery-charge/runner/${target}`, {
      settings: { fOrderPriceValue: 175, fDeliveryChargeAbove: 12.5 },
    });
    eq("PUT through the runner -> 200", byRunner.status, 200);
    const afterRun = await row(target);
    numEq("  order total rewritten", afterRun?.orderPrice, 175);
    numEq("  charge above rewritten", afterRun?.above, 12.5);
    numEq("  charge below untouched", afterRun?.below, 8);
    const asGenie = await get(`/delivery-charge/genie/${target}`);
    numEq("genie reads the number runner wrote", asGenie.json?.item?.settings?.fOrderPriceValue, 175);

    const byGenie = await put(`/delivery-charge/genie/${target}`, { settings: { fDeliveryChargeBelow: 9 } });
    eq("PUT through genie -> 200", byGenie.status, 200);
    numEq("  the column genie wrote is stored", (await row(target))?.below, 9);
    const asRunner = await get(`/delivery-charge/runner/${target}`);
    numEq("runner reads the number genie wrote", asRunner.json?.item?.settings?.fDeliveryChargeBelow, 9);
    const nowGenie = await get(`/delivery-charge/genie/${target}`);
    ok("and the two menus still cannot tell the row apart",
      JSON.stringify(asRunner.json) === JSON.stringify(nowGenie.json), "details differ");

    const nothing = await put(`/delivery-charge/runner/${target}`, {});
    refused("PUT with an empty body -> 400", nothing, "Send the location");

    const blankRequired = await put(`/delivery-charge/runner/${target}`, { settings: { fOrderPriceValue: "" } });
    refused("blanking a required amount -> 400", blankRequired, "is required");

    const blankOptional = await put(`/delivery-charge/genie/${target}`, { settings: { iFreeDeliveryRadius: "" } });
    eq("blanking an optional amount through genie -> 200", blankOptional.status, 200);
    numEq("  radius stored as 0", (await row(target))?.freeRadius, 0);

    const outRange = await put(`/delivery-charge/runner/${target}`, { settings: { fOrderPriceValue: 1e12 } });
    refused("an out-of-range amount -> 400", outRange, "between 0 and");

    const ghost = await put("/delivery-charge/runner/999999", { settings: { fOrderPriceValue: 1 } });
    eq("PUT a row that does not exist -> 404", ghost.status, 404);
  }

  // =========================================================================
  console.log("\n--- the shipped scheme: borrowed by both menus, returned untouched ---");
  {
    const before = await wholeRow(SHIPPED);
    const up = await put(`/delivery-charge/runner/${SHIPPED}`, { settings: { fOrderPriceValue: 60 } });
    eq("PUT the shipped row through the runner -> 200", up.status, 200);
    numEq("  genie reads the new order total",
      (await get(`/delivery-charge/genie/${SHIPPED}`)).json?.item?.settings?.fOrderPriceValue, 60);

    const moved = await put(`/delivery-charge/runner/${SHIPPED}`, { locationId: z1 });
    refused("change its location -> 400", moved, "location is fixed");
    const movedBack = await put(`/delivery-charge/genie/${SHIPPED}`, { locationId: z2 });
    refused("the same attempt through genie -> 400", movedBack, "location is fixed");
    eq("  and it still prices every location", (await row(SHIPPED))?.iLocationId, 0);

    const widened = await put(`/delivery-charge/runner/${SHIPPED}`, {
      settings: { iDistanceRangeFrom: 0, iDistanceRangeTo: 199 },
    });
    refused("narrow its band -> 400", widened, "band is fixed");
    const widenedBack = await put(`/delivery-charge/genie/${SHIPPED}`, {
      settings: { iDistanceRangeFrom: 1, iDistanceRangeTo: 200 },
    });
    refused("shift its band through the other menu -> 400", widenedBack, "band is fixed");

    const echo = await put(`/delivery-charge/genie/${SHIPPED}`, {
      settings: { iDistanceRangeFrom: 0, iDistanceRangeTo: 200, fDeliveryChargeAbove: 6 },
    });
    eq("echoing the stored band saves the money -> 200", echo.status, 200);
    eq("  the band is exactly where it was", `${(await row(SHIPPED))?.dFrom}-${(await row(SHIPPED))?.dTo}`, "0-200");

    const back = await put(`/delivery-charge/genie/${SHIPPED}`, {
      settings: { fOrderPriceValue: 50, fDeliveryChargeAbove: 5 },
    });
    eq("put both amounts back -> 200", back.status, 200);
    const after = await wholeRow(SHIPPED);
    const drifted = before.cols.filter((c) => String(before.row?.[c]) !== String(after.row?.[c]));
    ok("the shipped row is back on every one of its 12 columns",
      drifted.length === 0, `columns ${drifted.join(", ")}`);
  }

  // =========================================================================
  console.log("\n--- status and scope freeze reach the other menu too ---");
  {
    const target = z2a;
    const off = await patch(`/delivery-charge/runner/${target}/status`, { status: "Inactive" });
    eq("PATCH /runner/.../status to Inactive -> 200", off.status, 200);
    eq("  the shared row is Inactive", (await row(target))?.eStatus, "Inactive");
    eq("  genie's detail says so too",
      (await get(`/delivery-charge/genie/${target}`)).json?.item?.status, "Inactive");
    ok("  and it drops out of genie's Active filter",
      !(await listedIds("genie", "?status=Active")).includes(target), (await listedIds("genie", "?status=Active")).join(","));
    ok("  and shows up in the runner's Inactive one",
      (await listedIds("runner", "?status=Inactive")).includes(target), (await listedIds("runner", "?status=Inactive")).join(","));

    const bogus = await patch(`/delivery-charge/runner/${target}/status`, { status: "Deleted" });
    ok("PATCH to Deleted is refused (that is what DELETE is for)", bogus.status === 400, `status ${bogus.status}`);
    eq("  the row kept the status the other menu set", (await row(target))?.eStatus, "Inactive");

    const on = await patch(`/delivery-charge/genie/${target}/status`, { status: "Active" });
    eq("PATCH back to Active through genie -> 200", on.status, 200);
    eq("  the runner reads it as Active", (await get(`/delivery-charge/runner/${target}`)).json?.item?.status, "Active");

    const shift = await put(`/delivery-charge/runner/${target}`, {
      settings: { iDistanceRangeFrom: 0, iDistanceRangeTo: 400 },
    });
    refused("widening a band another menu's band owns -> 400", shift, "already covers");
    const shiftBack = await put(`/delivery-charge/genie/${target}`, { locationId: z5 });
    refused("moving it to a zone only the other menu would use -> 400", shiftBack, "location is fixed");
  }

  // =========================================================================
  console.log("\n--- either menu can delete a scheme the other one made ---");
  {
    const runnerMade = await createVia("runner", z5, charge(0, 60));
    eq("create a scheme in the runner menu -> 201", runnerMade.status, 201);
    const victim = runnerMade.id;

    const wrong = await del(`/delivery-charge/genie/${victim}`, { confirm: "somewhere else" });
    refused("DELETE it from genie with the wrong confirmation -> 400", wrong, "does not match");
    ok("  and it names the zone the runner chose", message(wrong).includes("ZZ b157 zone five"), message(wrong));

    const bare = await del(`/delivery-charge/genie/${victim}`, {});
    ok("DELETE with no confirmation -> 400", bare.status === 400, `status ${bare.status}`);

    const beforeLive = await liveCount();
    const beforeTotal = await totalCount();
    const gone = await del(`/delivery-charge/genie/${victim}`, { confirm: "ZZ b157 zone five" });
    eq("DELETE a runner scheme from the genie menu -> 200", gone.status, 200);
    eq("  it answers with the shared location label", gone.json?.label, "ZZ b157 zone five");
    eq("  the row is kept and marked Deleted", (await row(victim))?.eStatus, "Deleted");
    eq("  the live count dropped by one", await liveCount(), beforeLive - 1);
    eq("  the table kept the row", await totalCount(), beforeTotal);
    eq("GET it from genie -> 404", (await get(`/delivery-charge/genie/${victim}`)).status, 404);
    eq("GET the same id from runner -> 404", (await get(`/delivery-charge/runner/${victim}`)).status, 404);
    eq("PUT it from runner -> 404", (await put(`/delivery-charge/runner/${victim}`, { settings: { fOrderPriceValue: 1 } })).status, 404);
    eq("PATCH it from genie -> 404", (await patch(`/delivery-charge/genie/${victim}/status`, { status: "Active" })).status, 404);
    eq("DELETE it again from runner -> 404",
      (await del(`/delivery-charge/runner/${victim}`, { confirm: "ZZ b157 zone five" })).status, 404);
    const repriced = await createVia("runner", z5, charge(0, 60));
    eq("  the zone is priceable again once its scheme is hidden -> 201", repriced.status, 201);

    // And the reverse: the scheme genie made in zone four, removed by the runner menu. The
    // label both menus read back for it is the same string, because both read the same
    // `location_master` row — the confirmation gate is shared too.
    const label = (await get(`/delivery-charge/genie/${genieTwin}`)).json?.item?.scope?.label;
    eq("  genie calls the zone by the name the runner menu would type", label, "ZZ b157 zone four");
    const byRunner = await del(`/delivery-charge/runner/${genieTwin}`, { confirm: label });
    eq(`DELETE genie's scheme #${genieTwin} from the runner menu -> 200`, byRunner.status, 200);
    eq("  the row is hidden, not erased", (await row(genieTwin))?.eStatus, "Deleted");
    eq("  and genie can no longer read it", (await get(`/delivery-charge/genie/${genieTwin}`)).status, 404);

    eq("the shipped scheme survived all of this", (await row(SHIPPED))?.eStatus, "Active");
    ok("and both menus still list it",
      (await listedIds("runner")).includes(SHIPPED) && (await listedIds("genie")).includes(SHIPPED),
      `${(await listedIds("runner")).join(",")} / ${(await listedIds("genie")).join(",")}`);
  }

  // =========================================================================
  console.log("\n--- the runner menu writes genie's audit events, not its own ---");
  {
    for (const event of [
      "delivery_charge_created",
      "delivery_charge_updated",
      "delivery_charge_status_changed",
      "delivery_charge_deleted",
    ]) {
      ok(`audit saw ${event}`, await sawAudit(event, auditMark), "nothing in admin_audit_log");
    }
    // One event name per action for every app: registering runner must not have minted a
    // runner-suffixed family that reports writes no report reads.
    const twins = await one(
      "SELECT COUNT(*) AS n FROM admin_audit_log WHERE event LIKE 'delivery_charge_%_runner'",
      [],
    );
    numEq("no runner-suffixed audit events exist", twins?.n, 0);
  }

  // =========================================================================
  console.log(`\n--- flipping ${BUY_FLAG} to No (waiting ${TTL / 1000}s for the meta cache) ---`);
  {
    // The legacy Buy Any gate is `isEnableGenieFeature('Yes') || isEnableGenieFeature('Yes')`
    // (delivery_charges.php:174): the same Genie call twice, on the runner page too. So one
    // switch decides the two extra fields for BOTH menus, and the menus cannot disagree.
    await setFlag(BUY_FLAG, "No");
    await sleep(TTL);

    const r = await get("/delivery-charge/runner/list");
    const g = await get("/delivery-charge/genie/list");
    eq("the runner loses the Buy Any fields", r.json?.features?.buyAnyService, false);
    eq("  and so does genie, from the same switch", g.json?.features?.buyAnyService, false);
    const specs = await get("/delivery-charge/runner/defaults");
    eq("seven specs remain in the runner form", specs.json?.item?.fieldSpecs?.length, 7);
    ok("  the two Buy Any columns are gone",
      !(specs.json?.item?.fieldSpecs ?? []).some((f) => f.column === "fDeliveryChargeBuyAnyService"),
      (specs.json?.item?.fieldSpecs ?? []).map((f) => f.column).join(","));
    const genieSpecs = await get("/delivery-charge/genie/defaults");
    eq("genie's spec list is the same length", genieSpecs.json?.item?.fieldSpecs?.length, 7);

    const sent = await post("/delivery-charge/runner", { locationId: z3, settings: noBuy(charge(500, 600)) });
    ok("a create without the gated fields -> 201", sent.status === 201, `status ${sent.status}`);
    if (sent.status === 201) {
      created.push(sent.json?.item?.id ?? 0);
      made += 1;
      const stored = await row(sent.json?.item?.id);
      numEq("  the gated columns stored 0, as the legacy save wrote them", stored?.anySvc, 0);
    }
    const gated = await post("/delivery-charge/runner", {
      locationId: 0,
      settings: { fOrderPriceValue: 10, fDeliveryChargeBuyAnyService: 5 },
    });
    refused("sending a gated field from the runner -> 400", gated, "only editable while Buy Any Service");
    const gatedBack = await post("/delivery-charge/genie", {
      locationId: 0,
      settings: { fOrderPriceValue: 10, fDeliveryChargeBuyAnyService: 5 },
    });
    refused("the same attempt from genie -> 400", gatedBack, "only editable while Buy Any Service");

    await setFlag(BUY_FLAG, "Yes");
    eq("the switch is back on its shipped value", await flagValue(BUY_FLAG), "Yes");
  }
} catch (err) {
  failures.push(`the run threw: ${err?.message ?? err}`);
  console.log(`  FAIL the run threw — ${err?.stack ?? err}`);
} finally {
  await cleanUp();
  // The switches are back in `configurations`, but `readScreenMeta` still serves the entry it
  // built while Buy Any Service was off until the TTL ages out. Wait it out rather than leave
  // the next script a stale feature map — the same debt b154 pays for the distance-wise flag.
  console.log(`\nwaiting ${TTL / 1000}s for the meta cache to drop the flipped switch`);
  await sleep(TTL);
  console.log(`zones seeded and dropped: ${seeded.join(", ") || "none"}`);
  console.log(`switches now: ${DISTANCE_FLAG}=${await flagValue(DISTANCE_FLAG)}, ${BUY_FLAG}=${await flagValue(BUY_FLAG)}`);
}

// =========================================================================
console.log("\n--- the table after the run, before restore ---");
{
  // The list orders by id DESC, the newest scheme first, so the shipped row is the last one
  // both menus show. Same last row from either menu is another sign the two read one table.
  const runnerIds = await listedIds("runner");
  const genieIds = await listedIds("genie");
  eq("the shipped scheme is the oldest live row of both menus",
    `${runnerIds.at(-1)},${genieIds.at(-1)}`, `${SHIPPED},${SHIPPED}`);
  eq("  and the two menus list the same ids in the same order",
    runnerIds.join(","), genieIds.join(","));
  const after = await wholeRow(SHIPPED);
  const drifted = after.cols.filter((c) => String(shipped.row?.[c]) !== String(after.row?.[c]));
  ok("the row this install shipped is byte-identical to the run's start",
    drifted.length === 0, `columns ${drifted.join(", ")}`);
  eq("distance-wise is still on for the next reader",
    (await get("/delivery-charge/runner/list")).json?.features?.distanceWise, true);
  eq("and Buy Any Service too", (await get("/delivery-charge/runner/list")).json?.features?.buyAnyService, true);
  console.log(`live rows after the run: ${await liveCount()} (baseline ${baseline})`);
  console.log(`total rows after the run: ${await totalCount()} (started ${totalBefore})`);
  console.log("expected: the created rows sit in the table as Deleted until `node scripts/b157.mjs restore`");
}

console.log(`\nb157-write: ${pass} ok, ${failures.length} failed`);
if (failures.length) console.log(failures.map((f) => ` - ${f}`).join("\n"));

await db.end();
process.exit(failures.length ? 1 : 0);
