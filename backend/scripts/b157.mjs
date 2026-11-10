// Verification helpers for Delivery Runner → Delivery Charges (#sub-157), the second
// registered menu over the one shared legacy `delivery_charges` table.
//
// Like Vehicle Type, this is not a row slice — and the legacy proof here is even blunter
// than for #sub-156. `delivery_charges.php` reads `?eType=runner` only to pick the
// `-runner-delivery` key suffix and rename its page script (lines 13–31); the list query
// that follows is `FROM delivery_charges dc LEFT JOIN location_master … WHERE 1 = 1`, with
// no service-line column in the table to filter by even if it wanted one. So Genie
// (#sub-154), Runner (#sub-157) and the un-suffixed menu (group 9, sub-group 27 'Utility')
// price literally the same rows, which is why sub-group 157's own seeded name carries the
// warning. The snapshot therefore covers the WHOLE table: a runner write moves genie's
// data, and scoping the dump to a "runner slice" would hide exactly that.
//
//   node scripts/b157.mjs probe
//   node scripts/b157.mjs snapshot
//   node scripts/b157.mjs fingerprint <name>
//   node scripts/b157.mjs restore
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import mysql from "mysql2/promise";
import "dotenv/config";

const DUMP = path.resolve("..", ".lh", "b157-rows.json");
/** No primary key, no index and no auto-increment, so a row's identity is its id plus
 * which copy of that id this is (the legacy screen let MySQL hand out 0). */
const ID = "iDeliveyChargeId";
const TABLE = "delivery_charges";

const conn = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

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

/** One line per row, rows sorted: InnoDB keeps a keyless table by a hidden row id, so a
 * re-inserted row can land elsewhere without being a different scheme. */
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
  const parts = cols.map((c, i) =>
    vals[i] === null ? `\`${c}\` IS NULL` : `\`${c}\` = ?`,
  );
  return { sql: parts.join(" AND "), params: vals.filter((v) => v !== null) };
}

const cmd = process.argv[2];

if (cmd === "probe") {
  const cols = await columns();
  console.log("columns:", cols.length, "|", cols.join(", "));
  const [counts] = await conn.query(
    `SELECT COUNT(*) AS n, COUNT(DISTINCT ${ID}) AS d, MAX(${ID}) AS max_id FROM ${TABLE}`,
  );
  console.log(
    `rows: ${counts[0].n} | distinct id: ${counts[0].d} | max id: ${counts[0].max_id}`,
  );

  console.log("\n--- every row of the table both menus price (no slice to scope) ---");
  const [rows] = await conn.query(
    `SELECT dc.${ID} AS id, dc.iLocationId AS loc, lm.vLocationName AS location,
            dc.fOrderPriceValue AS orderTotal,
            dc.fDeliveryChargeAbove AS above, dc.fDeliveryChargeBelow AS below,
            dc.fFreeOrderPriceSubtotal AS freeAbove, dc.iFreeDeliveryRadius AS freeRadius,
            dc.iDistanceRangeFrom AS dFrom, dc.iDistanceRangeTo AS dTo,
            dc.fDeliveryChargeBuyAnyService AS buyAny, dc.fDeliveryChargeBuyAnyServiceCancelledOrder AS buyAnyCancel,
            dc.eStatus
       FROM ${TABLE} dc LEFT JOIN location_master lm ON lm.iLocationId = dc.iLocationId
      ORDER BY dc.${ID}`,
  );
  console.table(rows);

  console.log("\n--- the switches that decide which fields exist at all ---");
  const [flags] = await conn.query(
    `SELECT vName, vValue, eStatus FROM configurations
      WHERE vName IN ('ENABLE_CUSTOM_DELIVERY_CHARGE_ORDER','ENABLE_BUY_ANY_SERVICE_MODULE')`,
  );
  console.table(flags);

  console.log("\n--- the zones the shared location dropdown offers (eFor marker) ---");
  const [zones] = await conn.query(
    `SELECT iLocationId, vLocationName, eStatus FROM location_master
      WHERE eFor = 'UserDeliveryCharge' ORDER BY iLocationId`,
  );
  console.table(zones);

  console.log("\n--- the sub-groups of this screen, names verbatim from the DB ---");
  const [subs] = await conn.query(
    `SELECT id, name, eFor, iGroupsId, eStatus
       FROM admin_pro_permission_display_sub_groups WHERE id IN (27, 154, 157) ORDER BY id`,
  );
  console.table(subs);

  console.log("\n--- the three key families over that one table ---");
  const [keys] = await conn.query(
    `SELECT id, permission_name, status, display_group_id, display_sub_group_id
       FROM admin_pro_permissions
      WHERE permission_name LIKE '%-delivery-charges%'
         AND permission_name NOT LIKE '%custom%'
      ORDER BY display_sub_group_id, id`,
  );
  console.table(keys);

  console.log(
    "\nnote: runner's edit key (847) sorts AFTER delete and update-status, because the",
    "\nseed gave it the last id — the tree lists sub-group 157 as view, create, delete,",
    "update-status, edit. Genie's family (823–827) runs in action order.",
  );
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
  writeFileSync(path.resolve("..", ".lh", `b157-${name}.txt`), `${canonical(cols, rows)}\n`);
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

  // 2. rows a test removed (the screen only soft-deletes, so this is belt and braces).
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
  console.log("usage: b157.mjs probe | snapshot | fingerprint <name> | restore");
}

await conn.end();
