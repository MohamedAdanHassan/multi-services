// Write matrix for Distance wise Delivery Charges (#sub-155) over the shared legacy
// `custom_delivery_charges_order` table.
//
// Three things make this screen's matrix differ from its parent's, and each gets its own
// phase below:
//
//   - a row's scope is its vehicle type plus a distance band, and the bands of one type are a
//     chain — the first starts at 0, every later one starts where the widest ends. The chain
//     rules are checked against the table as it is at that moment, so the refusals are
//     exercised in sequence rather than in isolation;
//   - the two messages that cannot be reached from clean data (a chain that does not start at
//     0, a type whose last band is gone) are reached by editing the table by hand first, and
//     the hand edit is undone in the same block;
//   - deletes are hard. `delivery_charges` hides a row as `Deleted`; here a hidden row would
//     go on pricing orders, because every app-side reader matches on the distance alone. So
//     every delete below asserts the row is *absent from the table*, and the run ends with
//     `node scripts/b155.mjs restore` as the proof that the live bands come back.
//
// The `ENABLE_CUSTOM_DELIVERY_CHARGE_ORDER` switch is flipped for real once, at the end, since
// it is what decides whether any app reads these bands at all — and unlike the parent screen it
// does not change the shape of a row, so the specs must not move with it.
//
//   node scripts/b155.mjs snapshot
//   node scripts/b155-write.mjs
//   node scripts/b155.mjs restore
import { setTimeout as sleep } from "node:timers/promises";
import mysql from "mysql2/promise";
import "dotenv/config";

const API = process.env.B155_API ?? "http://localhost:4000/api";
const EMAIL = "admin.test@ondemand.local";
const PASSWORD = "TestPass123!";
/** `readScreenMeta` caches the flags + unit for 60s, so a flipped switch has to age out. */
const TTL = 65_000;
const OPEN = 100_000_000;
const DISTANCE_FLAG = "ENABLE_CUSTOM_DELIVERY_CHARGE_ORDER";
const TABLE = "custom_delivery_charges_order";
/** The two DeliverAll types this install offers, and the bands they start with. */
const BIKE = 406;
const CAR = 407;

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
const del = (p, b) => call("DELETE", p, b);

/** A refusal's text, however it arrived: the service states its own reason, while a
 * route-level zod failure only says "Validation failed" and hides the wording the admin
 * would read in `details`. Both are searched, so a test can name the phrase either way. */
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

async function bandRow(id) {
  return one(
    `SELECT iDeliveyChargeId AS id, iVehicleTypeId AS vehicleTypeId, iDistanceRangeFrom AS dFrom,
            iDistanceRangeTo AS dTo, fDeliveryCharge AS done, fDeliveryChargeCancelled AS cancel,
            fDeliveryChargeUser AS userCharge, eStatus
       FROM ${TABLE} WHERE iDeliveyChargeId = ? LIMIT 1`,
    [id],
  );
}

/** Every row of the table, hidden ones included: this screen's deletes do not leave any. */
async function rowCount() {
  const r = await one(`SELECT COUNT(*) AS n FROM ${TABLE}`);
  return Number(r.n);
}

async function rowsOfType(vehicleTypeId) {
  const [rows] = await db.query(
    `SELECT iDeliveyChargeId AS id, iDistanceRangeFrom AS dFrom, iDistanceRangeTo AS dTo, eStatus
       FROM ${TABLE} WHERE iVehicleTypeId = ? ORDER BY iDistanceRangeFrom`,
    [vehicleTypeId],
  );
  return rows;
}

async function nextId() {
  const r = await one(`SELECT COALESCE(MAX(iDeliveyChargeId), 0) + 1 AS n FROM ${TABLE}`);
  return Number(r.n);
}

/** A band written straight into the table, for the states the screen itself cannot make. */
async function insertBand(row) {
  const id = await nextId();
  await db.query(
    `INSERT INTO ${TABLE} (iDeliveyChargeId, iVehicleTypeId, iDistanceRangeFrom, iDistanceRangeTo,
        fDeliveryCharge, fDeliveryChargeCancelled, fDeliveryChargeUser, eStatus)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      row.vehicleTypeId,
      row.from,
      row.to,
      row.done ?? "1.00",
      row.cancel ?? "0.50",
      row.userCharge ?? "0.00",
      row.eStatus ?? "Active",
    ],
  );
  return id;
}

async function deleteBandSql(id) {
  await db.query(`DELETE FROM ${TABLE} WHERE iDeliveyChargeId = ?`, [id]);
}

async function setFlag(value) {
  await db.query("UPDATE configurations SET `vValue` = ? WHERE vName = ?", [value, DISTANCE_FLAG]);
}

/** Ids this run created, so a throw mid-run cannot leave them behind. */
const created = [];

async function cleanUp() {
  for (const id of created) await deleteBandSql(id);
  // The hand-edit the orphan-chain test makes, undone exactly as it was made.
  await db.query(
    `UPDATE ${TABLE} SET iDistanceRangeFrom = 0 WHERE iDeliveyChargeId = 1 AND iVehicleTypeId = ?`,
    [BIKE],
  );
}

// The band every create below extends. Written as the API spells it, so a phase can be read
// on its own.
function band(from, to, done = "4", cancel = "1") {
  return {
    iDistanceRangeFrom: String(from),
    iDistanceRangeTo: String(to),
    fDeliveryCharge: done,
    fDeliveryChargeCancelled: cancel,
  };
}

// ---------------------------------------------------------------------------

let baseline = 0;
let bikeRow = 1;
let carRow = 2;

await login();

console.log("\n--- baseline: what the live install holds ---");
{
  baseline = await rowCount();
  eq("the table holds two bands", baseline, 2);
  const list = await get("/distance-charge/genie/list");
  eq("GET /distance-charge/genie/list -> 200", list.status, 200);
  eq("  with both of them", list.json?.total, 2);
  const bike = (list.json?.items ?? []).find((i) => i.id === bikeRow);
  const car = (list.json?.items ?? []).find((i) => i.id === carRow);
  eq("row #1 is the motorbike's 0 – 200", bike?.distanceLabel, "0 – 200");
  eq("  labelled with the type, for the delete phrase", bike?.rowLabel, "2 Wheeler / Motorbike 0-200");
  eq("  and priced for every zone", bike?.localizationLabel, "All Locations");
  eq("row #2 is the car's 0 – 100", car?.rowLabel, "Car 0-100");
  numEq("  with no customer surcharge stored", car?.userCharge, 0);
  ok("the list carries no status column of its own", !("eStatus" in (list.json?.items?.[0] ?? {})),
    Object.keys(list.json?.items?.[0] ?? {}).join(","));
}

console.log("\n--- defaults: what the add form is handed ---");
{
  const res = await get("/distance-charge/genie/defaults");
  eq("GET /distance-charge/genie/defaults -> 200", res.status, 200);
  const item = res.json?.item;
  eq("no id yet", item?.id, 0);
  ok("the scope is open on a new row", item?.scopeEditable === true);
  eq("  and frozen on a saved one", (await get("/distance-charge/genie/1")).json?.item?.scopeEditable, false);
  eq("nothing to confirm a delete with", item?.rowLabel, "");
  eq("the band has no upper bound claimed", item?.band?.label, "");
  eq("the distance unit is the configured one", item?.distanceUnit, "KMs");
  eq("amounts are labelled with the default currency", `${item?.currency?.name}${item?.currency?.symbol}`, "USD$");
  eq("distance-wise charges are on", item?.features?.distanceWise, true);
  const columns = (item?.fieldSpecs ?? []).map((f) => f.column).join(",");
  eq(
    "five values are asked about, amounts then band",
    columns,
    "fDeliveryCharge,fDeliveryChargeCancelled,fDeliveryChargeUser,iDistanceRangeFrom,iDistanceRangeTo",
  );
  const user = (item?.fieldSpecs ?? []).find((f) => f.column === "fDeliveryChargeUser");
  ok("  the customer surcharge is readable but not writable", user?.readOnly === true, JSON.stringify(user));
  const to = (item?.fieldSpecs ?? []).find((f) => f.column === "iDistanceRangeTo");
  eq("  the band's upper bound starts at 1", to?.min, 1);
  eq("  and stops below what the ∞ sentinel means", to?.max, 99999);
  const types = (item?.vehicleTypes ?? []).map((t) => t.id).join(",");
  eq("the dropdown offers the DeliverAll types, in display order", types, `${BIKE},${CAR}`);
  ok("  and no type of another service line",
    !(item?.vehicleTypes ?? []).some((t) => t.id === 1), types);
  eq("the motorbike's next band starts where its widest ends", item?.chains?.[BIKE]?.nextFrom, 200);
  eq("  and is not closed", item?.chains?.[BIKE]?.closed, false);
  eq("the car's next band starts at 100", item?.chains?.[CAR]?.nextFrom, 100);
  eq("a blank row stores no amounts as decided", item?.settings?.fDeliveryCharge, "");
  eq("  and the unread surcharge as 0", item?.settings?.fDeliveryChargeUser, "0");
}

console.log("\n--- create: the chain of the car (widest band 0 – 100) ---");
{
  refused("a band above the chain start is refused",
    await post("/distance-charge/genie", { vehicleTypeId: String(CAR), settings: band(0, 50) }),
    "Distance range from must be 100");
  refused("so is one far past it",
    await post("/distance-charge/genie", { vehicleTypeId: CAR, settings: band(250, 300) }),
    "Distance range from must be 100 KMs, where the widest existing band ends");
  refused("an upper bound equal to the start",
    await post("/distance-charge/genie", { vehicleTypeId: CAR, settings: band(100, 100) }),
    "Distance range to must be greater than distance range from");
  refused("a start below the band's own floor is out of range",
    await post("/distance-charge/genie", { vehicleTypeId: CAR, settings: band(-10, 20) }),
    "must be between 0 and 99999");
  refused("a start that is not a number",
    await post("/distance-charge/genie", { vehicleTypeId: CAR, settings: { ...band(100, 200), iDistanceRangeFrom: "abc" } }),
    "must be a number");
  refused("an amount beyond the column's ceiling",
    await post("/distance-charge/genie", { vehicleTypeId: CAR, settings: band(100, 200, "100000") }),
    "must be between 0 and 99999");
  refused("no completed-order amount at all",
    await post("/distance-charge/genie", { vehicleTypeId: CAR, settings: { iDistanceRangeFrom: "100", iDistanceRangeTo: "200", fDeliveryChargeCancelled: "1" } }),
    "is required");
  refused("a blank required amount",
    await post("/distance-charge/genie", { vehicleTypeId: CAR, settings: band(100, 200, "") }),
    "is required");
  refused("the customer surcharge cannot be set",
    await post("/distance-charge/genie", { vehicleTypeId: CAR, settings: { ...band(100, 200), fDeliveryChargeUser: "5" } }),
    "stored, not editable");
  refused("nor can a column the table does not have",
    await post("/distance-charge/genie", { vehicleTypeId: CAR, settings: { ...band(100, 200), fNote: "x" } }),
    "Unknown distance-wise charge value");
  refused("not even the status column, which this screen never writes",
    await post("/distance-charge/genie", { vehicleTypeId: CAR, settings: { ...band(100, 200), eStatus: "Inactive" } }),
    "Unknown distance-wise charge value");
  refused("a vehicle type of another service line",
    await post("/distance-charge/genie", { vehicleTypeId: 1, settings: band(0, 50) }),
    "not an active delivery vehicle type");
  refused("a vehicle type that exists in neither table",
    await post("/distance-charge/genie", { vehicleTypeId: 999999, settings: band(0, 50) }),
    "not an active delivery vehicle type");
  eq("a body naming no vehicle type is refused by the route",
    (await post("/distance-charge/genie", { settings: band(0, 50) })).status, 400);
  eq("an empty body is refused by the route", (await post("/distance-charge/genie", {})).status, 400);
  eq("an empty settings group is refused too",
    (await post("/distance-charge/genie", { vehicleTypeId: CAR, settings: {} })).status, 400);
  eq("and one naming more values than the screen owns",
    (await post("/distance-charge/genie", {
      vehicleTypeId: CAR,
      settings: { ...band(100, 200), a: "1", b: "2" },
    })).status, 400);
  eq("nothing was written by any refusal", await rowCount(), baseline);

  const wantId = await nextId();
  const res = await post("/distance-charge/genie", { vehicleTypeId: String(CAR), settings: band(100, 150, "6.5", "2") });
  eq("the next band of the chain is priced", res.status, 201);
  const id = res.json?.item?.id;
  created.push(id);
  eq("  at MAX(iDeliveyChargeId)+1, since the column has none", id, wantId);
  eq("  with the band the form asked for", res.json?.item?.band?.label, "100 – 150 KMs");
  eq("  and the type it belongs to", res.json?.item?.vehicleType?.name, "Car");
  const stored = await bandRow(id);
  numEq("stored: from 100", stored?.dFrom, 100);
  numEq("stored: to 150", stored?.dTo, 150);
  numEq("stored: completed 6.5", stored?.done, 6.5);
  numEq("stored: cancelled 2", stored?.cancel, 2);
  numEq("stored: the surcharge the form never asked for is 0", stored?.userCharge, 0);
  eq("stored: the row is Active, as every row here is", stored?.eStatus, "Active");
  const again = await post("/distance-charge/genie", { vehicleTypeId: CAR, settings: band(100, 150) });
  refused("the same band cannot be priced twice", again, "Distance range from must be 150");
  refused("and neither can one overlapping it by hand",
    await post("/distance-charge/genie", { vehicleTypeId: CAR, settings: band(120, 160) }),
    "Distance range from must be 150");

  const open = await post("/distance-charge/genie", {
    vehicleTypeId: CAR,
    settings: { ...band(150, OPEN, "9", "3") },
  });
  eq("an open-ended band is accepted", open.status, 201);
  const openId = open.json?.item?.id;
  created.push(openId);
  eq("  sent as the sentinel the list renders as ∞", open.json?.item?.band?.label, "150 – ∞ KMs");
  ok("  flagged open on the record", open.json?.item?.band?.open === true);
  numEq("stored: as 100000000", (await bandRow(openId))?.dTo, OPEN);
  const openList = await get("/distance-charge/genie/list?sort=distanceTo&order=desc");
  const openRow = (openList.json?.items ?? []).find((i) => i.id === openId);
  eq("  and shown as ∞ in the list", openRow?.distanceLabel, "150 – ∞");
  ok("  with the open flag on the row", openRow?.distanceOpen === true);
  refused("no further band fits past an open-ended one",
    await post("/distance-charge/genie", { vehicleTypeId: CAR, settings: band(200, 300) }),
    "already has an open-ended band");
  eq("the defaults now say the type is closed",
    (await get("/distance-charge/genie/defaults")).json?.item?.chains?.[CAR]?.closed, true);
  refused(
    "∞ as text is understood, and is refused for the chain's reason, not as a bad number",
    await post("/distance-charge/genie", { vehicleTypeId: CAR, settings: band(150, "∞") }),
    "already has an open-ended band",
  );
}

console.log("\n--- create: a chain that does not start at 0 (hand-edited data) ---");
{
  // The motorbike's band is moved off 0 for a moment, which is what a hand-edited first band —
  // or one deleted behind the rest — leaves behind. `cleanUp` puts it back, and so does `restore`.
  // The rule the legacy screen enforced ("Distance Range From should start from 0.") is what
  // speaks then, and the overlap check with it: a chain that never reached 0 has a gap in front
  // of it, and a band inside that gap would price nothing the apps can measure.
  await db.query(`UPDATE ${TABLE} SET iDistanceRangeFrom = 50 WHERE iDeliveyChargeId = ?`, [bikeRow]);
  const bike = await rowsOfType(BIKE);
  ok("the motorbike now holds one band, starting above 0", bike.length === 1 && Number(bike[0].dFrom) === 50,
    JSON.stringify(bike));
  eq("  and the defaults still describe its chain as open", (await get("/distance-charge/genie/defaults")).json?.item?.chains?.[BIKE]?.closed, false);

  refused("a band above 0 while no band starts at 0",
    await post("/distance-charge/genie", { vehicleTypeId: BIKE, settings: band(10, 60) }),
    "The first distance range of this vehicle type must start at 0 KMs");
  refused("and one starting at 0 that runs into the existing band",
    await post("/distance-charge/genie", { vehicleTypeId: BIKE, settings: band(0, 60) }),
    "A charge already covers 50 – 200 KMs for this vehicle type");
  refused("nor a band that would sit past it while the chain is broken",
    await post("/distance-charge/genie", { vehicleTypeId: BIKE, settings: band(200, 300) }),
    "The first distance range of this vehicle type must start at 0 KMs");
  eq("still nothing written by any of them", await rowCount(), baseline + 2);

  await db.query(`UPDATE ${TABLE} SET iDistanceRangeFrom = 0 WHERE iDeliveyChargeId = ?`, [bikeRow]);
  eq("the hand edit is undone", (await bandRow(bikeRow))?.dFrom, 0);
  refused("and the car stays closed by its own open-ended band",
    await post("/distance-charge/genie", { vehicleTypeId: CAR, settings: band(150, 200) }),
    "already has an open-ended band");
}

console.log("\n--- update: only the amounts move ---");
{
  const id = created[0];
  const before = await bandRow(id);
  eq("the row being repriced is the one created above", before?.id, id);

  const res = await put(`/distance-charge/genie/${id}`, { settings: { fDeliveryCharge: "7.25" } });
  eq("PUT one changed amount -> 200", res.status, 200);
  numEq("  written to the column", (await bandRow(id))?.done, 7.25);
  numEq("  and the untouched amount keeps its value", (await bandRow(id))?.cancel, 2);
  eq("  the record comes back with the new amount", res.json?.item?.settings?.fDeliveryCharge, "7.25");
  eq("  with the band still the row's own", res.json?.item?.band?.label, "100 – 150 KMs");

  const both = await put(`/distance-charge/genie/${id}`, {
    settings: { fDeliveryCharge: "8", fDeliveryChargeCancelled: "3" },
  });
  eq("both amounts in one save -> 200", both.status, 200);
  numEq("  completed", (await bandRow(id))?.done, 8);
  numEq("  cancelled", (await bandRow(id))?.cancel, 3);

  const verbatim = await put(`/distance-charge/genie/${id}`, {
    vehicleTypeId: String(CAR),
    settings: { ...band(100, 150), fDeliveryCharge: "9" },
  });
  eq("a form that resends the whole scope -> 200", verbatim.status, 200);
  numEq("  writes the amount it changed", (await bandRow(id))?.done, 9);
  numEq("  and leaves the band where it was", (await bandRow(id))?.dTo, 150);

  // Only the frozen scope, no amount: the band is read back, matches, and the save is left
  // with nothing to write — which is refused rather than answered with a silent 200.
  refused("a save that only repeats the band decided nothing",
    await put(`/distance-charge/genie/${id}`, {
      settings: { iDistanceRangeFrom: "100", iDistanceRangeTo: "150" },
    }),
    "Send the amounts that changed");

  refused("a moved start is refused",
    await put(`/distance-charge/genie/${id}`, { settings: { iDistanceRangeFrom: "120" } }),
    "distance band is fixed once it exists");
  refused("so is a moved end",
    await put(`/distance-charge/genie/${id}`, { settings: { iDistanceRangeTo: "180" } }),
    "distance band is fixed once it exists");
  refused("and an open-ended one sent as ∞",
    await put(`/distance-charge/genie/${id}`, { settings: { iDistanceRangeTo: "∞" } }),
    "distance band is fixed once it exists");
  refused("a swapped vehicle type is refused",
    await put(`/distance-charge/genie/${id}`, { vehicleTypeId: BIKE }),
    "vehicle type is fixed once it exists");
  refused("the customer surcharge stays unwritable",
    await put(`/distance-charge/genie/${id}`, { settings: { fDeliveryChargeUser: "4" } }),
    "stored, not editable");
  refused("a column the table does not have is unknown here too",
    await put(`/distance-charge/genie/${id}`, { settings: { fNote: "x" } }),
    "Unknown distance-wise charge value");
  refused("a cleared required amount is a decision, not silence",
    await put(`/distance-charge/genie/${id}`, { settings: { fDeliveryCharge: "" } }),
    "is required");
  refused("an amount beyond the ceiling is out of range",
    await put(`/distance-charge/genie/${id}`, { settings: { fDeliveryCharge: "100000" } }),
    "must be between 0 and 99999");
  eq("a save that changed nothing is refused by the route",
    (await put(`/distance-charge/genie/${id}`, { settings: {} })).status, 400);
  eq("so is an entirely empty body", (await put(`/distance-charge/genie/${id}`, {})).status, 400);
  numEq("the surcharge is still the 0 the create wrote", (await bandRow(id))?.userCharge, 0);

  // The first PUT above named no vehicle type at all and still saved: the scope of a row that
  // exists is never re-validated, so a band whose type has since been retired keeps its price
  // editable rather than being locked behind a type it can no longer name.
  const untouched = await put(`/distance-charge/genie/${bikeRow}`, { settings: { fDeliveryCharge: "10" } });
  eq("a band of the other type, repriced with no type sent -> 200", untouched.status, 200);
  numEq("  written to its own row", (await bandRow(bikeRow))?.done, 10);
}

console.log("\n--- delete: hard, confirmed with the whole row ---");
{
  const id = created[0];
  const target = await get(`/distance-charge/genie/${id}`);
  const label = target.json?.item?.rowLabel;
  eq("the row knows its own label", label, "Car 100-150");

  // Nothing typed back is stopped by the route's own schema, before the service's "Type “…”
  // to confirm" sentence can be reached: the admin reads that wording in the dialog.
  eq("a delete with nothing typed back is refused by the route",
    (await del(`/distance-charge/genie/${id}`, {})).status, 400);
  refused("the type's name alone is not the row",
    await del(`/distance-charge/genie/${id}`, { confirm: "Car" }), "Confirmation does not match");
  refused("nor the band alone, which two types can share",
    await del(`/distance-charge/genie/${id}`, { confirm: "100-150" }), "Confirmation does not match");
  refused("nor a near miss",
    await del(`/distance-charge/genie/${id}`, { confirm: "car 100-150" }), "Confirmation does not match");
  eq("  and the row is still there after four refusals", (await bandRow(id))?.id, id);

  const res = await del(`/distance-charge/genie/${id}`, { confirm: label });
  eq("DELETE with the row typed back -> 200", res.status, 200);
  eq("  naming what went", res.json?.label, label);
  ok("  the row is gone from the table, not hidden", (await bandRow(id)) === undefined,
    JSON.stringify(await bandRow(id)));
  eq("  so no Deleted copy is left behind", await rowCount(), baseline + 1);
  eq("GET it now -> 404", (await get(`/distance-charge/genie/${id}`)).status, 404);
  eq("PUT it now -> 404", (await put(`/distance-charge/genie/${id}`, { settings: { fDeliveryCharge: "1" } })).status, 404);
  eq("DELETE it again -> 404", (await del(`/distance-charge/genie/${id}`, { confirm: label })).status, 404);

  const list = await get("/distance-charge/genie/list");
  eq("the list lost exactly one band", list.json?.total, baseline + 1);
  ok("  and the deleted id is not in it", !(list.json?.items ?? []).some((i) => i.id === id));
}

console.log("\n--- a type's last band gone: the chain starts over ---");
{
  // Take the open-ended band away, and the car is left with the 0 – 100 the install started
  // with: both the chain's next start and its `closed` flag follow what is on file at that
  // moment, not what was added and removed before it.
  const openId = created[1];
  const openLabel = (await get(`/distance-charge/genie/${openId}`)).json?.item?.rowLabel;
  eq("the ∞ band asks to be confirmed as the word, not the glyph", openLabel, "Car 150-infinity");
  eq("the open-ended band deletes with its own label -> 200",
    (await del(`/distance-charge/genie/${openId}`, { confirm: openLabel })).status, 200);
  const carBands = await rowsOfType(CAR);
  eq("the car holds only its live 0 – 100 again", carBands.length, 1);
  const chains = (await get("/distance-charge/genie/defaults")).json?.item?.chains;
  eq("  the defaults say the next band starts at 100", chains?.[CAR]?.nextFrom, 100);
  eq("  and the type is open again", chains?.[CAR]?.closed, false);

  // Now take the last band of the motorbike away, which is what the apps feel as a price
  // vanishing — and what a soft delete would have hidden instead.
  const bikeLabel = (await get(`/distance-charge/genie/${bikeRow}`)).json?.item?.rowLabel;
  eq("the motorbike's only band deletes -> 200",
    (await del(`/distance-charge/genie/${bikeRow}`, { confirm: bikeLabel })).status, 200);
  const after = (await get("/distance-charge/genie/defaults")).json?.item?.chains;
  ok("  its chain is no longer described at all", after?.[BIKE] === undefined, JSON.stringify(after));
  const fresh = await post("/distance-charge/genie", { vehicleTypeId: BIKE, settings: band(10, 20) });
  refused("a type with no bands must still start at 0", fresh, "must start at 0 KMs");
  const wantId = await nextId();
  const first = await post("/distance-charge/genie", { vehicleTypeId: BIKE, settings: band(0, 30, "11", "5") });
  eq("  and a band starting at 0 is priced", first.status, 201);
  const firstId = first.json?.item?.id;
  created.push(firstId);
  // A `MAX+1` id hands back what a delete freed above the highest live row, and never the
  // lowest gap: motorbike #1 is gone, yet the fresh band takes id 3, the one this run made
  // and deleted. Nothing renumbers the rest, which is why an id is not an ordering here.
  eq("  at the id a delete of this run freed, not the lowest missing one", wantId, 3);
  eq("  so the reused id is that one", firstId, wantId);
  eq("  with the delete phrase rebuilt from the row", first.json?.item?.rowLabel, "2 Wheeler / Motorbike 0-30");
  const listAfter = await get("/distance-charge/genie/list");
  eq("the list holds the car's band and this one", listAfter.json?.total, 2);
}

console.log("\n--- a row the screen cannot see cannot be stopped either (hard delete's reason) ---");
{
  // Hand-hidden, the way `delivery_charges` rows are retired. Not a state this API writes — it
  // is what a soft delete here would have left behind.
  const ghost = await insertBand({
    vehicleTypeId: BIKE, from: 1000, to: 2000, done: "3.00", cancel: "1.00", eStatus: "Deleted",
  });
  const list = await get("/distance-charge/genie/list");
  eq("the list ignores it", list.json?.total, 2);
  eq("GET on it -> 404", (await get(`/distance-charge/genie/${ghost}`)).status, 404);
  eq("PUT on it -> 404", (await put(`/distance-charge/genie/${ghost}`, { settings: { fDeliveryCharge: "1" } })).status, 404);
  eq("and it cannot even be deleted from this screen -> 404",
    (await del(`/distance-charge/genie/${ghost}`, { confirm: "x" })).status, 404);
  ok("yet the row is still in the table, which is the whole argument for hard deletes",
    (await bandRow(ghost)) !== undefined);
  eq("search cannot reach it either", (await get("/distance-charge/genie/list?search=1000")).json?.total, 0);
  await deleteBandSql(ghost);
  eq("and only SQL takes it out", await rowCount(), 2);
}

console.log("\n--- :app gates keys, not rows ---");
{
  // Runner (#sub-158) is now registered as a second entry over this very table, so `?eType`
  // changed only the four keys the guard demands: its list is genie's list, and its defaults
  // offer the same `eType='DeliverAll'` types the genie dropdown does (the legacy form
  // hard-coded that filter regardless of `$eType`). `b158-write.mjs` runs the full write
  // matrix; here the claim is just the sharing, plus that a segment naming no registered menu
  // is still refused before it reaches the table.
  const genieList = await get("/distance-charge/genie/list");
  const runnerList = await get("/distance-charge/runner/list");
  eq("the runner menu answers and reads the same rows", runnerList.status, 200);
  eq("  genie's total, identical", runnerList.json?.total, genieList.json?.total);
  eq("  and genie's rows, item for item", JSON.stringify(runnerList.json?.items),
    JSON.stringify(genieList.json?.items));
  eq("  the same DeliverAll types in its dropdown",
    runnerList.json?.vehicleTypes?.length, genieList.json?.vehicleTypes?.length);

  eq("a segment that names no registered menu is refused",
    (await get("/distance-charge/store/list")).status, 400);
  eq("  and the refusal names it, not a swallowed scope",
    message(await get("/distance-charge/store/list")).includes("store"), true);
  eq("the genie list is unaffected by all this", genieList.json?.total, 2);
}

console.log(`\n--- flipping ${DISTANCE_FLAG} off, then back ---`);
{
  await setFlag("No");
  await sleep(TTL);
  const list = await get("/distance-charge/genie/list");
  eq("the list reports distance-wise off", list.json?.features?.distanceWise, false);
  eq("  and still shows the bands", list.json?.total, 2);
  const defaults = await get("/distance-charge/genie/defaults");
  ok("the specs do not move with the switch — a band is a band either way",
    (defaults.json?.item?.fieldSpecs ?? []).some((f) => f.column === "iDistanceRangeFrom"),
    (defaults.json?.item?.fieldSpecs ?? []).map((f) => f.column).join(","));
  eq("  and the row's identity is still its band", defaults.json?.item?.band?.from, 0);
  const made = await post("/distance-charge/genie", { vehicleTypeId: CAR, settings: band(100, 120) });
  eq("a band can still be priced while the apps ignore them", made.status, 201);
  created.push(made.json?.item?.id);

  await setFlag("Yes");
  await sleep(TTL);
  eq("flipped back, the list reports it on again",
    (await get("/distance-charge/genie/list")).json?.features?.distanceWise, true);
}

try {
  // Everything the run created, taken out the same way the screen does it.
  console.log("\n--- clearing the bands this run added ---");
  for (const id of created) {
    const row = await bandRow(id);
    if (!row) continue;
    const label = row.eStatus === "Active"
      ? (await get(`/distance-charge/genie/${id}`)).json?.item?.rowLabel
      : null;
    if (label) await del(`/distance-charge/genie/${id}`, { confirm: label });
    else await deleteBandSql(id);
  }
} finally {
  await cleanUp();
  await sleep(TTL);
}

{
  const list = await get("/distance-charge/genie/list");
  console.log(`live bands after the run: ${list.json?.total} (baseline ${baseline})`);
  console.log(`rows in the table: ${await rowCount()}`);
  console.log("expected: node scripts/b155.mjs restore puts the deleted live bands back, and the");
  console.log("          fingerprint matches what `node scripts/b155.mjs fingerprint before` wrote.");
}

console.log(`\nb155-write: ${pass} ok, ${failures.length} failed`);
if (failures.length) console.log(failures.map((f) => ` - ${f}`).join("\n"));

await db.end();
process.exit(failures.length ? 1 : 0);
