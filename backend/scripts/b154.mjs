// Verification helpers for Delivery Charges (#sub-154), whose menus all read and write
// the one shared legacy `delivery_charges` table — the screen has no service-line column,
// so Genie (#sub-154), Runner (group 34) and the un-suffixed menu (group 9) edit the same
// rows. Everything is reversible: `snapshot` dumps every row (including Deleted ones),
// `fingerprint` writes a canonical text dump for before/after diffing and `restore` makes
// the live table byte-identical to the snapshot again.
//
//   node scripts/b154.mjs probe
//   node scripts/b154.mjs snapshot
//   node scripts/b154.mjs fingerprint <name>
//   node scripts/b154.mjs restore
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import mysql from "mysql2/promise";
import "dotenv/config";

const DUMP = path.resolve("..", ".lh", "b154-rows.json");
/** `iDeliveyChargeId` carries no primary key, no index and no auto-increment in this
 * keyless table, so a row's identity is its id plus which copy of it this is. */
const ID = "iDeliveyChargeId";
const TABLE = "delivery_charges";

const conn = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

/** Column names in DDL order, so a fingerprint is stable across runs. */
async function columns() {
  const [rows] = await conn.query(`SHOW COLUMNS FROM ${TABLE}`);
  return rows.map((c) => c.Field);
}

async function allRows(cols) {
  const [rows] = await conn.query(`SELECT ${cols.map((c) => `\`${c}\``).join(", ")} FROM ${TABLE}`);
  return rows;
}

function pad(n, w) {
  return String(n).padStart(w, "0");
}

function norm(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const d = value;
    return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)} ` +
      `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}`;
  }
  if (Buffer.isBuffer(value)) return value.toString("hex");
  return value;
}

function rowValues(cols, row) {
  return cols.map((c) => norm(row[c]));
}

/** One line per row, rows sorted: with no declared key InnoDB keeps rows by a hidden row
 * id, so a re-inserted row can land somewhere else without being a different scheme. */
function canonical(cols, rows) {
  return rows
    .map((r) => cols.map((c) => `${c}=${String(norm(r[c]) ?? "<NULL>")}`).join("|"))
    .sort()
    .join("\n");
}

function keyOf(rows) {
  const seen = new Map();
  return rows.map((r) => {
    const base = String(r[ID]);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return `${base}#${n}`;
  });
}

function eq(cols, a, b) {
  const va = rowValues(cols, a);
  const vb = rowValues(cols, b);
  return va.every((v, i) => String(v ?? "<NULL>") === String(vb[i] ?? "<NULL>"));
}

function whereAll(cols, row) {
  const vals = rowValues(cols, row);
  const parts = cols.map((c, i) => (vals[i] === null ? `\`${c}\` IS NULL` : `\`${c}\` = ?`));
  return { sql: parts.join(" AND "), params: vals.filter((v) => v !== null) };
}

const cmd = process.argv[2];

if (cmd === "probe") {
  const cols = await columns();
  console.log("columns:", cols.length, "|", cols.join(", "));
  const [counts] = await conn.query(`SELECT COUNT(*) AS n, MAX(${ID}) AS max_id FROM ${TABLE}`);
  console.log("rows:", counts[0].n, "| max id:", counts[0].max_id);
  const [byStatus] = await conn.query(`SELECT eStatus, COUNT(*) AS n FROM ${TABLE} GROUP BY eStatus`);
  console.table(byStatus);
  const [rows] = await conn.query(
    `SELECT dc.${ID} AS id, dc.iLocationId AS loc, lm.vLocationName AS name,
            dc.fOrderPriceValue AS orderPrice, dc.fDeliveryChargeAbove AS above,
            dc.fDeliveryChargeBelow AS below, dc.fFreeOrderPriceSubtotal AS freeSubtotal,
            dc.iFreeDeliveryRadius AS freeRadius, dc.iDistanceRangeFrom AS dFrom,
            dc.iDistanceRangeTo AS dTo, dc.fDeliveryChargeBuyAnyService AS anySvc,
            dc.fDeliveryChargeBuyAnyServiceCancelledOrder AS anySvcCancel, dc.eStatus
       FROM ${TABLE} dc LEFT JOIN location_master lm ON lm.iLocationId = dc.iLocationId
      ORDER BY dc.${ID}`,
  );
  console.table(rows);
  const [flags] = await conn.query(
    `SELECT vName, vValue, eStatus FROM configurations
      WHERE vName IN ('ENABLE_CUSTOM_DELIVERY_CHARGE_ORDER','ENABLE_BUY_ANY_SERVICE_MODULE')`,
  );
  console.table(flags);
  const [zones] = await conn.query(
    `SELECT iLocationId, vLocationName, eStatus FROM location_master
      WHERE eFor = 'UserDeliveryCharge' ORDER BY iLocationId`,
  );
  console.table(zones);
  // The distance-wise screen's own table (#sub-155). Its `iDeliveyChargeId` is that
  // table's keyless id — the same column name spelled twice, not a reference into the
  // rows above, which is why both tables can hold a #1 and a #2 at the same time.
  const links = await conn.query(
    `SELECT dc.iDeliveyChargeId AS id, dc.iVehicleTypeId AS vehicleTypeId,
            vt.vVehicleType_EN AS vehicleType, vt.iLocationId AS loc,
            lm.vLocationName AS locationName,
            dc.iDistanceRangeFrom AS dFrom, dc.iDistanceRangeTo AS dTo, dc.fDeliveryCharge,
            dc.fDeliveryChargeUser, dc.fDeliveryChargeCancelled, dc.eStatus
       FROM custom_delivery_charges_order dc
       LEFT JOIN vehicle_type vt ON vt.iVehicleTypeId = dc.iVehicleTypeId
       LEFT JOIN location_master lm ON lm.iLocationId = vt.iLocationId
      ORDER BY dc.iDeliveyChargeId`,
  ).then(([r]) => r, () => []);
  console.log('distance-wise bands — their own ids, their own vehicle types:');
  console.table(links);
} else if (cmd === "snapshot") {
  const cols = await columns();
  const rows = (await allRows(cols)).map((r) =>
    Object.fromEntries(cols.map((c) => [c, norm(r[c])])),
  );
  writeFileSync(DUMP, JSON.stringify({ cols, rows }));
  console.log(`snapshot: ${rows.length} rows x ${cols.length} columns -> ${DUMP}`);
} else if (cmd === "fingerprint") {
  const name = process.argv[3] ?? "now";
  const cols = await columns();
  const rows = await allRows(cols);
  writeFileSync(path.resolve("..", ".lh", `b154-${name}.txt`), `${canonical(cols, rows)}\n`);
  console.log(`fingerprint ${name}: ${rows.length} rows`);
} else if (cmd === "restore") {
  const cols = await columns();
  const dump = JSON.parse(readFileSync(DUMP, "utf8"));
  const want = dump.rows;
  const have = await allRows(cols);
  const wantMap = new Map(keyOf(want).map((k, i) => [k, want[i]]));
  const haveMap = new Map(keyOf(have).map((k, i) => [k, have[i]]));

  let created = 0;
  let removed = 0;
  let rewritten = 0;

  // 1. rows a test added (a create inserts one fresh id; nothing else grows this table).
  for (const [k, row] of haveMap) {
    if (wantMap.has(k)) continue;
    const w = whereAll(cols, row);
    await conn.query(`DELETE FROM ${TABLE} WHERE ${w.sql} LIMIT 1`, w.params);
    removed += 1;
  }

  // 2. rows a test hard-deleted (the screen only soft-deletes, so this is belt and braces).
  for (const [k, row] of wantMap) {
    if (haveMap.has(k)) continue;
    const vals = rowValues(cols, row);
    await conn.query(
      `INSERT INTO ${TABLE} (${cols.map((c) => `\`${c}\``).join(", ")}) VALUES (${vals.map(() => "?").join(", ")})`,
      vals,
    );
    created += 1;
  }

  // 3. rows that exist on both sides but were edited (amounts, zone, band, status).
  for (const [k, target] of wantMap) {
    const live = haveMap.get(k);
    if (!live || eq(cols, live, target)) continue;
    const setCols = cols.filter(
      (c) =>
        c !== ID &&
        String(norm(live[c]) ?? "<NULL>") !== String(norm(target[c]) ?? "<NULL>"),
    );
    if (!setCols.length) continue;
    const params = setCols.map((c) => norm(target[c]));
    const w = whereAll(cols, live);
    await conn.query(
      `UPDATE ${TABLE} SET ${setCols.map((c) => `\`${c}\` = ?`).join(", ")} WHERE ${w.sql} LIMIT 1`,
      [...params, ...w.params],
    );
    rewritten += 1;
  }

  const after = await allRows(cols);
  console.log(`restore: re-inserted ${created}, deleted ${removed}, rewrote ${rewritten}`);
  console.log(`live rows now: ${after.length} (snapshot held ${want.length})`);
} else {
  console.log("usage: b154.mjs probe | snapshot | fingerprint <name> | restore");
}

await conn.end();
