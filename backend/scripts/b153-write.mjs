// Write matrix for the Vehicle Type screen over the shared legacy `vehicle_type` table.
// Every slice the `:app` registry exposes (#sub-15 ride / #sub-138 parcel / #sub-153
// genie) is created, edited, deactivated and deleted again here, and
// `node scripts/b153.mjs restore` puts the table back byte-identically to the snapshot,
// so nothing this run writes survives it.
//
//   node scripts/b153-write.mjs
import mysql from "mysql2/promise";
import "dotenv/config";

const API = process.env.B153_API ?? "http://localhost:4000/api";
const EMAIL = "admin.test@ondemand.local";
const PASSWORD = "TestPass123!";

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

/** Money and radius columns come back as DECIMAL strings ("25.50") or numbers, so
 * every numeric check compares values rather than their storage format. */
function numEq(label, actual, want) {
  const a = Number(actual);
  ok(label, Number.isFinite(a) && a === Number(want), `got ${JSON.stringify(actual)}, want ${want}`);
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

function message(res) {
  return res.json?.error?.message ?? JSON.stringify(res.json ?? "").slice(0, 160);
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
// SQL helpers — every one names eType, so a check can never be fooled by another
// app's rows sitting in the same table.
// ---------------------------------------------------------------------------

async function one(sql, params) {
  const [rows] = await db.query(sql, params);
  return rows[0];
}

/** The columns this screen owns, for one id inside one slice. */
async function row(id, eType) {
  return one(
    `SELECT iVehicleTypeId AS id, eType, eStatus, vVehicleType_EN AS nameEN, vVehicleType AS nameMirror,
            iLocationid, iVehicleCategoryId, iDisplayOrder, eIconType, eFareType, iPersonSize,
            iBaseFare, fPricePerKM, fDeliveryCharge, fDeliveryChargeCancelOrder, fRadius, fCommision
       FROM vehicle_type WHERE iVehicleTypeId = ? AND eType = ? LIMIT 1`,
    [id, eType],
  );
}

/** What the service would pick as "end of the list" for this app, before a create. */
async function nextOrder(eType) {
  const r = await one(
    `SELECT COALESCE(MAX(iDisplayOrder), 0) + 1 AS n FROM vehicle_type
      WHERE eType = ? AND eStatus <> 'Deleted'`,
    [eType],
  );
  return Number(r.n);
}

async function liveCount(eType) {
  const r = await one(
    "SELECT COUNT(*) AS n FROM vehicle_type WHERE eType = ? AND eStatus <> 'Deleted'",
    [eType],
  );
  return Number(r.n);
}

/** Names of the three shipped slices, so a stray write is visible in one query. */
async function sliceCounts() {
  const [rows] = await db.query(
    `SELECT eType, eStatus, COUNT(*) AS n FROM vehicle_type
      WHERE eType IN ('Ride','Deliver','DeliverAll') GROUP BY eType, eStatus ORDER BY eType, eStatus`,
  );
  return rows.map((r) => `${r.eType}/${r.eStatus}=${r.n}`).join(" ");
}

// ---------------------------------------------------------------------------

await login();
const stamp = Date.now() % 100000;
const genieName = `ZZ b153 genie ${stamp}`;
let genie = 0;

console.log("\n--- genie create writes the legacy delivery columns ---");
{
  const wantOrder = await nextOrder("DeliverAll");
  const created = await post("/vehicle-type/genie", {
    name: genieName,
    status: "Active",
    settings: {
      eIconType: "Bike",
      fDeliveryCharge: 25.5,
      fDeliveryChargeCancelOrder: 7,
      fRadius: 12,
      fCommision: 18,
    },
    scope: { locationId: 4 },
  });
  eq("POST /vehicle-type/genie -> 201", created.status, 201);
  genie = created.json?.item?.id ?? 0;
  ok("the new type has an id", genie > 0, `id ${genie}`);
  numEq("it lands at the end of the genie list", created.json?.item?.settings?.iDisplayOrder, wantOrder);

  const r = await row(genie, "DeliverAll");
  ok("the row is eType='DeliverAll' (the genie slice)", r !== undefined, JSON.stringify(r));
  eq("  with the genie name", r?.nameEN, genieName);
  eq("  mirrored into vVehicleType", r?.nameMirror, genieName);
  eq("  active", r?.eStatus, "Active");
  eq("  icon", r?.eIconType, "Bike");
  numEq("  delivery charge", r?.fDeliveryCharge, 25.5);
  numEq("  cancel charge", r?.fDeliveryChargeCancelOrder, 7);
  numEq("  radius", r?.fRadius, 12);
  numEq("  commission", r?.fCommision, 18);
  numEq("  display order", r?.iDisplayOrder, wantOrder);
  numEq("  bound to the chosen zone", r?.iLocationid, 4);
  numEq("  and no service category", r?.iVehicleCategoryId, 0);

  const read = await get(`/vehicle-type/genie/${genie}`);
  eq("GET the new type -> 200", read.status, 200);
  numEq("  the DTO repeats the charge", read.json?.item?.settings?.fDeliveryCharge, 25.5);
  eq("  and names the zone", read.json?.item?.scope?.locationName, "city");
  eq("  its category list is empty (the only DeliverAll category is deleted)", JSON.stringify(read.json?.item?.scopeOptions?.categories), "[]");

  const list = await get("/vehicle-type/genie/list");
  eq("the genie list now holds 3 types", list.json?.total, 3);
  const listed = list.json?.items?.find((i) => i.id === genie);
  numEq("  the row carries deliveryCharge", listed?.deliveryCharge, 25.5);
  numEq("  cancelCharge", listed?.cancelCharge, 7);
  numEq("  radius", listed?.radius, 12);
  numEq("  and commission", listed?.commission, 18);
  numEq("the ride slice is untouched", await liveCount("Ride"), 14);
  numEq("the parcel slice is untouched", await liveCount("Deliver"), 6);
}

console.log("\n--- genie create refuses what the legacy form could not store ---");
{
  const before = await liveCount("DeliverAll");
  const blank = await post("/vehicle-type/genie", { name: "   " });
  eq("POST with a blank name -> 400", blank.status, 400);
  const dupe = await post("/vehicle-type/genie", { name: genieName });
  eq("POST a name the slice already holds -> 400", dupe.status, 400);
  ok("  and it says so", message(dupe).includes(genieName), message(dupe));
  const empty = await post("/vehicle-type/genie", { name: "ZZ b153 empty", settings: {} });
  eq("POST with an empty settings group -> 400", empty.status, 400);
  const stray = await post("/vehicle-type/genie", { name: "ZZ b153 stray", settings: { eStatus: "Active" } });
  eq("POST a column that is not a setting -> 400", stray.status, 400);
  ok("  naming the offending column", message(stray).includes("eStatus"), message(stray));
  const badEnum = await post("/vehicle-type/genie", { name: "ZZ b153 boat", settings: { eIconType: "Boat" } });
  eq("POST an icon outside the enum -> 400", badEnum.status, 400);
  const big = await post("/vehicle-type/genie", { name: "ZZ b153 huge", settings: { fCommision: 150 } });
  eq("POST a commission above 100 -> 400", big.status, 400);
  const proto = await post("/vehicle-type/genie", { name: "ZZ b153 proto", settings: { __proto__: "x" } });
  ok("POST a __proto__ setting is refused", proto.status === 400, `${proto.status} ${message(proto)}`);
  const badCat = await post("/vehicle-type/genie", { name: "ZZ b153 cat", scope: { categoryId: 185 } });
  eq("POST a deleted genie category -> 400", badCat.status, 400);
  const badZone = await post("/vehicle-type/genie", { name: "ZZ b153 zone", scope: { locationId: 999999 } });
  eq("POST a zone that does not exist -> 400", badZone.status, 400);
  // `runner` used to be the unregistered app this case leaned on; #sub-156 registered it
  // over this very `DeliverAll` slice, so the refusal now has to come from an app whose
  // keys exist in RBAC but which no `:app` entry serves — `medical` and `deliverall`.
  const unknown = await post("/vehicle-type/medical", { name: "ZZ b153 medical" });
  eq("POST for an app the registry has not -> 400", unknown.status, 400);
  const alsoUnknown = await post("/vehicle-type/deliverall", { name: "ZZ b153 deliverall" });
  eq("POST over the legacy deliverall suffix -> 400", alsoUnknown.status, 400);
  eq("none of them inserted a row", await liveCount("DeliverAll"), before);
}

console.log("\n--- a slice never writes another slice's rows ---");
{
  eq("PUT /vehicle-type/delivery/<genie id> -> 404", (await put(`/vehicle-type/delivery/${genie}`, { settings: { fCommision: 1 } })).status, 404);
  eq("PUT /vehicle-type/ride/<genie id> -> 404", (await put(`/vehicle-type/ride/${genie}`, { settings: { fCommision: 1 } })).status, 404);
  eq("PATCH /vehicle-type/delivery/<genie id>/status -> 404", (await patch(`/vehicle-type/delivery/${genie}/status`, { status: "Inactive" })).status, 404);
  eq("DELETE /vehicle-type/ride/<genie id> -> 404", (await del(`/vehicle-type/ride/${genie}`, { confirm: "x" })).status, 404);
  const kept = await row(genie, "DeliverAll");
  numEq("the genie row kept its commission", kept?.fCommision, 18);
  eq("and stayed Active", kept?.eStatus, "Active");

  // A write through the wrong app must leave the ride row byte-identical, so the
  // probe value is put back from what the row actually held rather than a guess.
  const shipped = Number((await row(1, "Ride"))?.fCommision);
  const ride = await put("/vehicle-type/ride/1", { settings: { fCommision: shipped + 1 } });
  eq("PUT /vehicle-type/ride/1 (its own slice) -> 200", ride.status, 200);
  const back = await put("/vehicle-type/ride/1", { settings: { fCommision: shipped } });
  eq("PUT the shipped commission back -> 200", back.status, 200);
  numEq("and the ride row is whole again", (await row(1, "Ride"))?.fCommision, shipped);
  const genieOnRide = await put("/vehicle-type/genie/1", { settings: { fCommision: 1 } });
  eq("PUT /vehicle-type/genie/1 (a ride row) -> 404", genieOnRide.status, 404);
}

console.log("\n--- genie and runner are one slice, so they write one row (#sub-156) ---");
{
  // Not a cross-slice leak: `runner` and `genie` resolve to the same
  // `AND eType = 'DeliverAll'` the legacy file hard-coded, so a type created from the
  // Genie menu is the type the Runner menu lists and edits. These cases pin that the
  // second key family reaches the first's rows on purpose.
  const viaRunner = await get(`/vehicle-type/runner/${genie}`);
  eq("GET /vehicle-type/runner/<genie id> -> 200 (same row)", viaRunner.status, 200);
  const list = await get("/vehicle-type/runner/list");
  ok(
    "  the runner list holds the genie-created type",
    (list.json?.items ?? []).some((i) => i.id === genie),
    JSON.stringify(list.json?.items?.map((i) => i.id)),
  );
  const edited = await put(`/vehicle-type/runner/${genie}`, { settings: { fCommision: 21 } });
  eq("PUT /vehicle-type/runner/<genie id> -> 200", edited.status, 200);
  numEq(
    "  the genie read sees the runner's commission",
    (await get(`/vehicle-type/genie/${genie}`)).json?.item?.settings?.fCommision,
    21,
  );
  const flipped = await patch(`/vehicle-type/runner/${genie}/status`, { status: "Inactive" });
  eq("PATCH the status through runner -> 200", flipped.status, 200);
  eq(
    "  and genie reports the row Inactive",
    (await get(`/vehicle-type/genie/${genie}`)).json?.item?.status,
    "Inactive",
  );
  await patch(`/vehicle-type/genie/${genie}/status`, { status: "Active" });
  await put(`/vehicle-type/genie/${genie}`, { settings: { fCommision: 18 } });
  const restored = await row(genie, "DeliverAll");
  numEq("the commission put back through genie is 18 again", restored?.fCommision, 18);
  eq("and the row is Active again", restored?.eStatus, "Active");

  // Neither of them may touch a taxi row, however they are addressed. Read the
  // shipped commission again here rather than reuse the probe value from the block
  // above: that one is block-scoped, and this section runs after it.
  const shippedRide = Number((await row(1, "Ride"))?.fCommision);
  eq("PUT /vehicle-type/runner/1 (a ride row) -> 404", (await put("/vehicle-type/runner/1", { settings: { fCommision: 1 } })).status, 404);
  const rideRow = await row(1, "Ride");
  numEq("  and the ride row kept its own commission", rideRow?.fCommision, shippedRide);
}

console.log("\n--- edit writes only the columns the payload names ---");
{
  const renamed = await put(`/vehicle-type/genie/${genie}`, { texts: { name: { FR: "Type genie test" } } });
  eq("PUT one language -> 200", renamed.status, 200);
  const afterRename = await row(genie, "DeliverAll");
  eq("  the English name is untouched", afterRename?.nameEN, genieName);
  numEq("  and the charges survived the text write", afterRename?.fDeliveryCharge, 25.5);

  const repatch = await put(`/vehicle-type/genie/${genie}`, {
    settings: { fDeliveryCharge: 30, fCommision: 20, iDisplayOrder: 9 },
  });
  eq("PUT three settings -> 200", repatch.status, 200);
  const afterSettings = await row(genie, "DeliverAll");
  numEq("  the charge moved", afterSettings?.fDeliveryCharge, 30);
  numEq("  the commission moved", afterSettings?.fCommision, 20);
  numEq("  the slot moved", afterSettings?.iDisplayOrder, 9);
  numEq("  the cancel charge did not", afterSettings?.fDeliveryChargeCancelOrder, 7);
  numEq("  and neither did the radius", afterSettings?.fRadius, 12);

  const blankSave = await put(`/vehicle-type/genie/${genie}`, {});
  eq("PUT with nothing to change -> 400", blankSave.status, 400);
  const badSetting = await put(`/vehicle-type/genie/${genie}`, { settings: { fRadius: -5 } });
  eq("PUT a negative radius -> 400", badSetting.status, 400);
  const unscoped = await put(`/vehicle-type/genie/1`, { texts: { name: { EN: "hijack" } } });
  eq("PUT a ride row through genie -> 404", unscoped.status, 404);

  const sentinels = await put(`/vehicle-type/genie/${genie}`, { scope: { locationId: -1 } });
  eq("PUT the All-locations sentinel -> 200", sentinels.status, 200);
  numEq("  the row is unscoped again", (await row(genie, "DeliverAll"))?.iLocationid, -1);
}

console.log("\n--- status is a single-column change ---");
{
  const off = await patch(`/vehicle-type/genie/${genie}/status`, { status: "Inactive" });
  eq("PATCH Inactive -> 200", off.status, 200);
  const r = await row(genie, "DeliverAll");
  eq("  the row is Inactive", r?.eStatus, "Inactive");
  numEq("  and kept its charges", r?.fDeliveryCharge, 30);
  const again = await patch(`/vehicle-type/genie/${genie}/status`, { status: "Inactive" });
  eq("PATCH the same status again -> 200", again.status, 200);
  const bogus = await patch(`/vehicle-type/genie/${genie}/status`, { status: "Deleted" });
  eq("PATCH a status the enum has not -> 400", bogus.status, 400);
  const hidden = await get("/vehicle-type/genie/list?status=Active");
  eq("the Active filter drops it", hidden.json?.items?.some((i) => i.id === genie), false);
  const found = await get(`/vehicle-type/genie/list?search=${encodeURIComponent(genieName)}`);
  eq("the search filter still finds it (Inactive is listed)", found.json?.total, 1);
  const on = await patch(`/vehicle-type/genie/${genie}/status`, { status: "Active" });
  eq("PATCH back to Active -> 200", on.status, 200);
  eq("  the row is Active again", (await row(genie, "DeliverAll"))?.eStatus, "Active");
}

console.log("\n--- delete is name-confirmed and only soft ---");
{
  const blank = await del(`/vehicle-type/genie/${genie}`, { confirm: "" });
  eq("DELETE with a blank confirm -> 400", blank.status, 400);
  const wrong = await del(`/vehicle-type/genie/${genie}`, { confirm: "something else" });
  eq("DELETE with the wrong name -> 400", wrong.status, 400);
  ok("  and it names the type instead", message(wrong).includes(genieName), message(wrong));
  const gone = await del(`/vehicle-type/genie/${genie}`, { confirm: genieName });
  eq("DELETE with the right name -> 200", gone.status, 200);
  const r = await row(genie, "DeliverAll");
  eq("  the row is kept and marked Deleted", r?.eStatus, "Deleted");
  ok("  ten legacy tables still point at the id", r !== undefined, JSON.stringify(r));
  eq("  the genie list is back to 2", await liveCount("DeliverAll"), 2);
  eq("GET the deleted type -> 404", (await get(`/vehicle-type/genie/${genie}`)).status, 404);
  eq("PATCH the deleted type -> 404", (await patch(`/vehicle-type/genie/${genie}/status`, { status: "Active" })).status, 404);
  eq("DELETE it twice -> 404", (await del(`/vehicle-type/genie/${genie}`, { confirm: genieName })).status, 404);
}

console.log("\n--- the taxi and parcel add forms use the same settings payload ---");
{
  const wantRide = await nextOrder("Ride");
  const ride = await post("/vehicle-type/ride", {
    name: `ZZ b153 ride ${stamp}`,
    settings: { eIconType: "Fly", eFareType: "Regular", iPersonSize: 6, iBaseFare: 25, fPricePerKM: 1.75 },
  });
  eq("POST /vehicle-type/ride with fares -> 201", ride.status, 201);
  const rideId = ride.json?.item?.id ?? 0;
  const r = await row(rideId, "Ride");
  ok("  the row is eType='Ride'", r !== undefined, JSON.stringify(r));
  numEq("  seats", r?.iPersonSize, 6);
  numEq("  base fare", r?.iBaseFare, 25);
  numEq("  price per KM", r?.fPricePerKM, 1.75);
  numEq("  at the end of the ride list", r?.iDisplayOrder, wantRide);
  numEq("  and its delivery charge is the legacy default", r?.fDeliveryCharge, 0);

  const wantDeliver = await nextOrder("Deliver");
  const parcel = await post("/vehicle-type/delivery", { name: `ZZ b153 parcel ${stamp}` });
  eq("POST /vehicle-type/delivery with no settings -> 201", parcel.status, 201);
  const parcelId = parcel.json?.item?.id ?? 0;
  const p = await row(parcelId, "Deliver");
  ok("  the row is eType='Deliver'", p !== undefined, JSON.stringify(p));
  numEq("  at the end of the parcel list", p?.iDisplayOrder, wantDeliver);
  eq("  on the DDL default icon", p?.eIconType, "Car");
  numEq("  and the genie-only columns stay blank", p?.fRadius, 0);

  const rideList = await get("/vehicle-type/ride/list");
  eq("the ride list grew by one", rideList.json?.total, 15);
  const parcelList = await get("/vehicle-type/delivery/list");
  eq("the parcel list grew by one", parcelList.json?.total, 7);

  const hard = ["ride", rideId, `ZZ b153 ride ${stamp}`];
  const dp = await del(`/vehicle-type/${hard[0]}/${hard[1]}`, { confirm: hard[2] });
  eq("DELETE the test ride -> 200", dp.status, 200);
  eq("DELETE the test parcel -> 200", (await del(`/vehicle-type/delivery/${parcelId}`, { confirm: `ZZ b153 parcel ${stamp}` })).status, 200);
}

console.log(`\nslices after the run: ${await sliceCounts()}`);
console.log("expected: the three test rows sit in the table as Deleted until b153.mjs restore");
console.log(`b153-write: ${pass} ok, ${failures.length} failed`);
if (failures.length) console.log(failures.map((f) => ` - ${f}`).join("\n"));

await db.end();
process.exit(failures.length ? 1 : 0);
