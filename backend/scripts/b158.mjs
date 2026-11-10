// Verification helpers for Delivery Runner → Distance wise Delivery Charges (#sub-158), the
// Runner twin of #sub-155. Both menus, and the un-suffixed one under group 9, read and write
// ONE shared legacy table: `custom_delivery_charges_order` has no service-line column, and
// `custom_delivery_charge_order.php:269` builds the vehicle-type dropdown with a hard-coded
// `AND vt.eType = 'DeliverAll'` that never looks at `$eType`. So `?eType=runner` only re-suffixes
// the four keys it checks and renames the page script — it does NOT slice the rows or the dropdown.
// Everything below is reversible, and it has to be: this screen **hard deletes** (the legacy
// action runs `DELETE FROM custom_delivery_charges_order`), so a test that removes a band takes it
// out of the pricing all three apps read until `restore` puts it back.
//
// This tool targets the same table as b155.mjs on purpose — they are one dataset seen through two
// menus — but keeps its own snapshot/fingerprint files so a #sub-158 run never clobbers #sub-155's.
// Run b155-write and b158-write SEQUENTIALLY (never concurrently): same table, hard deletes.
//
//   node scripts/b158.mjs probe
//   node scripts/b158.mjs snapshot
//   node scripts/b158.mjs fingerprint <name>
//   node scripts/b158.mjs restore
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import mysql from "mysql2/promise";
import "dotenv/config";

const DUMP = path.resolve("..", ".lh", "b158-rows.json");
const PREFIX = "b158";
/** Keyless table: `iDeliveyChargeId` has no primary key, index or auto-increment, and it is
 * *this* table's own id (not a pointer into `delivery_charges`). A row's identity is its id plus
 * which duplicate of that id this is. */
const ID = "iDeliveyChargeId";
const TABLE = "custom_delivery_charges_order";
const SUB_GROUPS = "admin_pro_permission_display_sub_groups";

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

/** One line per row, rows sorted: with no declared key the engine keeps rows by a hidden
 * row id, so a re-inserted band can land somewhere else without being a different band. */
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
  console.log(
    "note: this table carries NO service-line column, so the rows below are the SAME rows",
  );
  console.log("      Genie (#sub-155) and the un-suffixed menu (#sub-27) list and edit.");
  const [rows] = await conn.query(
    `SELECT dc.${ID} AS id, dc.iVehicleTypeId AS vehicleTypeId,
            vt.vVehicleType_EN AS vehicleType, vt.eStatus AS vehicleStatus,
            vt.iLocationId AS loc, lm.vLocationName AS locationName,
            dc.iDistanceRangeFrom AS dFrom, dc.iDistanceRangeTo AS dTo,
            dc.fDeliveryCharge AS driverDone, dc.fDeliveryChargeCancelled AS driverCancel,
            dc.fDeliveryChargeUser AS userCharge, dc.eStatus
       FROM ${TABLE} dc
       LEFT JOIN vehicle_type vt ON vt.iVehicleTypeId = dc.iVehicleTypeId
       LEFT JOIN location_master lm ON lm.iLocationId = vt.iLocationId
      ORDER BY dc.${ID}`,
  );
  console.log("bands:");
  console.log(rows.map((r) => JSON.stringify(r)).join("\n") || "(none)");
  const [flags] = await conn.query(
    `SELECT vName, vValue, eStatus FROM configurations
      WHERE vName IN ('ENABLE_CUSTOM_DELIVERY_CHARGE_ORDER','DEFAULT_DISTANCE_UNIT')`,
  );
  console.log("switches:");
  console.log(flags.map((r) => JSON.stringify(r)).join("\n"));
  // The dropdown the runner menu must offer — byte-for-byte genie's, because php:269 never
  // branches on $eType. Any runner-only filtering here would be a fabricated slice.
  const [types] = await conn.query(
    `SELECT iVehicleTypeId, vVehicleType_EN, iLocationId, eStatus FROM vehicle_type
      WHERE eType = 'DeliverAll' ORDER BY iDisplayOrder, iVehicleTypeId`,
  );
  console.log("deliverable vehicle types (the runner dropdown, identical to genie's):");
  console.log(types.map((r) => JSON.stringify(r)).join("\n"));
  console.log("\n--- the three menus over one table: keys grouped by sub-group ---");
  const [keys] = await conn.query(
    `SELECT id, permission_name, status, display_group_id, display_sub_group_id, eFor
       FROM admin_pro_permissions
      WHERE permission_name LIKE '%custom-delivery-charges%'
      ORDER BY display_sub_group_id, id`,
  );
  const bySub = new Map();
  for (const k of keys) {
    if (!bySub.has(k.display_sub_group_id)) bySub.set(k.display_sub_group_id, []);
    bySub.get(k.display_sub_group_id).push(k);
  }
  const label = {
    27: "un-suffixed (#sub-27, group 9)",
    155: "GENIE (#sub-155, group 33)",
    158: "RUNNER (#sub-158, group 34) ← this screen",
  };
  for (const [sub, list] of [...bySub.entries()].sort((a, b) => a[0] - b[0])) {
    const active = list.filter((k) => k.status === "Active").length;
    const inactive = list.filter((k) => k.status !== "Active").length;
    console.log(`sub-${sub} ${label[sub] ?? ""}: ${active} Active, ${inactive} Inactive`);
    for (const k of list) {
      console.log(
        `   ${String(k.id).padStart(3)}  ${k.status.padEnd(8)}  ${k.permission_name}  (eFor=${k.eFor})`,
      );
    }
  }
  console.log(
    "\nreminder: the tree filters out Inactive keys, so sub-158 exposes exactly its four",
  );
  console.log("Active keys (view/create/edit/delete). Its 846 update-status is Inactive AND the");
  console.log("route set owns no status endpoint at all — deletes here are HARD, not status flips.");
  const [subs] = await conn.query(
    `SELECT id, name, eFor, iGroupsId, display_order FROM ${SUB_GROUPS}
      WHERE id IN (27,155,158) ORDER BY id`,
  );
  console.log("\nsub-group names (verbatim, straight from the seed):");
  for (const s of subs) console.log(`   ${s.id} [group ${s.iGroupsId}, eFor=${s.eFor}] "${s.name}"`);
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
  writeFileSync(path.resolve("..", ".lh", `${PREFIX}-${name}.txt`), `${canonical(cols, rows)}\n`);
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

  // 1. bands a test added (a create inserts one fresh id, MAX+1, since the column has no
  // auto-increment).
  for (const [k, row] of haveMap) {
    if (wantMap.has(k)) continue;
    const w = whereAll(cols, row);
    await conn.query(`DELETE FROM ${TABLE} WHERE ${w.sql} LIMIT 1`, w.params);
    removed += 1;
  }

  // 2. bands a test hard-deleted — the only way this screen removes a row.
  for (const [k, row] of wantMap) {
    if (haveMap.has(k)) continue;
    const vals = rowValues(cols, row);
    await conn.query(
      `INSERT INTO ${TABLE} (${cols.map((c) => `\`${c}\``).join(", ")}) VALUES (${vals.map(() => "?").join(", ")})`,
      vals,
    );
    created += 1;
  }

  // 3. bands that exist on both sides but were re-priced.
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
  console.log("usage: b158.mjs probe | snapshot | fingerprint <name> | restore");
}

await conn.end();
