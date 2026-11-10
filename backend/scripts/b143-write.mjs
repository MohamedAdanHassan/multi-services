// Write matrix for Delivery Runner → Banners (#sub-143), the third `:app` slice of the
// legacy `banners` table. Everything it creates it deletes again, everything it edits on
// the shipped group (69) it puts back, and `node scripts/b143.mjs restore` cleans up
// whatever a failed assertion leaves behind — a delete here is a real DELETE of the whole
// group, so an unrestored 69 means the Runner app has no banner at all.
//
// The two cases this screen exists for are the ones #sub-140 / #sub-142 could never
// exercise: a group with no English row (so the title falls back to Latvian everywhere,
// including the phrase the delete confirmation asks for back) and a save that adds a
// language the group never had.
//
//   node scripts/b143-write.mjs
import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import mysql from "mysql2/promise";
import "dotenv/config";

const API = process.env.B143_API ?? "http://localhost:4000/api";
const UPLOADS = path.resolve("uploads", "Banners");
const EMAIL = "admin.test@ondemand.local";
const PASSWORD = "TestPass123!";

/** The one shipped Runner group, read before anything is written so every edit below
 * can be undone from the values it actually held rather than from what the copy claims. */
const GROUP = 69;
const LV = "Piegādes skrējējs";
const SL = "Dostavni tekač";
const SHIPPED_IMAGE = "20230113155822173.png";

// Two distinct 1x1 PNGs, so a replace can be told apart from the original.
const PNG_A = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_B = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

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
  ok(label, String(actual) === String(want), `got ${JSON.stringify(actual)}, want ${JSON.stringify(want)}`);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

let cookie = "";

async function call(method, pathname, body, opts = {}) {
  const headers = { "X-Requested-With": "XMLHttpRequest" };
  if (cookie) headers.cookie = cookie;
  let payload;
  if (opts.form) {
    payload = opts.form;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${API}${pathname}`, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json, text };
}

const get = (p) => call("GET", p);
const post = (p, b) => call("POST", p, b);
const put = (p, b) => call("PUT", p, b);
const patch = (p, b) => call("PATCH", p, b);
const del = (p, b) => call("DELETE", p, b);

/** Raw bytes of a media response, so a served picture can be compared byte for byte. */
async function bytes(p) {
  const res = await fetch(`${API}${p}`, {
    headers: { "X-Requested-With": "XMLHttpRequest", cookie },
  });
  return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
}

function message(res) {
  return res.json?.error?.message ?? JSON.stringify(res.json ?? "").slice(0, 120);
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

async function upload(id, data, filename, app = "runner") {
  const form = new FormData();
  form.append("file", new Blob([data], { type: "image/png" }), filename);
  return call("POST", `/banner/${app}/${id}/image`, undefined, { form });
}

// ---------------------------------------------------------------------------
// SQL helpers — every one of them names eType, so a check can never be fooled by
// another app's rows: 'Runner' is this screen's slice, 'Genie' the neighbour.
// ---------------------------------------------------------------------------

async function one(sql, params) {
  const [rows] = await db.query(sql, params);
  return rows[0];
}

async function groupRows(uid, eType = "Runner") {
  const [rows] = await db.query(
    "SELECT * FROM banners WHERE iUniqueId = ? AND eType = ? ORDER BY iFaqcategoryId",
    [uid, eType],
  );
  return rows;
}

async function distinct(uid, column, eType = "Runner") {
  const [rows] = await db.query(
    `SELECT DISTINCT \`${column}\` AS v FROM banners WHERE iUniqueId = ? AND eType = ?`,
    [uid, eType],
  );
  return rows.map((r) => r.v);
}

async function titleOf(uid, code, eType = "Runner") {
  const [rows] = await db.query(
    "SELECT vTitle FROM banners WHERE iUniqueId = ? AND eType = ? AND vCode = ? ORDER BY iFaqcategoryId LIMIT 1",
    [uid, eType, code],
  );
  return rows.length ? rows[0].vTitle : null;
}

const files = () => readdirSync(UPLOADS).filter((f) => !f.startsWith("."));

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
const marker = `ZZ b143 ${Date.now() % 100000}`;

const before = await one("SELECT COUNT(*) AS n, COALESCE(MAX(iFaqcategoryId),0) AS max_row, COALESCE(MAX(iUniqueId),0) AS max_group FROM banners", []);
// mysql2 hands BIGINT aggregates back as strings, and a "991" + 1 is "9911".
before.n = Number(before.n);
before.max_row = Number(before.max_row);
before.max_group = Number(before.max_group);
const shipped = await groupRows(GROUP);
const auditMark = Number((await one("SELECT COALESCE(MAX(id),0) AS id FROM admin_audit_log", [])).id);
ok("the shipped runner group is the two rows the copy says", shipped.length === 2, `${shipped.length} rows`);
eq("the Latvian row holds its stored text", shipped[0]?.vTitle, LV);
eq("the Slovenian row holds its stored text", shipped[1]?.vTitle, SL);
eq("neither row is English", shipped.some((r) => r.vCode === "EN"), false);
console.log(
  `  ·  baseline: ${before.n} rows, max iFaqcategoryId ${before.max_row}, ` +
    `max iUniqueId ${before.max_group}, uploads ${JSON.stringify(files())}`,
);

console.log("\n--- create refuses a payload the legacy form would have rejected ---");
{
  const noEn = await post("/banner/runner", { texts: { LV: "bez angļu valodas" } });
  eq("POST without an English title -> 400", noEn.status, 400);
  ok("and says so in words", message(noEn).includes("English"), message(noEn));
  const badLang = await post("/banner/runner", { texts: { EN: "ok", XX: "nonsense" } });
  eq("POST with an unknown language code -> 400", badLang.status, 400);
  const tooLong = await post("/banner/runner", { texts: { EN: "x".repeat(101) } });
  eq("POST with a 101-character title -> 400", tooLong.status, 400);
  const badColor = await post("/banner/runner", { texts: { EN: "ok" }, statusBarColor: "red" });
  eq("POST with a non-hex status-bar colour -> 400", badColor.status, 400);
  const strays = await one("SELECT COUNT(*) AS n FROM banners WHERE vTitle LIKE 'ZZ b143 %'", []);
  eq("nothing was inserted by the rejected creates", strays.n, 0);
  const table = await one("SELECT COUNT(*) AS n FROM banners", []);
  eq("and the table still holds its shipped 993 rows", table.n, before.n);
}

console.log("\n--- create writes one row per language inside the runner slice ---");
let uid = 0;
{
  const created = await post("/banner/runner", {
    texts: { EN: marker, RU: "Тест раннера" },
    status: "Active",
  });
  eq("POST /banner/runner -> 201", created.status, 201);
  uid = created.json?.item?.id ?? 0;
  ok("the new banner has a group id", uid > 0, `id ${uid}`);
  eq("the add form pre-filled slot 3 (runner max + 1)", created.json?.item?.displayOrder, 3);
  eq("26 language rows answered", created.json?.item?.rowCount, 26);

  const rows = await groupRows(uid);
  eq("the table holds 26 rows for the group", rows.length, 26);
  eq("every row is eType='Runner'", (await distinct(uid, "eType")).join(), "Runner");
  eq("the English title landed", rows.find((r) => r.vCode === "EN")?.vTitle, marker);
  eq("untouched languages are stored blank", rows.filter((r) => r.vTitle === "").length, 24);
  eq("one shared status", (await distinct(uid, "eStatus")).join(), "Active");
  eq("one shared slot", (await distinct(uid, "iDisplayOrder")).join(), "3");
  eq("shown everywhere", (await distinct(uid, "iLocationid")).join(), "-1");
  eq("the picture starts empty", (await distinct(uid, "vImage")).join(), "");
  eq("eFor matches the shipped rows", (await distinct(uid, "eFor")).join(), "General");
  eq("the group id is the table-wide max + 1", uid, before.max_group + 1);

  const list = await get("/banner/runner/list");
  eq("the runner list now shows 2 groups", list.json?.total, 2);
  eq("the shipped group still leads it (slot 2 before 3)", list.json?.items?.[0]?.id, GROUP);
  eq("the genie slice is untouched", (await get("/banner/genie/list")).json?.total, 1);
  eq("the parcel slice is untouched", (await get("/banner/delivery/list")).json?.total, 2);
  const slot = await one("SELECT MAX(iDisplayOrder) AS m FROM banners WHERE eType = 'Genie'", []);
  eq("and its own max slot is still 3, not the runner's", slot.m, 3);
}

console.log("\n--- the other slices cannot read or rewrite this group, nor it them ---");
{
  eq("GET /banner/genie/<uid> -> 404", (await get(`/banner/genie/${uid}`)).status, 404);
  eq("PUT /banner/genie/<uid> -> 404", (await put(`/banner/genie/${uid}`, { texts: { EN: "hijack" } })).status, 404);
  eq("PATCH /banner/delivery/<uid>/status -> 404", (await patch(`/banner/delivery/${uid}/status`, { status: "Inactive" })).status, 404);
  eq("DELETE /banner/delivery/<uid> -> 404", (await del(`/banner/delivery/${uid}`, { confirm: marker })).status, 404);
  eq("GET /banner/runner/68 (genie's group) -> 404", (await get("/banner/runner/68")).status, 404);
  eq("PUT /banner/runner/68 -> 404", (await put("/banner/runner/68", { texts: { EN: "hijack" } })).status, 404);
  eq("PATCH /banner/runner/50/status -> 404", (await patch("/banner/runner/50/status", { status: "Inactive" })).status, 404);
  eq("DELETE /banner/runner/70 -> 404", (await del("/banner/runner/70", { confirm: "x" })).status, 404);
  eq("the new group survived the cross-slice attempts", (await groupRows(uid)).length, 26);
  eq("and stayed Active", (await distinct(uid, "eStatus")).join(), "Active");
  eq("genie 68 kept all 26 titles", (await distinct(68, "vCode", "Genie")).length, 26);
  eq("parcel 50 kept its colour", (await distinct(50, "vStatusBarColor", "Deliver")).join(), "#F09008");
  eq("unknown app on a write path -> 400", (await post("/banner/store", { texts: { EN: "x" } })).status, 400);
}

console.log("\n--- edit fans out per language, slot and colour ---");
{
  const edited = await put(`/banner/runner/${uid}`, { texts: { FR: "Test coursier" } });
  eq("PUT one language -> 200", edited.status, 200);
  eq("the French row changed", await titleOf(uid, "FR"), "Test coursier");
  eq("the English row did not", await titleOf(uid, "EN"), marker);
  eq("still 26 rows", (await groupRows(uid)).length, 26);

  const both = await put(`/banner/runner/${uid}`, { displayOrder: 9, statusBarColor: "#112233" });
  eq("PUT slot + colour -> 200", both.status, 200);
  eq("the slot is shared by the group", (await distinct(uid, "iDisplayOrder")).join(), "9");
  eq("the colour is shared by the group", (await distinct(uid, "vStatusBarColor")).join(), "#112233");

  const empty = await put(`/banner/runner/${uid}`, {});
  eq("PUT with nothing to change -> 400", empty.status, 400);
  const badSlot = await put(`/banner/runner/${uid}`, { displayOrder: 99999 });
  eq("PUT a slot above 9999 -> 400", badSlot.status, 400);
  eq("the refused saves changed no row", (await distinct(uid, "iDisplayOrder")).join(), "9");
}

console.log("\n--- status is atomic over the group and idempotent ---");
{
  const off = await patch(`/banner/runner/${uid}/status`, { status: "Inactive" });
  eq("PATCH Inactive -> 200", off.status, 200);
  eq("every row is Inactive", (await distinct(uid, "eStatus")).join(), "Inactive");
  const again = await patch(`/banner/runner/${uid}/status`, { status: "Inactive" });
  eq("PATCH the same status again -> 200", again.status, 200);
  eq("and the group is still Inactive", (await distinct(uid, "eStatus")).join(), "Inactive");
  const bogus = await patch(`/banner/runner/${uid}/status`, { status: "Deleted" });
  eq("PATCH a status the enum has not -> 400", bogus.status, 400);
  const on = await patch(`/banner/runner/${uid}/status`, { status: "Active" });
  eq("PATCH back to Active -> 200", on.status, 200);
  eq("every row is Active again", (await distinct(uid, "eStatus")).join(), "Active");
  const inactive = await get("/banner/runner/list?status=Inactive");
  eq("the Inactive filter now finds nothing", inactive.json?.total, 0);
  const search = await get(`/banner/runner/list?search=${encodeURIComponent(marker)}`);
  eq("the search filter finds this banner", search.json?.total, 1);
  const genieInactive = await get("/banner/genie/list?status=Active");
  eq("the genie slice still lists its own group", genieInactive.json?.total, 1);
}

console.log("\n--- the picture: attach, replace, refuse, and the wrong slice ---");
{
  const fileCount = files().length;
  const first = await upload(uid, PNG_A, "b143-a.png");
  eq("POST image -> 200", first.status, 200);
  const image = first.json?.item?.image ?? "";
  ok("the group got a file name", image.endsWith(".png"), image);
  eq("every row of the group names it", (await distinct(uid, "vImage")).join(), image);
  ok("the file is on disk", existsSync(path.join(UPLOADS, image)));

  const served = await bytes(`/banner/runner/${uid}/image`);
  eq("GET image returns the bytes", served.body.compare(PNG_A), 0);

  const second = await upload(uid, PNG_B, "b143-b.png");
  eq("replace the picture -> 200", second.status, 200);
  const next = second.json?.item?.image ?? "";
  ok("a second file name was written", next !== image, next);
  eq("the orphaned first file was removed", files().length, fileCount + 1);

  const wrongApp = await upload(68, PNG_A, "b143-no.png");
  eq("uploading into genie's group through the runner slice -> 404", wrongApp.status, 404);
  eq("and it left no orphan behind", files().length, fileCount + 1);
  eq("genie 68 still names its shipped artwork", (await distinct(68, "vImage", "Genie")).join(), "20230113155737103.png");

  const txt = new FormData();
  txt.append("file", new Blob([Buffer.from("not an image")], { type: "text/plain" }), "b143.txt");
  const rejected = await call("POST", `/banner/runner/${uid}/image`, undefined, { form: txt });
  eq("a non-image upload -> 400", rejected.status, 400);
  eq("the rejected upload wrote no file", files().length, fileCount + 1);
  rmSync(path.join(UPLOADS, next), { force: true });
  eq("the created group's picture is cleared for the delete case", (await upload(uid, PNG_A, "b143-c.png")).status, 200);
}

console.log("\n--- delete is name-confirmed and wipes the group ---");
{
  const detail = await get(`/banner/runner/${uid}`);
  eq("the group is titled by its English row", detail.json?.item?.title, marker);
  const blank = await del(`/banner/runner/${uid}`, { confirm: "" });
  eq("DELETE with a blank confirm -> 400", blank.status, 400);
  const wrong = await del(`/banner/runner/${uid}`, { confirm: SL });
  eq("DELETE with another language's title -> 400", wrong.status, 400);
  ok("and it asks for the exact title", message(wrong).includes(marker), message(wrong));
  const missing = await del("/banner/runner/999999", { confirm: "x" });
  eq("DELETE an unknown id -> 404", missing.status, 404);

  const attached = (await get(`/banner/runner/${uid}`)).json?.item?.image ?? "";
  const gone = await del(`/banner/runner/${uid}`, { confirm: marker });
  eq("DELETE with the right name -> 200", gone.status, 200);
  eq("it removed all 26 rows", gone.json?.rowsRemoved, 26);
  eq("the group is gone from the table", (await groupRows(uid)).length, 0);
  eq("the picture nothing points at was deleted", files().includes(attached), false);
  eq("the runner list is back to 1 group", (await get("/banner/runner/list")).json?.total, 1);
  eq("GET the deleted banner -> 404", (await get(`/banner/runner/${uid}`)).status, 404);
  const size = await one("SELECT COUNT(*) AS n FROM banners", []);
  eq("the table is back to its shipped row count", size.n, before.n);
}

console.log("\n--- the shipped group: a save ADDS the languages it never had ---");
{
  const added = await put(`/banner/runner/${GROUP}`, { texts: { EN: "Runner test title" } });
  eq("PUT a language the group has no row for -> 200", added.status, 200);
  eq("the group now holds 3 rows", (await groupRows(GROUP)).length, 3);
  eq("the English row was inserted with the group's text", await titleOf(GROUP, "EN"), "Runner test title");
  eq("the new row copied the shipped picture", (await distinct(GROUP, "vImage")).join(), SHIPPED_IMAGE);
  eq("and the shipped slot", (await distinct(GROUP, "iDisplayOrder")).join(), "2");
  eq("the Latvian row is untouched", await titleOf(GROUP, "LV"), LV);
  eq("the Slovenian row is untouched", await titleOf(GROUP, "SL"), SL);
  eq("the detail view counts 3 languages", added.json?.item?.languageCount, 3);
  eq("and 3 of 26 languages titled", added.json?.item?.translationsFilled, 3);
  const list = await get("/banner/runner/list");
  eq("the list now says 3 languages", list.json?.items?.[0]?.languageCount, 3);
  eq("and still labels the group by its English row", list.json?.items?.[0]?.title, "Runner test title");

  // The API has no "remove one language" verb, so the harness undoes its own insert —
  // exactly what `node scripts/b143.mjs restore` would have done.
  const undone = await db.query(
    "DELETE FROM banners WHERE eType = 'Runner' AND iUniqueId = ? AND vCode = 'EN'",
    [GROUP],
  );
  eq("the harness removed the row it added", undone[0].affectedRows, 1);
  eq("the group is back to its shipped 2 rows", (await groupRows(GROUP)).length, 2);
  eq("and the ids it holds are the shipped ones", (await groupRows(GROUP)).map((r) => r.iFaqcategoryId).join(), "1766,1780");
}

console.log("\n--- the shipped group: label fallback, fan-out, status, picture ---");
{
  const detail = await get(`/banner/runner/${GROUP}`);
  eq("with no English row the title is the Latvian one", detail.json?.item?.title, LV);
  const renamed = await put(`/banner/runner/${GROUP}`, { texts: { LV: "Temp runner LV" } });
  eq("PUT the Latvian title -> 200", renamed.status, 200);
  eq("the row holds it", await titleOf(GROUP, "LV"), "Temp runner LV");
  eq("the Slovenian row is not rewritten", await titleOf(GROUP, "SL"), SL);
  const back = await put(`/banner/runner/${GROUP}`, { texts: { LV } });
  eq("PUT the original title back -> 200", back.status, 200);
  eq("the row holds it again", await titleOf(GROUP, "LV"), LV);

  const styled = await put(`/banner/runner/${GROUP}`, { displayOrder: 7, statusBarColor: "#0A0B0C" });
  eq("PUT slot + colour -> 200", styled.status, 200);
  eq("both rows share the slot", (await distinct(GROUP, "iDisplayOrder")).join(), "7");
  eq("both rows share the colour", (await distinct(GROUP, "vStatusBarColor")).join(), "#0A0B0C");
  eq("the genie group kept its own slot", (await distinct(68, "iDisplayOrder", "Genie")).join(), "3");
  const reset = await put(`/banner/runner/${GROUP}`, { displayOrder: 2, statusBarColor: "" });
  eq("PUT the shipped slot and blank colour back -> 200", reset.status, 200);
  eq("the slot is 2 again", (await distinct(GROUP, "iDisplayOrder")).join(), "2");
  eq("the colour is blank again", (await distinct(GROUP, "vStatusBarColor")).join(), "");

  const off = await patch(`/banner/runner/${GROUP}/status`, { status: "Inactive" });
  eq("PATCH the shipped group Inactive -> 200", off.status, 200);
  eq("both rows went Inactive", (await distinct(GROUP, "eStatus")).join(), "Inactive");
  eq("the list labels it Inactive", (await get("/banner/runner/list")).json?.items?.[0]?.status, "Inactive");
  eq("the Inactive filter finds it", (await get("/banner/runner/list?status=Inactive")).json?.total, 1);
  const on = await patch(`/banner/runner/${GROUP}/status`, { status: "Active" });
  eq("PATCH it back -> 200", on.status, 200);
  eq("both rows are Active again", (await distinct(GROUP, "eStatus")).join(), "Active");

  const shippedBytes = await bytes(`/banner/runner/${GROUP}/image`);
  eq("the shipped artwork is served", shippedBytes.status, 200);
  ok("and it is a real image", shippedBytes.body.length > 100, `${shippedBytes.body.length} bytes`);

  const fileCount = files().length;
  const swapped = await upload(GROUP, PNG_A, "b143-runner.png");
  eq("replace the shipped picture -> 200", swapped.status, 200);
  const uploaded = swapped.json?.item?.image ?? "";
  eq("both rows name the new file", (await distinct(GROUP, "vImage")).join(), uploaded);
  const refs = await one("SELECT COUNT(*) AS n FROM banners WHERE vImage = ?", [SHIPPED_IMAGE]);
  eq("no row anywhere still names the shipped file", Number(refs.n), 0);
  ok("the read-only legacy artwork file survived the replace", existsSync(`/var/www/ataa/assets/img/images/${SHIPPED_IMAGE}`), SHIPPED_IMAGE);
  eq("the upload folder holds nothing but the new file", files().length, fileCount + 1);

  await db.query("UPDATE banners SET vImage = ? WHERE eType = 'Runner' AND iUniqueId = ?", [SHIPPED_IMAGE, GROUP]);
  rmSync(path.join(UPLOADS, uploaded), { force: true });
  eq("the harness put the shipped file name back", (await distinct(GROUP, "vImage")).join(), SHIPPED_IMAGE);
  eq("and removed its own upload", files().length, fileCount);
}

console.log("\n--- the shipped group really deletes, and really comes back ---");
{
  const wrong = await del(`/banner/runner/${GROUP}`, { confirm: SL });
  eq("DELETE with the Slovenian title -> 400", wrong.status, 400);
  ok("and it asks for the fallback title it is labelled by", message(wrong).includes(LV), message(wrong));
  const gone = await del(`/banner/runner/${GROUP}`, { confirm: LV });
  eq("DELETE with “Piegādes skrējējs” -> 200", gone.status, 200);
  eq("it removed both language rows", gone.json?.rowsRemoved, 2);
  eq("the runner slice is empty now", (await get("/banner/runner/list")).json?.total, 0);
  eq("and the group is gone from the table", (await groupRows(GROUP)).length, 0);

  // Re-insert the two rows exactly as they were read at the start of this run: the same
  // ids, the same text, the same picture — the undo `b143.mjs restore` also performs.
  const cols = Object.keys(shipped[0]);
  for (const row of shipped) {
    const names = cols.map((c) => `\`${c}\``).join(", ");
    await db.query(
      `INSERT INTO banners (${names}) VALUES (${cols.map(() => "?").join(", ")})`,
      cols.map((c) => row[c]),
    );
  }
  const restored = await groupRows(GROUP);
  eq("the group is back with its 2 rows", restored.length, 2);
  eq("under the same row ids", restored.map((r) => r.iFaqcategoryId).join(), "1766,1780");
  eq("with the same titles", restored.map((r) => r.vTitle).join("|"), `${LV}|${SL}`);
  eq("with the same picture", (await distinct(GROUP, "vImage")).join(), SHIPPED_IMAGE);
  eq("the runner list shows it again", (await get("/banner/runner/list")).json?.total, 1);
}

console.log("\n--- every runner mutation left an audit trail ---");
{
  for (const event of [
    "banner_created",
    "banner_updated",
    "banner_status_changed",
    "banner_image_uploaded",
    "banner_deleted",
  ]) {
    ok(`audit event ${event}`, await sawAudit(event, auditMark));
  }
}

console.log("\n--- the table is where it started ---");
{
  const after = await one("SELECT COUNT(*) AS n, COALESCE(MAX(iFaqcategoryId),0) AS max_row, COALESCE(MAX(iUniqueId),0) AS max_group FROM banners", []);
  eq("the row count is back to the shipped total", after.n, before.n);
  eq("the highest iFaqcategoryId is unchanged", after.max_row, before.max_row);
  eq("the highest iUniqueId is unchanged", after.max_group, before.max_group);
  const other = await one(
    "SELECT COUNT(*) AS n FROM banners WHERE eType NOT IN ('Runner','Genie') AND vTitle LIKE '%hijack%'",
    [],
  );
  eq("no other slice caught a test title", other.n, 0);
  eq("the runner slice lists one group again", (await get("/banner/runner/list")).json?.total, 1);
  eq("the genie slice lists one group", (await get("/banner/genie/list")).json?.total, 1);
  eq("the parcel slice lists two", (await get("/banner/delivery/list")).json?.total, 2);
  console.log(`upload leftovers in ${UPLOADS}: ${JSON.stringify(files())}`);
}

console.log(`\nb143-write: ${pass} ok, ${failures.length} failed`);
if (failures.length) console.log(failures.map((f) => ` - ${f}`).join("\n"));
if (failures.length) console.log("run `node scripts/b143.mjs restore` to roll the table back to the snapshot.");

await db.end();
process.exit(failures.length ? 1 : 0);
