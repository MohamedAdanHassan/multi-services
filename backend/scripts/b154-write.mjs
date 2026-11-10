// Write matrix for Delivery Charges (#sub-154) over the shared legacy `delivery_charges`
// table. It runs in two halves, because the `ENABLE_CUSTOM_DELIVERY_CHARGE_ORDER` switch
// changes the shape of a row: with it on, a location holds several distance bands and its
// scope is frozen once created; with it off, a location holds exactly one scheme and the
// band columns are nobody's business. The switch is flipped for real (and restored) rather
// than mocked, so the second half reads the same `configurations` rows General Settings
// edits. Test zones are seeded into `location_master` with `eFor='UserDeliveryCharge'` and
// dropped again — the live install has none, so the zone paths would never run.
//
//   node scripts/b154.mjs snapshot
//   node scripts/b154-write.mjs
//   node scripts/b154.mjs restore
import { setTimeout as sleep } from "node:timers/promises";
import mysql from "mysql2/promise";
import "dotenv/config";

const API = process.env.B154_API ?? "http://localhost:4000/api";
const EMAIL = "admin.test@ondemand.local";
const PASSWORD = "TestPass123!";
/** `readScreenMeta` caches flags + zones for 60s, so a flipped switch has to age out. */
const TTL = 65_000;
const OPEN = 100_000_000;
const DISTANCE_FLAG = "ENABLE_CUSTOM_DELIVERY_CHARGE_ORDER";

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

async function liveCount() {
  const r = await one("SELECT COUNT(*) AS n FROM delivery_charges WHERE eStatus <> 'Deleted'");
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

async function setFlag(value) {
  await db.query("UPDATE configurations SET `vValue` = ? WHERE vName = ?", [value, DISTANCE_FLAG]);
}

/** A zone the location dropdown can offer, tagged the way the legacy form filters it. */
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

const seeded = [];
/** The one band seeded into the *other* table below, keyed to a scheme of this screen. */
const MIRROR = { from: 0, to: 100, charge: "7.77", vehicleTypeId: 406 };

async function removeMirror() {
  await db.query(
    `DELETE FROM custom_delivery_charges_order
      WHERE iDistanceRangeFrom = ? AND iDistanceRangeTo = ? AND fDeliveryCharge = ?
        AND iVehicleTypeId = ?`,
    [MIRROR.from, MIRROR.to, MIRROR.charge, MIRROR.vehicleTypeId],
  );
}

async function cleanUp() {
  await setFlag("Yes");
  await removeMirror();
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

const created = [];
/** The three schemes phase 1 creates, kept for the phases that edit, deactivate and
 * delete them: a band of All locations, an open-ended band of zone one, a blank-optional
 * scheme of zone two. Ids are not known in advance — the table has no auto-increment. */
let bandRow = 0;
let zoneOpenRow = 0;
let zoneBlankRow = 0;

// ---------------------------------------------------------------------------

await login();

const baseline = await liveCount();
const first = await row(1);
console.log(
  `\nbaseline: ${baseline} live row(s); #1 = location ${first?.iLocationId}, band ${first?.dFrom}→${first?.dTo}`,
);
console.log("the legacy row #1 covers All locations; the distance-wise table is a separate screen");

try {
  const z1 = await seedZone("ZZ b154 zone one");
  const z2 = await seedZone("ZZ b154 zone two");
  const z3 = await seedZone("ZZ b154 zone three");
  const z4 = await seedZone("ZZ b154 zone four");
  console.log(`\nseeded zones ${z1} ${z2} ${z3} ${z4} as eFor='UserDeliveryCharge' (dropped at the end)`);

  // =========================================================================
  console.log("\n--- distance-wise ON: the bands decide what a location holds ---");
  {
    const clash = await post("/delivery-charge/genie", { locationId: 0, settings: charge(0, 50) });
    refused("create a band inside the stored 0→200 -> 400", clash, "already covers");
    ok("  and the message shows the band, not an id", message(clash).includes("0 – 200 km"), message(clash));

    const wantId = await nextId();
    const band = await post("/delivery-charge/genie", { locationId: 0, settings: charge(200, 500) });
    eq("create the next band of All locations -> 201", band.status, 201);
    const bandId = band.json?.item?.id ?? 0;
    created.push(bandId);
    bandRow = bandId;
    eq("  the keyless table hands out MAX+1", bandId, wantId);
    const r = await row(bandId);
    numEq("  order total written", r?.orderPrice, 100);
    numEq("  charge above written", r?.above, 10);
    numEq("  charge below written", r?.below, 8);
    numEq("  free subtotal written", r?.freeSubtotal, 500);
    numEq("  free radius written", r?.freeRadius, 5);
    numEq("  Buy Any Service charge written", r?.anySvc, 20);
    numEq("  Buy Any Service cancellation charge written", r?.anySvcCancel, 6);
    numEq("  band from", r?.dFrom, 200);
    numEq("  band to", r?.dTo, 500);
    eq("  a new scheme starts Active", r?.eStatus, "Active");
    eq("  the location is the All-locations sentinel", r?.iLocationId, 0);
    eq("  the DTO calls it All locations", band.json?.item?.scope?.label, "All locations");
    eq("  and the band is not open-ended", band.json?.item?.distance?.open, false);

    const overlap = await post("/delivery-charge/genie", { locationId: 0, settings: charge(300, 600) });
    refused("create a band overlapping the one just written -> 400", overlap, "already covers");

    const above = await post("/delivery-charge/genie", { locationId: z1, settings: charge(10, 100) });
    refused("create a zone's first band above 0 -> 400", above, "must start at 0");

    const wantOpen = await nextId();
    const open = await post("/delivery-charge/genie", { locationId: z1, settings: charge(0, "∞") });
    eq("create an open-ended band from the ∞ the list shows -> 201", open.status, 201);
    const openId = open.json?.item?.id ?? 0;
    created.push(openId);
    zoneOpenRow = openId;
    eq("  next id again", openId, wantOpen);
    numEq("  the sentinel is stored, not a bigger number", (await row(openId))?.dTo, OPEN);
    eq("  the DTO says the band is open", open.json?.item?.distance?.open, true);
    ok("  and labels it with ∞", String(open.json?.item?.distance?.label).includes("∞"), open.json?.item?.distance?.label);

    const blank = await post("/delivery-charge/genie", {
      locationId: z2,
      settings: charge(0, 30, { fFreeOrderPriceSubtotal: "", iFreeDeliveryRadius: "" }),
    });
    eq("create with the two optional amounts left blank -> 201", blank.status, 201);
    const blankId = blank.json?.item?.id ?? 0;
    created.push(blankId);
    zoneBlankRow = blankId;
    const b = await row(blankId);
    numEq("  free subtotal stored as 0, which is what the apps read as 'no threshold'", b?.freeSubtotal, 0);
    numEq("  free radius stored as 0", b?.freeRadius, 0);
    numEq("  the required amounts still went in", b?.orderPrice, 100);

    eq("live rows after the creates", await liveCount(), baseline + 3);
  }

  // =========================================================================
  console.log("\n--- the payload is bounded by the columns and by the specs ---");
  {
    // The route caps the map at the columns this table owns, so an unknown key has to
    // travel in an otherwise small enough body to reach the service's own refusal.
    const unknown = await post("/delivery-charge/genie", {
      locationId: 0,
      settings: {
        fOrderPriceValue: 10,
        fDeliveryChargeAbove: 1,
        fDeliveryChargeBelow: 1,
        iDistanceRangeFrom: 700,
        iDistanceRangeTo: 800,
        fNotADeliveryColumn: 1,
      },
    });
    refused("an unknown settings key -> 400", unknown, "Unknown delivery-charge value");

    const missing = await post("/delivery-charge/genie", {
      locationId: 0,
      settings: charge(700, 800, { fOrderPriceValue: undefined }),
    });
    refused("a missing required amount -> 400", missing, "Order total");

    const noBand = await post("/delivery-charge/genie", {
      locationId: 0,
      settings: { fOrderPriceValue: 10, fDeliveryChargeAbove: 1, fDeliveryChargeBelow: 1 },
    });
    refused("a missing band while distance-wise is on -> 400", noBand, "Distance range from");

    const negative = await post("/delivery-charge/genie", {
      locationId: 0,
      settings: charge(700, 800, { fDeliveryChargeAbove: -1 }),
    });
    refused("a negative charge -> 400", negative, "between 0 and");

    const huge = await post("/delivery-charge/genie", {
      locationId: 0,
      settings: charge(700, 800, { fOrderPriceValue: 100000 }),
    });
    refused("an amount past the column ceiling -> 400", huge, "between 0 and 99999");

    const text = await post("/delivery-charge/genie", {
      locationId: 0,
      settings: charge(700, 800, { fDeliveryChargeBelow: "abc" }),
    });
    refused("a non-numeric amount -> 400", text, "must be a number");

    const reversed = await post("/delivery-charge/genie", { locationId: z2, settings: charge(600, 500) });
    refused("a band that ends before it starts -> 400", reversed, "must be greater than");

    const foreign = await post("/delivery-charge/genie", { locationId: 3, settings: charge(0, 50) });
    refused("a zone tagged for vehicle types -> 400", foreign, "not a delivery-charge zone");

    const gone = await post("/delivery-charge/genie", { locationId: 987654, settings: charge(0, 50) });
    refused("a zone that does not exist -> 400", gone, "not a delivery-charge zone");

    const noLocation = await post("/delivery-charge/genie", { settings: charge(700, 800) });
    ok("a create with no location at all -> 400", noLocation.status === 400, `status ${noLocation.status}`);

    const empty = await post("/delivery-charge/genie", { locationId: 0, settings: {} });
    refused("an empty settings map -> 400", empty, "at least one value");

    // Runner used to be refused here. #sub-157 registered it as a second entry point over
    // these very same rows, so the app that still has no scope is the store/deliverall
    // menu, which the route's enum rejects before it touches the table. `b157-write.mjs`
    // is what proves the two menus share rows; this file stays the genie matrix.
    const badApp = await post("/delivery-charge/store", { locationId: 0, settings: charge(700, 800) });
    ok("POST /delivery-charge/store -> 400 (no such menu)", badApp.status === 400, `status ${badApp.status}`);
    eq("  and nothing was written", await liveCount(), baseline + 3);
  }

  // =========================================================================
  console.log("\n--- distance-wise ON freezes the scope of a scheme that exists ---");
  {
    const stored = await row(bandRow);
    console.log(`  editing #${bandRow} (location ${stored.iLocationId}, band ${stored.dFrom}→${stored.dTo})`);

    const moved = await put(`/delivery-charge/genie/${bandRow}`, { locationId: z1 });
    refused("change its location -> 400", moved, "location is fixed");

    const shifted = await put(`/delivery-charge/genie/${bandRow}`, {
      settings: { iDistanceRangeFrom: 250, iDistanceRangeTo: 500 },
    });
    refused("widen its band -> 400", shifted, "distance band is fixed");

    const echo = await put(`/delivery-charge/genie/${bandRow}`, {
      settings: { iDistanceRangeFrom: 200, iDistanceRangeTo: 500 },
    });
    refused("echoing the stored band saves nothing -> 400", echo, "changed");

    const money = await put(`/delivery-charge/genie/${bandRow}`, {
      settings: { iDistanceRangeFrom: 200, iDistanceRangeTo: 500, fOrderPriceValue: 150, fDeliveryChargeAbove: 12.5 },
    });
    eq("save new amounts beside the echoed band -> 200", money.status, 200);
    const after = await row(bandRow);
    numEq("  order total rewritten", after?.orderPrice, 150);
    numEq("  charge above rewritten", after?.above, 12.5);
    numEq("  charge below untouched", after?.below, 8);
    eq("  the band is still where it was", `${after?.dFrom}-${after?.dTo}`, "200-500");
    eq("  the location is still the sentinel", after?.iLocationId, 0);
    numEq("  the money edit lands in the DTO too", money.json?.item?.settings?.fOrderPriceValue, 150);

    const nothing = await put(`/delivery-charge/genie/${bandRow}`, {});
    refused("PUT with an empty body -> 400", nothing, "Send the location");

    const blankRequired = await put(`/delivery-charge/genie/${bandRow}`, { settings: { fOrderPriceValue: "" } });
    refused("blanking a required amount -> 400", blankRequired, "is required");

    const blankOptional = await put(`/delivery-charge/genie/${bandRow}`, { settings: { iFreeDeliveryRadius: "" } });
    eq("blanking an optional amount -> 200", blankOptional.status, 200);
    numEq("  radius stored as 0", (await row(bandRow))?.freeRadius, 0);

    const outRange = await put(`/delivery-charge/genie/${bandRow}`, { settings: { fOrderPriceValue: 1e12 } });
    refused("an out-of-range amount on edit -> 400", outRange, "between 0 and");

    const ghost = await put("/delivery-charge/genie/999999", { settings: { fOrderPriceValue: 1 } });
    eq("PUT a row that does not exist -> 404", ghost.status, 404);

    const list = await get("/delivery-charge/genie/list");
    eq("the list carries every live scheme, newest first", (list.json?.items ?? []).length, baseline + 3);
    eq("  and reports the switches beside them", list.json?.features?.distanceWise, true);
    ok("  Buy Any Service too, because the Genie module is on", list.json?.features?.buyAnyService === true, JSON.stringify(list.json?.features));
  }

  // =========================================================================
  console.log("\n--- status, on the scheme that owns a whole zone ---");
  {
    console.log(`  deactivating #${zoneBlankRow}, the scheme that owns zone two`);
    const off = await patch(`/delivery-charge/genie/${zoneBlankRow}/status`, { status: "Inactive" });
    eq("PATCH to Inactive -> 200", off.status, 200);
    eq("  the row is Inactive", (await row(zoneBlankRow))?.eStatus, "Inactive");
    eq("  an Inactive scheme is still readable", (await get(`/delivery-charge/genie/${zoneBlankRow}`)).status, 200);
    eq("  and still editable, as the legacy list allowed", (await put(`/delivery-charge/genie/${zoneBlankRow}`, { settings: { fOrderPriceValue: 45 } })).status, 200);
    const filtered = await get("/delivery-charge/genie/list?status=Active");
    ok("  and drops out of the Active filter",
      !(filtered.json?.items ?? []).some((i) => i.id === zoneBlankRow),
      JSON.stringify((filtered.json?.items ?? []).map((i) => i.id)));
    const shown = await get("/delivery-charge/genie/list?status=Inactive");
    ok("  and appears in the Inactive one",
      (shown.json?.items ?? []).some((i) => i.id === zoneBlankRow),
      JSON.stringify((shown.json?.items ?? []).map((i) => i.id)));
    const bogus = await patch(`/delivery-charge/genie/${zoneBlankRow}/status`, { status: "Deleted" });
    ok("PATCH to Deleted is refused (that is what DELETE is for)", bogus.status === 400, `status ${bogus.status}`);
    eq("  and the row kept its status", (await row(zoneBlankRow))?.eStatus, "Inactive");
    const on = await patch(`/delivery-charge/genie/${zoneBlankRow}/status`, { status: "Active" });
    eq("PATCH back to Active -> 200", on.status, 200);
    eq("  the row is Active again", (await row(zoneBlankRow))?.eStatus, "Active");
  }

  // =========================================================================
  console.log("\n--- delete is name-confirmed, soft, and deaf to the distance-wise table ---");
  {
    // `custom_delivery_charges_order` holds rows numbered 1 and 2, and so does this table:
    // both spell their own keyless id `iDeliveyChargeId` and each counted from 1. Those
    // numbers are not a link, so nothing may be refused on their account — and to prove it
    // rather than assume it, seed a band carrying the id of a scheme about to be deleted.
    const z5 = await seedZone("ZZ b154 zone five");
    const made = await post("/delivery-charge/genie", {
      locationId: z5,
      settings: charge(MIRROR.from, MIRROR.to, { fOrderPriceValue: 30, fDeliveryChargeAbove: 3, fDeliveryChargeBelow: 3 }),
    });
    eq("create a scheme to delete -> 201", made.status, 201);
    const victim = made.json?.item?.id ?? 0;
    created.push(victim);

    await db.query(
      `INSERT INTO custom_delivery_charges_order
         (iDeliveyChargeId, iDistanceRangeFrom, iDistanceRangeTo, fDeliveryCharge, eStatus,
          fDeliveryChargeUser, fDeliveryChargeCancelled, iVehicleTypeId)
       VALUES (?, ?, ?, ?, 'Active', 0.00, 2.00, ?)`,
      [victim, MIRROR.from, MIRROR.to, MIRROR.charge, MIRROR.vehicleTypeId],
    );
    const mirror = await one(
      "SELECT iDeliveyChargeId AS chargeId, fDeliveryCharge AS charge FROM custom_delivery_charges_order WHERE iVehicleTypeId = ? AND iDistanceRangeTo = ? LIMIT 1",
      [MIRROR.vehicleTypeId, MIRROR.to],
    );
    eq("the other table now carries a row with that same number", mirror?.chargeId, victim);

    const wrong = await del(`/delivery-charge/genie/${victim}`, { confirm: "somewhere else" });
    refused("DELETE with the wrong confirmation -> 400", wrong, "does not match");
    ok("  and it names the zone instead", message(wrong).includes("ZZ b154 zone five"), message(wrong));

    const bare = await del(`/delivery-charge/genie/${victim}`, {});
    ok("DELETE with no confirmation -> 400", bare.status === 400, `status ${bare.status}`);

    const before = await liveCount();
    const gone = await del(`/delivery-charge/genie/${victim}`, { confirm: "ZZ b154 zone five" });
    eq("DELETE it while the number also keys a distance-wise row -> 200", gone.status, 200);
    eq("  the row is kept and marked Deleted", (await row(victim))?.eStatus, "Deleted");
    eq("  the list dropped exactly one", await liveCount(), before - 1);
    const left = await one(
      "SELECT COUNT(*) AS n FROM custom_delivery_charges_order WHERE iVehicleTypeId = ? AND iDistanceRangeTo = ?",
      [MIRROR.vehicleTypeId, MIRROR.to],
    );
    eq("  and the other screen's row is still there, untouched", Number(left?.n), 1);
    eq("GET the deleted scheme -> 404", (await get(`/delivery-charge/genie/${victim}`)).status, 404);
    eq("PATCH the deleted scheme -> 404", (await patch(`/delivery-charge/genie/${victim}/status`, { status: "Active" })).status, 404);
    eq("PUT the deleted scheme -> 404", (await put(`/delivery-charge/genie/${victim}`, { settings: { fOrderPriceValue: 1 } })).status, 404);
    eq("DELETE it twice -> 404", (await del(`/delivery-charge/genie/${victim}`, { confirm: "ZZ b154 zone five" })).status, 404);
    await removeMirror();

    ok("  and the shared rows the other menus would list are still here",
      (await get("/delivery-charge/genie/list")).json?.items?.some((i) => i.id === 1) === true);
  }

  // =========================================================================
  console.log(`\n--- flipping ${DISTANCE_FLAG} to No (waiting ${TTL / 1000}s for the meta cache) ---`);
  await setFlag("No");
  await sleep(TTL);

  {
    const list = await get("/delivery-charge/genie/list");
    eq("the list reports distance-wise off", list.json?.features?.distanceWise, false);
    ok("  and Buy Any Service is still on", list.json?.features?.buyAnyService === true, JSON.stringify(list.json?.features));

    const defaults = await get("/delivery-charge/genie/defaults");
    const specs = (defaults.json?.item?.fieldSpecs ?? []).map((f) => f.column);
    ok("the add form drops the band fields", !specs.includes("iDistanceRangeFrom"), specs.join(","));
    ok("  and keeps the Buy Any Service ones", specs.includes("fDeliveryChargeBuyAnyService"), specs.join(","));
    eq("  the scope is editable again", defaults.json?.item?.scopeEditable, true);
  }

  // =========================================================================
  console.log("\n--- distance-wise OFF: one scheme per location, band written as 0→∞ ---");
  {
    const wantId = await nextId();
    const made = await post("/delivery-charge/genie", {
      locationId: z3,
      settings: { fOrderPriceValue: 40, fDeliveryChargeAbove: 4, fDeliveryChargeBelow: 2 },
    });
    eq("create without any band at all -> 201", made.status, 201);
    const id = made.json?.item?.id ?? 0;
    eq("  next id", id, wantId);
    created.push(id);
    const r = await row(id);
    numEq("  the band defaults to starting at 0", r?.dFrom, 0);
    numEq("  and running to the sentinel, so the row keeps its meaning if the switch flips back", r?.dTo, OPEN);
    numEq("  Buy Any Service amounts are 0 while unsent", r?.anySvc, 0);
    eq("  the DTO calls the band open", made.json?.item?.distance?.open, true);

    const again = await post("/delivery-charge/genie", {
      locationId: z3,
      settings: { fOrderPriceValue: 60, fDeliveryChargeAbove: 6, fDeliveryChargeBelow: 3 },
    });
    refused("a second scheme for the same location -> 400", again, "already exist");
    ok("  and it names the scheme that holds it", message(again).includes(`#${id}`), message(again));

    const taken = await post("/delivery-charge/genie", {
      locationId: z2,
      settings: { fOrderPriceValue: 60, fDeliveryChargeAbove: 6, fDeliveryChargeBelow: 3 },
    });
    refused("a scheme for a location another row already holds -> 400", taken, "already exist");

    const allLoc = await post("/delivery-charge/genie", {
      locationId: 0,
      settings: { fOrderPriceValue: 70, fDeliveryChargeAbove: 7, fDeliveryChargeBelow: 7 },
    });
    refused("a scheme for All locations, which the legacy row owns -> 400", allLoc, "already exist");
    ok("  and it names a live scheme of that location, never the deleted one",
      message(allLoc).includes(`#${bandRow}`), message(allLoc));

    const banded = await post("/delivery-charge/genie", {
      locationId: z4,
      settings: { fOrderPriceValue: 10, fDeliveryChargeAbove: 1, fDeliveryChargeBelow: 1, iDistanceRangeFrom: 0, iDistanceRangeTo: 50 },
    });
    refused("sending a band while the switch is off -> 400", banded, "only editable while distance-wise");

    const editBand = await put(`/delivery-charge/genie/${id}`, { settings: { iDistanceRangeTo: 500 } });
    refused("editing a band while the switch is off -> 400", editBand, "only editable while distance-wise");

    const moved = await put(`/delivery-charge/genie/${id}`, { locationId: z4 });
    eq("move the scheme to an empty location -> 200", moved.status, 200);
    numEq("  the location column is written", (await row(id))?.iLocationId, z4);

    const blocked = await put(`/delivery-charge/genie/${id}`, { locationId: z2 });
    refused("move it onto a location that has one -> 400", blocked, "already exist");

    const back = await put(`/delivery-charge/genie/${id}`, { locationId: z3 });
    eq("move it back -> 200", back.status, 200);
    numEq("  the location column is written again", (await row(id))?.iLocationId, z3);
  }

  // =========================================================================
  console.log("\n--- a Deleted scheme does not hold its location ---");
  {
    // Zone one holds the open-ended band made while the switch was on. Hide it here: with
    // the bands out of charge a location is defined by its live rows, so the zone has to be
    // priceable again — which is the whole point of hiding a row instead of erasing it.
    const gone = await del(`/delivery-charge/genie/${zoneOpenRow}`, { confirm: "ZZ b154 zone one" });
    eq("DELETE the zone's only scheme -> 200", gone.status, 200);
    eq("  the row is kept and marked Deleted", (await row(zoneOpenRow))?.eStatus, "Deleted");

    const again = await post("/delivery-charge/genie", {
      locationId: z1,
      settings: { fOrderPriceValue: 25, fDeliveryChargeAbove: 2, fDeliveryChargeBelow: 2 },
    });
    eq("price the zone whose scheme was deleted -> 201", again.status, 201);
    const againId = again.json?.item?.id ?? 0;
    created.push(againId);
    eq("  the hidden row is untouched in the table", (await row(zoneOpenRow))?.eStatus, "Deleted");
    eq("  and it is not the row just written", againId !== zoneOpenRow, true);
    const name = again.json?.item?.scope?.label;
    eq("DELETE it again -> 200", (await del(`/delivery-charge/genie/${againId}`, { confirm: name })).status, 200);
    eq("  leaving the zone to the one hidden row", await liveAtZone(z1), 0);
  }
} catch (err) {
  failures.push(`the run threw: ${err?.message ?? err}`);
  console.log(`  FAIL the run threw — ${err?.stack ?? err}`);
} finally {
  console.log(`\n--- flipping ${DISTANCE_FLAG} back to Yes and dropping the zones ---`);
  await cleanUp();
  await sleep(TTL);
}

{
  const list = await get("/delivery-charge/genie/list");
  eq("the list reports distance-wise on again", list.json?.features?.distanceWise, true);
  const defaults = await get("/delivery-charge/genie/defaults");
  ok("  and the band fields are back",
    (defaults.json?.item?.fieldSpecs ?? []).some((f) => f.column === "iDistanceRangeFrom"),
    (defaults.json?.item?.fieldSpecs ?? []).map((f) => f.column).join(","));
  console.log(`live rows after the run: ${await liveCount()} (baseline ${baseline})`);
  console.log(`zones seeded and dropped: ${seeded.join(", ")}`);
  console.log("expected: the created rows sit in the table as Deleted until `node scripts/b154.mjs restore`");
}

console.log(`\nb154-write: ${pass} ok, ${failures.length} failed`);
if (failures.length) console.log(failures.map((f) => ` - ${f}`).join("\n"));

await db.end();
process.exit(failures.length ? 1 : 0);
