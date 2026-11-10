// Verification helpers for Delivery Runner → Banners (#sub-143), the third `:app` slice of
// the legacy `banners` table: Parcel Delivery (#sub-140) owns `eType='Deliver'`, Delivery
// Genie (#sub-142) the `eType='Genie'` rows and this screen the `eType='Runner'` ones.
//
// Unlike #sub-142, this slice is *not* a complete banner: the shipped Runner group (69)
// holds two language rows (LV, SL) and no English row at all, so the read matrix checks the
// label fallback and the write matrix checks the "add a missing language" fan-out — the
// only way a half-translated group can ever be finished from here.
//
// `snapshot`/`restore` cover the two delivery slices the tests can reach (Runner writes,
// Genie is read as the neighbour that must never change); `fingerprint` dumps the WHOLE
// table, so a stray write into a slice this screen does not own still shows in the diff.
//
//   node scripts/b143.mjs probe
//   node scripts/b143.mjs snapshot
//   node scripts/b143.mjs fingerprint <name>
//   node scripts/b143.mjs restore
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import mysql from "mysql2/promise";
import "dotenv/config";

const DUMP = path.resolve("..", ".lh", "b143-rows.json");
/** The slices a #sub-143 test may reach: its own, plus the genie group it must never touch. */
const SCOPE = "('Runner','Genie')";

const conn = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

/** Column names in DDL order, so a fingerprint is stable across runs. */
async function columns() {
  const [rows] = await conn.query("SHOW COLUMNS FROM banners");
  return rows.map((c) => c.Field);
}

async function scopedRows(cols) {
  const [rows] = await conn.query(
    `SELECT ${cols.map((c) => `\`${c}\``).join(", ")} FROM banners WHERE eType IN ${SCOPE}`,
  );
  return rows;
}

async function everyRow(cols) {
  const [rows] = await conn.query(`SELECT ${cols.map((c) => `\`${c}\``).join(", ")} FROM banners`);
  return rows;
}

function pad(n, w) {
  return String(n).padStart(w, "0");
}

/** driver Dates -> the literal MySQL wrote, so a restore round-trips exactly. */
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

/** One line per row, rows sorted: MyISAM has no clustered key, so a re-inserted row can
 * land somewhere else on disk without being a different banner. */
function canonical(cols, rows) {
  return rows
    .map((r) => cols.map((c) => `${c}=${String(norm(r[c]) ?? "<NULL>")}`).join("|"))
    .sort()
    .join("\n");
}

/** A row is identified by its own id plus the group and language it belongs to: what a
 * test can change (title, status, slot, colour, picture) is deliberately not in the key. */
function keyOf(row) {
  return `${row.iFaqcategoryId}|${row.iUniqueId}|${row.vCode}|${row.eType}`;
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

/** One banner group, aggregated the way the listing does. */
async function groupSummary(eType) {
  const [rows] = await conn.query(
    `SELECT iUniqueId AS id, COUNT(*) AS rows_n, COUNT(DISTINCT vCode) AS langs,
            COUNT(DISTINCT IF(vTitle <> '', vCode, NULL)) AS filled,
            SUM(eStatus = 'Active') AS active, MAX(iDisplayOrder) AS slot,
            MAX(vImage) AS image, MAX(vStatusBarColor) AS color, MAX(iLocationid) AS loc,
            MAX(iServiceId) AS service_id, MAX(eFor) AS e_for,
            MAX(eBuyAnyService) AS buy_any, MAX(iVehicleCategoryId) AS vcat,
            MAX(iMasterServiceCategoryId) AS mcat
       FROM banners WHERE eType = ? GROUP BY iUniqueId ORDER BY slot, id`,
    [eType],
  );
  return rows;
}

const cmd = process.argv[2];

if (cmd === "probe") {
  const cols = await columns();
  console.log("columns:", cols.join(", "));
  const [counts] = await conn.query(
    "SELECT COUNT(*) AS n, COUNT(DISTINCT iFaqcategoryId) AS d, COALESCE(MAX(iFaqcategoryId),0) AS max_row, COALESCE(MAX(iUniqueId),0) AS max_group FROM banners",
  );
  console.log(
    `table: ${counts[0].n} rows | distinct iFaqcategoryId: ${counts[0].d}` +
      ` | max iFaqcategoryId: ${counts[0].max_row} | max iUniqueId: ${counts[0].max_group}`,
  );
  const [census] = await conn.query(
    "SELECT eType, COUNT(*) AS rows_n, COUNT(DISTINCT iUniqueId) AS groups_n FROM banners GROUP BY eType ORDER BY eType",
  );
  console.table(census);
  for (const eType of ["Runner", "Genie", "Deliver"]) {
    console.log(`\n--- ${eType} groups (display order is allocated per slice) ---`);
    console.log((await groupSummary(eType)).map((r) => JSON.stringify(r)).join("\n"));
  }
  const [runnerRows] = await conn.query(
    "SELECT iFaqcategoryId AS row_id, vCode, vTitle, eStatus, vImage, iDisplayOrder, vStatusBarColor FROM banners WHERE eType = 'Runner' ORDER BY iFaqcategoryId",
  );
  console.log("\n--- runner language rows, verbatim ---");
  console.log(runnerRows.map((r) => JSON.stringify(r)).join("\n"));
  const [slots] = await conn.query(
    "SELECT eType, COALESCE(MAX(iDisplayOrder),0) + 1 AS next_slot FROM banners GROUP BY eType ORDER BY eType",
  );
  console.log("\nnext display slot per slice:", JSON.stringify(slots));
  const [images] = await conn.query(
    "SELECT vImage, COUNT(*) AS n, GROUP_CONCAT(DISTINCT eType) AS types FROM banners GROUP BY vImage HAVING n > 1 ORDER BY n DESC LIMIT 6",
  );
  console.log("reused images:", images.map((r) => `${r.vImage} x${r.n}`).join(", ") || "none");
  const [keys] = await conn.query(
    `SELECT id, permission_name, name, status, display_sub_group_id
       FROM admin_pro_permissions
      WHERE permission_name LIKE '%banner-%' ORDER BY display_sub_group_id, id`,
  );
  console.log("\nbanner permission keys:");
  console.log(keys.map((r) => JSON.stringify(r)).join("\n"));
  console.log(`\nscoped rows (Runner+Genie): ${(await scopedRows(cols)).length}`);
} else if (cmd === "snapshot") {
  const cols = await columns();
  const rows = (await scopedRows(cols)).map((r) =>
    Object.fromEntries(cols.map((c) => [c, norm(r[c])])),
  );
  writeFileSync(DUMP, JSON.stringify({ cols, rows }));
  console.log(`snapshot: ${rows.length} rows x ${cols.length} columns -> ${DUMP}`);
} else if (cmd === "fingerprint") {
  const name = process.argv[3] ?? "now";
  const cols = await columns();
  const rows = await everyRow(cols);
  writeFileSync(
    path.resolve("..", ".lh", `b143-${name}.txt`),
    `${canonical(cols, rows)}\n`,
  );
  console.log(`fingerprint ${name}: ${rows.length} rows (whole table)`);
} else if (cmd === "restore") {
  const cols = await columns();
  const dump = JSON.parse(readFileSync(DUMP, "utf8"));
  const want = dump.rows;
  const have = await scopedRows(cols);
  const wantMap = new Map(want.map((r) => [keyOf(r), r]));
  const haveMap = new Map(have.map((r) => [keyOf(r), r]));

  let created = 0;
  let removed = 0;
  let rewritten = 0;

  // 1. rows the tests added (a create inserts one per language under a fresh iUniqueId;
  // adding a missing language to the shipped group inserts one row at MAX+1).
  for (const [k, row] of haveMap) {
    if (wantMap.has(k)) continue;
    const w = whereAll(cols, row);
    await conn.query(`DELETE FROM banners WHERE ${w.sql} LIMIT 1`, w.params);
    removed += 1;
  }

  // 2. rows the tests deleted (a hard delete wipes the whole group — `eStatus` has no
  // 'Deleted' member to hide into).
  for (const [k, row] of wantMap) {
    if (haveMap.has(k)) continue;
    const vals = rowValues(cols, row);
    await conn.query(
      `INSERT INTO banners (${cols.map((c) => `\`${c}\``).join(", ")}) VALUES (${vals.map(() => "?").join(", ")})`,
      vals,
    );
    created += 1;
  }

  // 3. rows that exist on both sides but were edited (title, status, slot, colour, image).
  for (const [k, target] of wantMap) {
    const live = haveMap.get(k);
    if (!live || eq(cols, live, target)) continue;
    const targetValues = rowValues(cols, target);
    const setCols = cols.filter((c, i) => {
      if (["iFaqcategoryId", "iUniqueId", "vCode", "eType"].includes(c)) return false;
      return String(norm(live[c]) ?? "<NULL>") !== String(targetValues[i] ?? "<NULL>");
    });
    if (!setCols.length) continue;
    const idx = new Map(cols.map((c, i) => [c, i]));
    const params = setCols.map((c) => targetValues[idx.get(c)]);
    const w = whereAll(cols, live);
    await conn.query(
      `UPDATE banners SET ${setCols.map((c) => `\`${c}\` = ?`).join(", ")} WHERE ${w.sql} LIMIT 1`,
      [...params, ...w.params],
    );
    rewritten += 1;
  }

  const after = await everyRow(cols);
  console.log(`restore: re-inserted ${created}, deleted ${removed}, rewrote ${rewritten}`);
  console.log(`live rows now: ${after.length} (snapshot held ${want.length} across ${SCOPE})`);
} else {
  console.log("usage: b143.mjs probe | snapshot | fingerprint <name> | restore");
}

await conn.end();
