// Verification helpers for the Vehicle Type screen, whose three `:app` slices (#sub-15
// ride / #sub-138 parcel / #sub-153 genie) all read and write the shared legacy
// `vehicle_type` table. Everything is reversible: `snapshot` dumps every row,
// `fingerprint` writes a canonical text dump for before/after diffing and `restore` makes
// the live table byte-identical to the snapshot again (inserting what a test deleted,
// deleting what a test created, rewriting what a test changed).
//
//   node scripts/b153.mjs probe
//   node scripts/b153.mjs snapshot
//   node scripts/b153.mjs fingerprint <name>
//   node scripts/b153.mjs restore
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import mysql from "mysql2/promise";
import "dotenv/config";

const DUMP = path.resolve("..", ".lh", "b153-rows.json");
/** `iVehicleTypeId` is not unique and carries no index at all in this keyless table, so
 * the identity of a row is its id plus which copy of it this is, in DDL column order. */
const ID = "iVehicleTypeId";

const conn = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

/** Column names in DDL order, so a fingerprint is stable across runs. */
async function columns() {
  const [rows] = await conn.query("SHOW COLUMNS FROM vehicle_type");
  return rows.map((c) => c.Field);
}

async function allRows(cols) {
  const [rows] = await conn.query(`SELECT ${cols.map((c) => `\`${c}\``).join(", ")} FROM vehicle_type`);
  return rows;
}

function pad(n, w) {
  return String(n).padStart(w, "0");
}

/** Driver Dates -> the literal MySQL wrote, so a restore round-trips exactly. */
function fmtDate(d) {
  const date = `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`;
  const time = `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}`;
  return `${date} ${time}`;
}

function norm(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return fmtDate(value);
  if (Buffer.isBuffer(value)) return value.toString("hex");
  return value;
}

function rowValues(cols, row) {
  return cols.map((c) => norm(row[c]));
}

/** One line per row, rows sorted: the table declares no key, so InnoDB keeps rows by a
 * hidden row id and a re-inserted row can land somewhere else without being a different
 * vehicle type. */
function canonical(cols, rows) {
  return rows
    .map((r) => cols.map((c) => `${c}=${String(norm(r[c]) ?? "<NULL>")}`).join("|"))
    .sort()
    .join("\n");
}

/** id + occurrence, so duplicate ids in the legacy data cannot collapse into one entry. */
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
  const params = vals.filter((v) => v !== null);
  return { sql: parts.join(" AND "), params };
}

const cmd = process.argv[2];

if (cmd === "probe") {
  const cols = await columns();
  console.log("columns:", cols.length, "|", cols.slice(0, 6).join(", "), "…");
  const [counts] = await conn.query(
    `SELECT COUNT(*) AS n, COUNT(DISTINCT ${ID}) AS d FROM vehicle_type`,
  );
  console.log("rows:", counts[0].n, "| distinct id:", counts[0].d);
  const [max] = await conn.query(`SELECT MAX(${ID}) AS max_id FROM vehicle_type`);
  console.log("max id:", max[0].max_id);
  const [slices] = await conn.query(
    `SELECT eType, eStatus, COUNT(*) AS n, MAX(iDisplayOrder) AS max_order
       FROM vehicle_type GROUP BY eType, eStatus ORDER BY eType, eStatus`,
  );
  console.table(slices);
  const [genie] = await conn.query(
    `SELECT ${ID} AS id, vVehicleType_EN AS name, iLocationid, fDeliveryCharge,
            fDeliveryChargeCancelOrder, fRadius, fCommision, iDisplayOrder, eStatus
       FROM vehicle_type WHERE eType = 'DeliverAll' ORDER BY ${ID}`,
  );
  console.table(genie);
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
  writeFileSync(path.resolve("..", ".lh", `b153-${name}.txt`), `${canonical(cols, rows)}\n`);
  console.log(`fingerprint ${name}: ${rows.length} rows`);
} else if (cmd === "restore") {
  const cols = await columns();
  const dump = JSON.parse(readFileSync(DUMP, "utf8"));
  const want = dump.rows;
  const have = await allRows(cols);
  const wantMap = new Map(keyOf(want).map((k, i) => [k, want[i]]));
  const haveKeys = keyOf(have);
  const haveMap = new Map(haveKeys.map((k, i) => [k, have[i]]));

  let created = 0;
  let removed = 0;
  let rewritten = 0;

  // 1. rows a test added (a create inserts one fresh id; nothing else ever grows the table).
  for (const [k, row] of haveMap) {
    if (wantMap.has(k)) continue;
    const w = whereAll(cols, row);
    await conn.query(`DELETE FROM vehicle_type WHERE ${w.sql} LIMIT 1`, w.params);
    removed += 1;
  }

  // 2. rows a test hard-deleted (the screen only soft-deletes, so this is belt and braces).
  for (const [k, row] of wantMap) {
    if (haveMap.has(k)) continue;
    const vals = rowValues(cols, row);
    await conn.query(
      `INSERT INTO vehicle_type (${cols.map((c) => `\`${c}\``).join(", ")}) VALUES (${vals.map(() => "?").join(", ")})`,
      vals,
    );
    created += 1;
  }

  // 3. rows that exist on both sides but were edited (name, fares, status, scope).
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
      `UPDATE vehicle_type SET ${setCols.map((c) => `\`${c}\` = ?`).join(", ")} WHERE ${w.sql} LIMIT 1`,
      [...params, ...w.params],
    );
    rewritten += 1;
  }

  const after = await allRows(cols);
  console.log(`restore: re-inserted ${created}, deleted ${removed}, rewrote ${rewritten}`);
  console.log(`live rows now: ${after.length} (snapshot held ${want.length})`);
} else {
  console.log("usage: b153.mjs probe | snapshot | fingerprint <name> | restore");
}

await conn.end();
