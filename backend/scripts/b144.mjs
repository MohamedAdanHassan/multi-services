// Verification helpers for "Manage Service/Content" — Delivery Genie (group 33 → #sub-141)
// and its Delivery Runner twin (group 34 → #sub-144). Both screens edit ONE row of the legacy
// `vehicle_category` table each: the app's root category (`iParentId = 0 AND eCatType = 'Genie'`
// → row 280, `… = 'Runner'` → row 287), so this script pins exactly those two rows and nothing
// else in the 291-row table.
//
// Two rows are snapshotted rather than one because the screen's own exclusivity rule reaches
// across the table: turning the promote banner on for one service switches it off for every
// other row that held it (`vehicle_category_action.php:905`), so a test that promotes the Runner
// row silently rewrites the Genie row too. The promoted SET is therefore fingerprinted and
// restored alongside the rows.
//
// Nothing here deletes or inserts: the screen has no create and no delete route, the legacy app
// seeds the root rows, and `restore` is a column-by-column UPDATE of the two pinned ids.
//
//   node scripts/b144.mjs probe
//   node scripts/b144.mjs snapshot
//   node scripts/b144.mjs fingerprint <name>
//   node scripts/b144.mjs restore
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import mysql from "mysql2/promise";
import "dotenv/config";

const DUMP = path.resolve("..", ".lh", "b144-rows.json");
const TABLE = "vehicle_category";
const ID = "iVehicleCategoryId";
/** The two rows this screen pair owns, in menu order: Genie first, then Runner. */
const ROOT_IDS = [280, 287];
/** Where the legacy panel filed a row's own artwork, and the home-page artwork flat. */
const LEGACY_SITE = process.env.LEGACY_SITE_ROOT || "/var/www/ataa";

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

async function rowsByIds(cols, ids) {
  const [rows] = await conn.query(
    `SELECT ${cols.map((c) => `\`${c}\``).join(", ")} FROM ${TABLE}
      WHERE ${ID} IN (${ids.map(() => "?").join(", ")}) ORDER BY ${ID}`,
    ids,
  );
  return rows;
}

/** Rows that currently hold the promotion the banner toggle would take. */
async function promotedIds() {
  const [rows] = await conn.query(
    `SELECT ${ID} AS id FROM ${TABLE} WHERE ePromoteBanner = 'Yes' ORDER BY ${ID}`,
  );
  return rows.map((r) => Number(r.id));
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

/**
 * One line per row, rows sorted by id, then the promoted set on its own line: the set is
 * part of the state this screen moves, so it belongs in the fingerprint rather than being
 * trusted to stay put.
 */
function canonical(cols, rows, promoted) {
  const body = rows
    .map((r) => cols.map((c) => `${c}=${String(norm(r[c]) ?? "<NULL>")}`).join("|"))
    .sort()
    .join("\n");
  return `${body}\n__promoted__=${promoted.join(",") || "-"}`;
}

function eq(cols, a, b) {
  const va = rowValues(cols, a);
  const vb = rowValues(cols, b);
  return va.every((v, i) => String(v ?? "<NULL>") === String(vb[i] ?? "<NULL>"));
}

/** Write back the columns that differ, keeping the id itself out of the SET. */
async function restoreRow(cols, live, target) {
  const setCols = cols.filter(
    (c) =>
      c !== ID &&
      String(norm(live[c]) ?? "<NULL>") !== String(norm(target[c]) ?? "<NULL>"),
  );
  if (!setCols.length) return 0;
  await conn.query(
    `UPDATE ${TABLE} SET ${setCols.map((c) => `\`${c}\` = ?`).join(", ")}
      WHERE ${ID} = ? LIMIT 1`,
    [...setCols.map((c) => norm(target[c])), live[ID]],
  );
  return setCols.length;
}

const cmd = process.argv[2];

if (cmd === "probe") {
  const cols = await columns();
  console.log("columns:", cols.length);
  const rows = await rowsByIds(cols, ROOT_IDS);
  for (const r of rows) {
    const names = cols.filter((c) => c.startsWith("vCategory_"));
    const filled = names.filter((c) => String(r[c] ?? "").trim());
    console.log(
      `#${r[ID]} eCatType=${r.eCatType} iParentId=${r.iParentId} eStatus=${r.eStatus} eFor="${r.eFor}" ` +
        `order=${r.iDisplayOrder} homeOrder=${r.iDisplayOrderHomepage} otp="${r.eOTPCodeEnable}" ` +
        `promote=${r.ePromoteBanner} | names ${filled.length}/${names.length} ` +
        `EN=${JSON.stringify(r.vCategory_EN)}`,
    );
    for (const c of ["vListLogo3", "vPromoteBannerImage", "vHomepageFullLogo", "vHomepageLogoOurServices"]) {
      const v = String(r[c] ?? "");
      console.log(`    ${c}=${JSON.stringify(v)}`);
    }
    for (const c of ["tPromoteBannerTitle", "vServiceCatTitleHomepage"]) {
      let parsed = null;
      try {
        parsed = JSON.parse(String(r[c] ?? ""));
      } catch {
        parsed = null;
      }
      if (!parsed || typeof parsed !== "object") {
        console.log(`    ${c}: not JSON — ${JSON.stringify(String(r[c] ?? "").slice(0, 40))}`);
        continue;
      }
      const keys = Object.keys(parsed);
      const blank = keys.filter((k) => !String(parsed[k] ?? "").trim()).length;
      const bases = [...new Set(keys.map((k) => k.slice(0, k.lastIndexOf("_"))))].sort();
      console.log(
        `    ${c}: ${keys.length} keys, ${blank} blank, bases [${bases.join(", ")}]`,
      );
    }
  }
  // Where the bytes of a stored file name actually live, since a panel that cannot show the
  // row's icon is a broken screen no matrix of statuses would catch.
  const artwork = [];
  for (const r of rows) {
    for (const [col, dir] of [
      ["vListLogo3", path.join(LEGACY_SITE, "webimages", "icons", "VehicleCategory", String(r[ID]))],
      ["vHomepageLogoOurServices", path.join(LEGACY_SITE, "assets", "img", "home-new", "services")],
    ]) {
      const name = String(r[col] ?? "").trim();
      if (name) artwork.push(`${ID} ${r[ID]} ${col} ${name} -> ${existsSync(path.join(dir, name)) ? "found" : "MISSING"} in ${dir}`);
    }
  }
  console.log("artwork:");
  console.log(artwork.join("\n"));
  const [roots] = await conn.query(
    `SELECT eCatType, COUNT(*) AS n FROM ${TABLE}
      WHERE iParentId = 0 AND eStatus <> 'Deleted' AND eCatType IN ('Genie','Runner')
      GROUP BY eCatType`,
  );
  console.log("live root rows per eCatType:", JSON.stringify(roots));
  console.log("promoted rows:", JSON.stringify(await promotedIds()));
  const [keys] = await conn.query(
    `SELECT id, permission_name, status, display_group_id, display_sub_group_id
       FROM admin_pro_permissions
      WHERE display_sub_group_id IN (141, 144) ORDER BY display_sub_group_id, id`,
  );
  console.log("permission keys of the two sub-groups:");
  console.log(keys.map((r) => JSON.stringify(r)).join("\n"));
} else if (cmd === "snapshot") {
  const cols = await columns();
  const rows = (await rowsByIds(cols, ROOT_IDS)).map((r) =>
    Object.fromEntries(cols.map((c) => [c, norm(r[c])])),
  );
  const promoted = await promotedIds();
  writeFileSync(DUMP, JSON.stringify({ cols, rows, promoted }));
  console.log(`snapshot: ${rows.length} rows x ${cols.length} columns + ${promoted.length} promoted -> ${DUMP}`);
} else if (cmd === "fingerprint") {
  const name = process.argv[3] ?? "now";
  const cols = await columns();
  const rows = await rowsByIds(cols, ROOT_IDS);
  const promoted = await promotedIds();
  writeFileSync(path.resolve("..", ".lh", `b144-${name}.txt`), `${canonical(cols, rows, promoted)}\n`);
  console.log(`fingerprint ${name}: ${rows.length} rows, promoted [${promoted.join(", ")}]`);
} else if (cmd === "restore") {
  // `eOTPCodeEnable` is stored as the enum's out-of-range member 0, which reads back as ''
  // and cannot be written under STRICT_TRANS_TABLES — the same reason the screen refuses to
  // save it. This connection relaxes its own session mode for the rollback and nothing else;
  // the server's global mode is not touched, and the connection closes at the end.
  const [mode] = await conn.query("SELECT @@SESSION.sql_mode AS m");
  console.log(`restore session: sql_mode was ${JSON.stringify(mode[0].m)}`);
  await conn.query("SET SESSION sql_mode = 'NO_ENGINE_SUBSTITUTION'");
  const cols = await columns();
  const dump = JSON.parse(readFileSync(DUMP, "utf8"));
  const live = await rowsByIds(cols, ROOT_IDS);
  const liveMap = new Map(live.map((r) => [Number(r[ID]), r]));

  let rewrote = 0;
  let touched = 0;
  for (const target of dump.rows) {
    const current = liveMap.get(Number(target[ID]));
    if (!current) {
      console.error(`MISSING ROW #${target[ID]} — this screen never deletes, so the table is wrong.`);
      process.exitCode = 1;
      continue;
    }
    const n = await restoreRow(cols, current, target);
    if (n) {
      rewrote += 1;
      touched += n;
    }
  }

  // The promotion the toggle moves sits outside the two pinned rows: re-apply the snapshot's
  // set and take the flag off anything a test promoted that the snapshot did not hold.
  const want = new Set(dump.promoted.map(Number));
  const have = new Set(await promotedIds());
  let promoted = 0;
  for (const id of want) {
    if (have.has(id) || ROOT_IDS.includes(id)) continue;
    await conn.query(`UPDATE ${TABLE} SET ePromoteBanner = 'Yes' WHERE ${ID} = ? LIMIT 1`, [id]);
    promoted += 1;
  }
  for (const id of have) {
    if (want.has(id)) continue;
    await conn.query(`UPDATE ${TABLE} SET ePromoteBanner = 'No' WHERE ${ID} = ? LIMIT 1`, [id]);
    promoted += 1;
  }

  console.log(`restore: rewrote ${rewrote} row(s) across ${touched} column(s), fixed ${promoted} promotion(s)`);
  console.log(`promoted now: [${(await promotedIds()).join(", ")}] (snapshot held [${dump.promoted.join(", ")}])`);
} else {
  console.log("usage: b144.mjs probe | snapshot | fingerprint <name> | restore");
}

await conn.end();
