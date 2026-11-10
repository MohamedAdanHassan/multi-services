// Verification helpers for the Banners screen (#sub-140 parcel / #sub-142 genie), which
// both read and write the legacy `banners` table. The third slice, Delivery Runner
// (#sub-143, `eType='Runner'`), is covered by b143.mjs, whose snapshot is scoped to the
// runner and genie groups. Everything here is reversible: `snapshot` dumps every row,
// `fingerprint` writes a canonical text dump for before/after diffing and `restore` makes
// the live table byte-identical to the snapshot again (inserting what the tests deleted,
// deleting what they created, rewriting what they changed).
//
//   node scripts/b142.mjs probe
//   node scripts/b142.mjs snapshot
//   node scripts/b142.mjs fingerprint <name>
//   node scripts/b142.mjs restore
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import mysql from "mysql2/promise";
import "dotenv/config";

const DUMP = path.resolve("..", ".lh", "b142-rows.json");

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

async function allRows(cols) {
  const [rows] = await conn.query(`SELECT ${cols.map((c) => `\`${c}\``).join(", ")} FROM banners`);
  return rows;
}

function pad(n, w) {
  return String(n).padStart(w, "0");
}

/** driver Dates -> the literal MySQL wrote, so a restore round-trips exactly. */
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

const cmd = process.argv[2];

if (cmd === "probe") {
  const cols = await columns();
  console.log("columns:", cols.join(", "));
  const [counts] = await conn.query(
    "SELECT COUNT(*) AS n, COUNT(DISTINCT iFaqcategoryId) AS d FROM banners",
  );
  console.log("rows:", counts[0].n, "| distinct iFaqcategoryId:", counts[0].d);
  const [ids] = await conn.query(
    "SELECT COALESCE(MAX(iFaqcategoryId),0) AS max_row, COALESCE(MAX(iUniqueId),0) AS max_group FROM banners",
  );
  console.log("max iFaqcategoryId:", ids[0].max_row, "| max iUniqueId:", ids[0].max_group);
  const [byType] = await conn.query(
    "SELECT eType, COUNT(*) AS rows_n, COUNT(DISTINCT iUniqueId) AS groups_n FROM banners GROUP BY eType ORDER BY rows_n DESC",
  );
  console.table(byType);
  const [slices] = await conn.query(
    "SELECT eType, iUniqueId, MAX(iDisplayOrder) AS slot, MAX(vImage) AS image, MAX(eBuyAnyService) AS any_service, MAX(eFor) AS e_for, SUM(eStatus='Active') AS active, COUNT(*) AS n FROM banners WHERE eType IN ('Genie','Deliver') GROUP BY eType, iUniqueId ORDER BY eType, iUniqueId",
  );
  console.table(slices);
  const [titles] = await conn.query(
    "SELECT vCode, vTitle FROM banners WHERE eType = 'Genie' ORDER BY iFaqcategoryId",
  );
  console.log("genie titles:", JSON.stringify(titles));
  const [shared] = await conn.query(
    "SELECT vImage, COUNT(*) AS n FROM banners GROUP BY vImage HAVING n > 1 ORDER BY n DESC LIMIT 8",
  );
  console.log("reused images:", shared.map((r) => `${r.vImage} x${r.n}`).join(", ") || "none");
} else if (cmd === "snapshot") {
  const cols = await columns();
  const rows = (await allRows(cols)).map((r) => Object.fromEntries(cols.map((c, i) => [c, rowValues(cols, r)[i]])));
  writeFileSync(DUMP, JSON.stringify({ cols, rows }));
  console.log(`snapshot: ${rows.length} rows x ${cols.length} columns -> ${DUMP}`);
} else if (cmd === "fingerprint") {
  const name = process.argv[3] ?? "now";
  const cols = await columns();
  const rows = await allRows(cols);
  writeFileSync(
    path.resolve("..", ".lh", `b142-${name}.txt`),
    `${canonical(cols, rows)}\n`,
  );
  console.log(`fingerprint ${name}: ${rows.length} rows`);
} else if (cmd === "restore") {
  const cols = await columns();
  const dump = JSON.parse(readFileSync(DUMP, "utf8"));
  const want = dump.rows;
  const have = await allRows(cols);
  const wantMap = new Map(want.map((r) => [keyOf(r), r]));
  const haveMap = new Map(have.map((r) => [keyOf(r), r]));

  let created = 0;
  let removed = 0;
  let rewritten = 0;

  // 1. rows the tests added (a create inserts one per language under a fresh iUniqueId).
  for (const [k, row] of haveMap) {
    if (wantMap.has(k)) continue;
    const w = whereAll(cols, row);
    await conn.query(`DELETE FROM banners WHERE ${w.sql} LIMIT 1`, w.params);
    removed += 1;
  }

  // 2. rows the tests deleted (a hard delete wipes the whole group).
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
    const setCols = cols.filter((c, i) => {
      if (["iFaqcategoryId", "iUniqueId", "vCode", "eType"].includes(c)) return false;
      return String(norm(live[c]) ?? "<NULL>") !== String(rowValues(cols, target)[i] ?? "<NULL>");
    });
    if (!setCols.length) continue;
    const idx = new Map(cols.map((c, i) => [c, i]));
    const params = setCols.map((c) => rowValues(cols, target)[idx.get(c)]);
    const w = whereAll(cols, live);
    await conn.query(
      `UPDATE banners SET ${setCols.map((c) => `\`${c}\` = ?`).join(", ")} WHERE ${w.sql} LIMIT 1`,
      [...params, ...w.params],
    );
    rewritten += 1;
  }

  const after = await allRows(cols);
  console.log(`restore: re-inserted ${created}, deleted ${removed}, rewrote ${rewritten}`);
  console.log(`live rows now: ${after.length} (snapshot held ${want.length})`);
} else {
  console.log("usage: b142.mjs probe | snapshot | fingerprint <name> | restore");
}

await conn.end();
