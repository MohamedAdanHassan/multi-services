// Write matrix for Delivery Runner → Vehicle Type (#sub-156), the second `:app` entry over
// the rows the single legacy `store_vehicle_type.php` served to Genie, Runner and Store alike.
//
// This is deliberately not a slice test. `store_vehicle_type.php:39` sets
// `$eSystem = " AND eType = 'DeliverAll' "` before it ever looks at `?eType=runner`, so the
// runner entry resolves to the same two clauses genie does and only the five permission keys
// differ. Every write below is therefore checked from the OTHER menu: the type the Runner
// screen creates is the type the Genie screen lists, edits, deactivates and deletes, the name
// it takes is already taken there, and a DELETE through Genie hides the runner's own row from
// the runner list. An entry that quietly grew its scope to `eType IN ('DeliverAll','Runner')`
// or shrank it to an empty runner slice would fail here, not pass with plausible data.
//
// The rows the run touches are the two shipped DeliverAll types (406, 407) — read first so the
// probe value is put back from what the row actually held — plus types it creates and deletes
// again. `node scripts/b156.mjs restore` rewrites the whole table from the snapshot, so nothing
// this run writes survives it.
//
//   node scripts/b156-write.mjs
import mysql from "mysql2/promise";
import "dotenv/config";

const API = process.env.B156_API ?? "http://localhost:4000/api";
const EMAIL = "admin.test@ondemand.local";
const PASSWORD = "TestPass123!";

/** The two shipped DeliverAll types, shared by genie and runner. */
const SHARED = [406, 407];

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

/** Money and radius columns come back as DECIMAL strings or numbers, so numeric
 * checks compare values rather than their storage format. */
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
// SQL helpers — the eType clause is spelled out in every one, because the whole point
// of this entry is that the app name in the URL does NOT change it.
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

/** What the service would pick as "end of the list" for the shared slice, before a create. */
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

/** Ids the given menu's list endpoint currently reports, straight from SQL. */
async function listedIds(eType) {
  const [rows] = await db.query(
    "SELECT iVehicleTypeId AS id FROM vehicle_type WHERE eType = ? AND eStatus <> 'Deleted' ORDER BY id",
    [eType],
  );
  return rows.map((r) => Number(r.id));
}

/** Names of the three shipped slices, so a stray write is visible in one query. */
async function sliceCounts() {
  const [rows] = await db.query(
    `SELECT eType, eStatus, COUNT(*) AS n FROM vehicle_type
      WHERE eType IN ('Ride','Deliver','DeliverAll') GROUP BY eType, eStatus ORDER BY eType, eStatus`,
  );
  return rows.map((r) => `${r.eType}/${r.eStatus}=${r.n}`).join(" ");
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

// ---------------------------------------------------------------------------

await login();
const stamp = Date.now() % 100000;
const runnerName = `ZZ b156 runner ${stamp}`;
let runner = 0;

const auditMark = Number((await one("SELECT COALESCE(MAX(id),0) AS id FROM admin_audit_log", [])).id);
const shipped = {};
for (const id of SHARED) {
  shipped[id] = await row(id, "DeliverAll");
}
console.log("\n--- the slice the two menus share, before anything is written ---");
{
  eq("406 is a DeliverAll row", shipped[406]?.eStatus, "Active");
  eq("407 is a DeliverAll row", shipped[407]?.eStatus, "Active");
  eq("the shared slice holds exactly those two types", (await listedIds("DeliverAll")).join(","), "406,407");
  numEq("the taxi slice has 14 live types to stay out of", await liveCount("Ride"), 14);
  numEq("the parcel slice has 6 live types to stay out of", await liveCount("Deliver"), 6);
}

console.log("\n--- a create through the runner menu writes a DeliverAll row genie lists ---");
{
  const wantOrder = await nextOrder("DeliverAll");
  const created = await post("/vehicle-type/runner", {
    name: runnerName,
    status: "Active",
    settings: {
      eIconType: "Bike",
      fDeliveryCharge: 11.5,
      fDeliveryChargeCancelOrder: 3,
      fRadius: 9,
      fCommision: 15,
    },
    scope: { locationId: 4 },
  });
  eq("POST /vehicle-type/runner -> 201 (the app answers now)", created.status, 201);
  runner = created.json?.item?.id ?? 0;
  ok("the new type has an id", runner > 0, `id ${runner}`);
  numEq("it lands at the end of the shared list", created.json?.item?.settings?.iDisplayOrder, wantOrder);

  const r = await row(runner, "DeliverAll");
  ok("the row is eType='DeliverAll', not a runner-only eType", r !== undefined, JSON.stringify(r));
  eq("  with the runner name", r?.nameEN, runnerName);
  eq("  mirrored into vVehicleType", r?.nameMirror, runnerName);
  eq("  active", r?.eStatus, "Active");
  eq("  icon", r?.eIconType, "Bike");
  numEq("  delivery charge", r?.fDeliveryCharge, 11.5);
  numEq("  cancel charge", r?.fDeliveryChargeCancelOrder, 3);
  numEq("  radius", r?.fRadius, 9);
  numEq("  commission", r?.fCommision, 15);
  numEq("  bound to the chosen zone", r?.iLocationid, 4);
  numEq("  and no service category", r?.iVehicleCategoryId, 0);

  // One row, two menus: the detail payloads must be indistinguishable.
  const asRunner = await get(`/vehicle-type/runner/${runner}`);
  const asGenie = await get(`/vehicle-type/genie/${runner}`);
  eq("GET it back through runner -> 200", asRunner.status, 200);
  eq("GET it back through genie -> 200", asGenie.status, 200);
  ok(
    "  and the two reads are the same document",
    JSON.stringify(asRunner.json) === JSON.stringify(asGenie.json),
    "runner detail <> genie detail",
  );

  const genieList = await get("/vehicle-type/genie/list");
  eq("the genie list now holds 3 types", genieList.json?.total, 3);
  ok(
    "  including the row the runner menu created",
    (genieList.json?.items ?? []).some((i) => i.id === runner),
    JSON.stringify(genieList.json?.items?.map((i) => i.id)),
  );
  const runnerList = await get("/vehicle-type/runner/list");
  eq("  the runner list reports the same total", runnerList.json?.total, 3);
  eq(
    "  and the same ids",
    (runnerList.json?.items ?? []).map((i) => i.id).sort((a, b) => a - b).join(","),
    (genieList.json?.items ?? []).map((i) => i.id).sort((a, b) => a - b).join(","),
  );
  numEq("the taxi slice is untouched", await liveCount("Ride"), 14);
  numEq("the parcel slice is untouched", await liveCount("Deliver"), 6);
}

console.log("\n--- sharing rows means sharing names, and sharing the refusals ---");
{
  const before = await liveCount("DeliverAll");
  const fromGenie = await post("/vehicle-type/genie", { name: runnerName });
  eq("POST the runner's name through genie -> 400", fromGenie.status, 400);
  ok("  because the slice already holds it", message(fromGenie).includes(runnerName), message(fromGenie));
  const again = await post("/vehicle-type/runner", { name: runnerName });
  eq("POST it through runner again -> 400", again.status, 400);

  // The uniqueness is per slice, so a taxi may still be called the same thing — which
  // also proves the runner entry did not turn the check into a table-wide one.
  const ride = await post("/vehicle-type/ride", { name: runnerName });
  eq("POST the same name for a taxi -> 201", ride.status, 201);
  const rideId = ride.json?.item?.id ?? 0;
  ok("  in the ride slice", (await row(rideId, "Ride")) !== undefined, `id ${rideId}`);
  await del(`/vehicle-type/ride/${rideId}`, { confirm: runnerName });

  const blank = await post("/vehicle-type/runner", { name: "   " });
  eq("POST a blank name -> 400", blank.status, 400);
  const stray = await post("/vehicle-type/runner", { name: "ZZ b156 stray", settings: { eStatus: "Active" } });
  eq("POST a column that is not a setting -> 400", stray.status, 400);
  ok("  naming the offending column", message(stray).includes("eStatus"), message(stray));
  const big = await post("/vehicle-type/runner", { name: "ZZ b156 huge", settings: { fCommision: 150 } });
  eq("POST a commission above 100 -> 400", big.status, 400);
  const badCat = await post("/vehicle-type/runner", { name: "ZZ b156 cat", scope: { categoryId: 185 } });
  eq("POST a deleted DeliverAll category -> 400", badCat.status, 400);
  const badZone = await post("/vehicle-type/runner", { name: "ZZ b156 zone", scope: { locationId: 999999 } });
  eq("POST a zone that does not exist -> 400", badZone.status, 400);
  // `runner` is registered, so the unregistered witnesses have to come from the key
  // families RBAC holds over this table but no `:app` entry serves.
  eq("POST /vehicle-type/medical -> 400", (await post("/vehicle-type/medical", { name: "ZZ b156 medical" })).status, 400);
  eq("POST /vehicle-type/deliverall -> 400", (await post("/vehicle-type/deliverall", { name: "ZZ b156 deliverall" })).status, 400);
  eq("none of them inserted a row", await liveCount("DeliverAll"), before);
}

console.log("\n--- an edit through runner is the edit genie reads ---");
{
  const moved = await put(`/vehicle-type/runner/${runner}`, { settings: { fCommision: 27, fRadius: 21 } });
  eq("PUT /vehicle-type/runner/<id> -> 200", moved.status, 200);
  numEq("  genie's read shows the runner's commission", moved.json?.item?.settings?.fCommision, 27);
  const viaGenie = await get(`/vehicle-type/genie/${runner}`);
  numEq("  read through genie too", viaGenie.json?.item?.settings?.fCommision, 27);
  numEq("  and the radius", viaGenie.json?.item?.settings?.fRadius, 21);
  const r = await row(runner, "DeliverAll");
  numEq("  the stored row agrees", r?.fCommision, 27);
  numEq("  while the untouched charge stayed", r?.fDeliveryCharge, 11.5);

  const texted = await put(`/vehicle-type/genie/${runner}`, { texts: { name: { FR: "Type runner test" } } });
  eq("PUT a French name through genie -> 200", texted.status, 200);
  const seen = await get(`/vehicle-type/runner/${runner}`);
  eq("  the runner read shows it", seen.json?.item?.texts?.name?.FR, "Type runner test");
  eq("  and the English name is untouched", seen.json?.item?.texts?.name?.EN, runnerName);

  eq("PUT with nothing to change -> 400", (await put(`/vehicle-type/runner/${runner}`, {})).status, 400);
  eq("PUT a negative radius -> 400", (await put(`/vehicle-type/runner/${runner}`, { settings: { fRadius: -5 } })).status, 400);

  // Registered as a second menu over DeliverAll, not as a licence for the rest of the table.
  eq("PUT /vehicle-type/ride/<runner id> -> 404", (await put(`/vehicle-type/ride/${runner}`, { settings: { fCommision: 1 } })).status, 404);
  eq("PUT /vehicle-type/delivery/<runner id> -> 404", (await put(`/vehicle-type/delivery/${runner}`, { settings: { fCommision: 1 } })).status, 404);
  eq("PUT /vehicle-type/runner/1 (a taxi row) -> 404", (await put("/vehicle-type/runner/1", { settings: { fCommision: 1 } })).status, 404);
  eq("PUT /vehicle-type/runner/397 (a parcel row) -> 404", (await put("/vehicle-type/runner/397", { settings: { fCommision: 1 } })).status, 404);
  const kept = await row(runner, "DeliverAll");
  numEq("the runner row kept its commission through all of that", kept?.fCommision, 27);
}

console.log("\n--- the shipped shared row is one row, seen twice ---");
{
  const base = Number(shipped[406]?.fCommision);
  const up = await put("/vehicle-type/runner/406", { settings: { fCommision: base + 2 } });
  eq("PUT /vehicle-type/runner/406 -> 200", up.status, 200);
  const genieRead = await get("/vehicle-type/genie/406");
  numEq("  genie reads the runner's +2", genieRead.json?.item?.settings?.fCommision, base + 2);
  numEq("  the stored row agrees", (await row(406, "DeliverAll"))?.fCommision, base + 2);
  const back = await put("/vehicle-type/genie/406", { settings: { fCommision: base } });
  eq("PUT the shipped commission back through genie -> 200", back.status, 200);
  numEq("  and 406 holds its own value again", (await row(406, "DeliverAll"))?.fCommision, base);
  const other = await row(407, "DeliverAll");
  numEq("the second shipped row never moved", other?.fCommision, Number(shipped[407]?.fCommision));
}

console.log("\n--- a status flip is visible from both menus ---");
{
  const off = await patch(`/vehicle-type/runner/${runner}/status`, { status: "Inactive" });
  eq("PATCH /vehicle-type/runner/<id>/status Inactive -> 200", off.status, 200);
  eq("  genie reads the row Inactive", (await get(`/vehicle-type/genie/${runner}`)).json?.item?.status, "Inactive");
  eq("  the row is Inactive in SQL", (await row(runner, "DeliverAll"))?.eStatus, "Inactive");
  const genieActive = await get("/vehicle-type/genie/list?status=Active");
  eq("the genie Active filter drops it", genieActive.json?.items?.some((i) => i.id === runner), false);
  const runnerActive = await get("/vehicle-type/runner/list?status=Active");
  eq("  the runner Active filter drops it too", runnerActive.json?.items?.some((i) => i.id === runner), false);

  const on = await patch(`/vehicle-type/genie/${runner}/status`, { status: "Active" });
  eq("PATCH it Active again through genie -> 200", on.status, 200);
  eq("  the runner read agrees", (await get(`/vehicle-type/runner/${runner}`)).json?.item?.status, "Active");
  eq("PATCH a status the enum has not -> 400", (await patch(`/vehicle-type/runner/${runner}/status`, { status: "Deleted" })).status, 400);
  eq("PATCH /vehicle-type/runner/1/status (a taxi row) -> 404", (await patch("/vehicle-type/runner/1/status", { status: "Inactive" })).status, 404);
  eq("  and the taxi row is still Active", (await row(1, "Ride"))?.eStatus, "Active");
}

console.log("\n--- a delete from either menu hides the row from both lists ---");
{
  eq("DELETE with a blank confirm -> 400", (await del(`/vehicle-type/runner/${runner}`, { confirm: "" })).status, 400);
  const wrong = await del(`/vehicle-type/runner/${runner}`, { confirm: "something else" });
  eq("DELETE with the wrong name -> 400", wrong.status, 400);
  ok("  and it names the type instead", message(wrong).includes(runnerName), message(wrong));

  // Deleted through the menu that did not create it: the sharpest form of the test.
  const gone = await del(`/vehicle-type/genie/${runner}`, { confirm: runnerName });
  eq("DELETE the runner's own type through genie -> 200", gone.status, 200);
  const r = await row(runner, "DeliverAll");
  eq("  the row is kept and marked Deleted", r?.eStatus, "Deleted");
  ok("  with its charges intact for the audit trail", Number(r?.fDeliveryCharge) === 11.5, JSON.stringify(r));
  eq("GET the deleted type through runner -> 404", (await get(`/vehicle-type/runner/${runner}`)).status, 404);
  eq("GET it through genie -> 404", (await get(`/vehicle-type/genie/${runner}`)).status, 404);
  eq("the runner list is back to 2", await liveCount("DeliverAll"), 2);
  eq("DELETE it twice -> 404", (await del(`/vehicle-type/runner/${runner}`, { confirm: runnerName })).status, 404);
  eq("PATCH the deleted type -> 404", (await patch(`/vehicle-type/runner/${runner}/status`, { status: "Active" })).status, 404);

  // And the reverse direction, so neither menu is privileged.
  const second = await post("/vehicle-type/genie", { name: `${runnerName} two` });
  eq("POST a second type through genie -> 201", second.status, 201);
  const secondId = second.json?.item?.id ?? 0;
  eq("DELETE it through runner -> 200", (await del(`/vehicle-type/runner/${secondId}`, { confirm: `${runnerName} two` })).status, 200);
  eq("  and it is Deleted for genie as well", (await row(secondId, "DeliverAll"))?.eStatus, "Deleted");
  eq("the shared slice is two types again", await liveCount("DeliverAll"), 2);
  eq("DELETE /vehicle-type/runner/1 (a taxi row) -> 404", (await del("/vehicle-type/runner/1", { confirm: "x" })).status, 404);
}

console.log("\n--- every runner mutation left an audit trail ---");
{
  for (const event of [
    "vehicle_type_created",
    "vehicle_type_updated",
    "vehicle_type_status_changed",
    "vehicle_type_deleted",
  ]) {
    ok(`audit event ${event}`, await sawAudit(event, auditMark));
  }
  // The controller logs one event name per action for every app, so registering runner
  // must not have minted a runner-only family that reports writes nobody reads.
  const twins = await one(
    "SELECT COUNT(*) AS n FROM admin_audit_log WHERE event LIKE 'vehicle_type_%_runner'",
    [],
  );
  numEq("no runner-suffixed audit events exist", twins?.n, 0);
}

console.log("\n--- the table after the run, before restore ---");
{
  eq("the shared slice is the two shipped types", (await listedIds("DeliverAll")).join(","), "406,407");
  numEq("406 holds its shipped commission", (await row(406, "DeliverAll"))?.fCommision, Number(shipped[406]?.fCommision));
  numEq("407 never moved at all", (await row(407, "DeliverAll"))?.fCommision, Number(shipped[407]?.fCommision));
  eq("406 keeps its shipped name", (await row(406, "DeliverAll"))?.nameEN, shipped[406]?.nameEN);
  numEq("the taxi slice is still 14 live types", await liveCount("Ride"), 14);
  numEq("the parcel slice is still 6 live types", await liveCount("Deliver"), 6);
  console.log(`slices: ${await sliceCounts()}`);
  console.log("expected: the runner test rows sit in the table as Deleted until b156.mjs restore");
}

console.log(`\nb156-write: ${pass} ok, ${failures.length} failed`);
if (failures.length) console.log(failures.map((f) => ` - ${f}`).join("\n"));

await db.end();
process.exit(failures.length ? 1 : 0);
