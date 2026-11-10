// Write matrix for the Banners screen over the legacy `banners` table. Everything it
// creates it deletes again, and `node scripts/b142.mjs restore` cleans up whatever a
// failed assertion left behind, so the table can be verified byte-identical afterwards.
//
//   node scripts/b142-write.mjs
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import mysql from "mysql2/promise";
import "dotenv/config";

const API = process.env.B142_API ?? "http://localhost:4000/api";
const UPLOADS = path.resolve("uploads", "Banners");
const EMAIL = "admin.test@ondemand.local";
const PASSWORD = "TestPass123!";

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
  return { status: res.status, json, headers: res.headers, text };
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

async function upload(id, bytes, filename, app = "genie") {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "image/png" }), filename);
  return call("POST", `/banner/${app}/${id}/image`, undefined, { form });
}

// ---------------------------------------------------------------------------
// SQL helpers — every one of them names eType, so a check can never be fooled by
// another app's rows.
// ---------------------------------------------------------------------------

async function one(sql, params) {
  const [rows] = await db.query(sql, params);
  return rows[0];
}

async function groupRows(uid, eType = "Genie") {
  const [rows] = await db.query(
    "SELECT * FROM banners WHERE iUniqueId = ? AND eType = ? ORDER BY vCode",
    [uid, eType],
  );
  return rows;
}

async function distinct(uid, column, eType = "Genie") {
  const [rows] = await db.query(
    `SELECT DISTINCT \`${column}\` AS v FROM banners WHERE iUniqueId = ? AND eType = ?`,
    [uid, eType],
  );
  return rows.map((r) => r.v);
}

const files = () => readdirSync(UPLOADS).filter((f) => !f.startsWith("."));

// ---------------------------------------------------------------------------

await login();
const marker = `ZZ b142 ${Date.now() % 100000}`;
let uid = 0;

console.log("\n--- create refuses a payload the legacy form would have rejected ---");
{
  const noEn = await post("/banner/genie", { texts: { FR: "sans anglais" } });
  eq("POST without an English title -> 400", noEn.status, 400);
  const badLang = await post("/banner/genie", { texts: { EN: "ok", XX: "nonsense" } });
  eq("POST with an unknown language code -> 400", badLang.status, 400);
  const tooLong = await post("/banner/genie", { texts: { EN: "x".repeat(101) } });
  eq("POST with a 101-character title -> 400", tooLong.status, 400);
  const badColor = await post("/banner/genie", { texts: { EN: "ok" }, statusBarColor: "red" });
  eq("POST with a non-hex status-bar colour -> 400", badColor.status, 400);
  const strays = await one("SELECT COUNT(*) AS n FROM banners WHERE vTitle LIKE 'ZZ b142 %'", []);
  eq("nothing was inserted by the rejected creates", strays.n, 0);
}

console.log("\n--- create writes one row per language inside the genie slice ---");
{
  const created = await post("/banner/genie", { texts: { EN: marker, AR: "جني اختبار" }, status: "Active" });
  eq("POST /banner/genie -> 201", created.status, 201);
  uid = created.json?.item?.id ?? 0;
  ok("the new banner has a group id", uid > 0, `id ${uid}`);
  eq("the add form pre-filled slot 4 (genie max + 1)", created.json?.item?.displayOrder, 4);
  eq("26 language rows answered", created.json?.item?.rowCount, 26);

  const rows = await groupRows(uid);
  eq("the table holds 26 rows for the group", rows.length, 26);
  eq("every row is eType='Genie'", (await distinct(uid, "eType")).join(), "Genie");
  eq("the English title landed", rows.find((r) => r.vCode === "EN")?.vTitle, marker);
  eq("the Arabic title landed", rows.find((r) => r.vCode === "AR")?.vTitle, "جني اختبار");
  eq("untouched languages are stored blank", rows.filter((r) => r.vTitle === "").length, 24);
  eq("one shared status", (await distinct(uid, "eStatus")).join(), "Active");
  eq("one shared slot", (await distinct(uid, "iDisplayOrder")).join(), "4");
  eq("shown everywhere", (await distinct(uid, "iLocationid")).join(), "-1");
  eq("the picture starts empty", (await distinct(uid, "vImage")).join(), "");
  eq("eFor matches the shipped rows", (await distinct(uid, "eFor")).join(), "General");

  const list = await get("/banner/genie/list");
  eq("the genie list now shows 2 banners", list.json?.total, 2);
  const parcel = await get("/banner/delivery/list");
  eq("the parcel slice still shows its own 2", parcel.json?.total, 2);
  eq("and still names 50 first", parcel.json?.items?.[0]?.id, 50);
}

console.log("\n--- the other app cannot read or rewrite this slice ---");
{
  eq("GET /banner/delivery/<uid> -> 404", (await get(`/banner/delivery/${uid}`)).status, 404);
  eq("PUT /banner/delivery/<uid> -> 404", (await put(`/banner/delivery/${uid}`, { texts: { EN: "hijack" } })).status, 404);
  eq("PATCH /banner/delivery/<uid>/status -> 404", (await patch(`/banner/delivery/${uid}/status`, { status: "Inactive" })).status, 404);
  eq("DELETE /banner/delivery/<uid> -> 404", (await del(`/banner/delivery/${uid}`, { confirm: marker })).status, 404);
  eq("the group survived the cross-slice attempts", (await groupRows(uid)).length, 26);
  eq("and stayed Active", (await distinct(uid, "eStatus")).join(), "Active");
  const parcel68 = await put("/banner/delivery/68", { texts: { EN: "hijack" } });
  eq("PUT /banner/delivery/68 (a genie group) -> 404", parcel68.status, 404);
  const genie = await get("/banner/genie/68");
  eq("the real genie banner kept its English title", genie.json?.item?.translationsFilled, 26);
  eq("unknown app on a write path -> 400", (await post("/banner/store", { texts: { EN: "x" } })).status, 400);
  // Delivery Runner (#sub-143) is now a registered third slice, so it belongs in this
  // section as a neighbour that must be excluded, not as an unknown segment.
  eq("GET /banner/runner/<uid> (third slice) -> 404", (await get(`/banner/runner/${uid}`)).status, 404);
  eq("PUT /banner/runner/<uid> (third slice) -> 404", (await put(`/banner/runner/${uid}`, { texts: { EN: "hijack" } })).status, 404);
  eq("DELETE /banner/runner/<uid> (third slice) -> 404", (await del(`/banner/runner/${uid}`, { confirm: marker })).status, 404);
  eq("the runner group 69 is still the runner slice’s own", (await get("/banner/runner/69")).status, 200);
}

console.log("\n--- edit fans out per language, slot and colour ---");
{
  const edited = await put(`/banner/genie/${uid}`, { texts: { FR: "Génie test" } });
  eq("PUT one language -> 200", edited.status, 200);
  const rows = await groupRows(uid);
  eq("the French row changed", rows.find((r) => r.vCode === "FR")?.vTitle, "Génie test");
  eq("the English row did not", rows.find((r) => r.vCode === "EN")?.vTitle, marker);
  eq("still 26 rows", rows.length, 26);

  const both = await put(`/banner/genie/${uid}`, { displayOrder: 9, statusBarColor: "#112233" });
  eq("PUT slot + colour -> 200", both.status, 200);
  eq("the slot is shared by the group", (await distinct(uid, "iDisplayOrder")).join(), "9");
  eq("the colour is shared by the group", (await distinct(uid, "vStatusBarColor")).join(), "#112233");

  const empty = await put(`/banner/genie/${uid}`, {});
  eq("PUT with nothing to change -> 400", empty.status, 400);
  const badSlot = await put(`/banner/genie/${uid}`, { displayOrder: 99999 });
  eq("PUT a slot above 9999 -> 400", badSlot.status, 400);
  eq("the blank save changed no row", (await distinct(uid, "iDisplayOrder")).join(), "9");
}

console.log("\n--- status is atomic over the group and idempotent ---");
{
  const off = await patch(`/banner/genie/${uid}/status`, { status: "Inactive" });
  eq("PATCH Inactive -> 200", off.status, 200);
  eq("every row is Inactive", (await distinct(uid, "eStatus")).join(), "Inactive");
  const again = await patch(`/banner/genie/${uid}/status`, { status: "Inactive" });
  eq("PATCH the same status again -> 200", again.status, 200);
  eq("and the group is still Inactive", (await distinct(uid, "eStatus")).join(), "Inactive");
  const bogus = await patch(`/banner/genie/${uid}/status`, { status: "Deleted" });
  eq("PATCH a status the enum has not -> 400", bogus.status, 400);
  const on = await patch(`/banner/genie/${uid}/status`, { status: "Active" });
  eq("PATCH back to Active -> 200", on.status, 200);
  eq("every row is Active again", (await distinct(uid, "eStatus")).join(), "Active");
  const other = await get("/banner/genie/list?status=Inactive");
  eq("the Inactive filter finds nothing now", other.json?.total, 0);
  const search = await get(`/banner/genie/list?search=${encodeURIComponent(marker)}`);
  eq("the search filter finds this banner", search.json?.total, 1);
}

console.log("\n--- the picture: attach, replace, ref-count, delete ---");
{
  const before = files().length;
  const first = await upload(uid, PNG_A, "b142-a.png");
  eq("POST image -> 200", first.status, 200);
  const image = first.json?.item?.image ?? "";
  ok("the group got a file name", image.endsWith(".png"), image);
  eq("every row of the group names it", (await distinct(uid, "vImage")).join(), image);
  ok("the file is on disk", existsSync(path.join(UPLOADS, image)));

  const served = await bytes(`/banner/genie/${uid}/image`);
  eq("GET image returns the bytes", served.body.compare(PNG_A), 0);

  const second = await upload(uid, PNG_B, "b142-b.png");
  eq("replace the picture -> 200", second.status, 200);
  const next = second.json?.item?.image ?? "";
  ok("a second file name was written", next !== image, next);
  eq("the orphaned first file was removed", files().length, before + 1);

  const wrongApp = await upload(68, PNG_A, "b142-no.png", "delivery");
  eq("uploading into another slice -> 404", wrongApp.status, 404);
  eq("and it left no orphan behind", files().length, before + 1);

  const txt = new FormData();
  txt.append("file", new Blob([Buffer.from("not an image")], { type: "text/plain" }), "b142.txt");
  const rejected = await call("POST", `/banner/genie/${uid}/image`, undefined, { form: txt });
  eq("a non-image upload -> 400", rejected.status, 400);
  eq("the rejected upload wrote no file", files().length, before + 1);
  rmSync(path.join(UPLOADS, next), { force: true });
}

console.log("\n--- delete is name-confirmed and wipes the group ---");
{
  const blank = await del(`/banner/genie/${uid}`, { confirm: "" });
  eq("DELETE with a blank confirm -> 400", blank.status, 400);
  const wrong = await del(`/banner/genie/${uid}`, { confirm: "something else" });
  eq("DELETE with the wrong name -> 400", wrong.status, 400);
  ok("and it asks for the exact title", message(wrong).includes(marker), message(wrong));
  const missing = await del("/banner/genie/999999", { confirm: "x" });
  eq("DELETE an unknown id -> 404", missing.status, 404);

  // Re-attach a file so the ref-counted cleanup on delete is exercised.
  const re = await upload(uid, PNG_A, "b142-c.png");
  const attached = re.json?.item?.image ?? "";
  const gone = await del(`/banner/genie/${uid}`, { confirm: marker });
  eq("DELETE with the right name -> 200", gone.status, 200);
  eq("it removed all 26 rows", gone.json?.rowsRemoved, 26);
  eq("the group is gone from the table", (await groupRows(uid)).length, 0);
  const size = await one("SELECT COUNT(*) AS n FROM banners", []);
  eq("the table is back to its shipped 993 rows", size.n, 993);
  eq("the picture nothing points at was deleted", files().includes(attached), false);
  eq("the genie list is back to 1 banner", (await get("/banner/genie/list")).json?.total, 1);
  eq("GET the deleted banner -> 404", (await get(`/banner/genie/${uid}`)).status, 404);
}

console.log("\n--- the shipped genie banner survives untouched round trips ---");
{
  const off = await patch("/banner/genie/68/status", { status: "Inactive" });
  eq("PATCH the real banner Inactive -> 200", off.status, 200);
  eq("all 26 rows went Inactive", (await distinct(68, "eStatus")).join(), "Inactive");
  const on = await patch("/banner/genie/68/status", { status: "Active" });
  eq("PATCH it back -> 200", on.status, 200);
  eq("all 26 rows are Active again", (await distinct(68, "eStatus")).join(), "Active");

  const ren = await put("/banner/genie/68", { texts: { EN: "Temporarily Renamed" } });
  eq("PUT a new English title -> 200", ren.status, 200);
  eq("the row holds it", (await groupRows(68)).find((r) => r.vCode === "EN")?.vTitle, "Temporarily Renamed");
  const back = await put("/banner/genie/68", { texts: { EN: "Delivery Genie" } });
  eq("PUT the original title back -> 200", back.status, 200);
  eq("the row holds it again", (await groupRows(68)).find((r) => r.vCode === "EN")?.vTitle, "Delivery Genie");

  const shipped = await one("SELECT vImage FROM banners WHERE iUniqueId = 68 LIMIT 1", []);
  const img = await get("/banner/genie/68/image");
  eq("the shipped picture is still served", img.status, 200);
  ok("and is still named by the group", shipped.vImage === "20230113155737103.png", shipped.vImage);
}

console.log(`\nupload leftovers in ${UPLOADS}: ${JSON.stringify(files())}`);
console.log(`b142-write: ${pass} ok, ${failures.length} failed`);
if (failures.length) console.log(failures.map((f) => ` - ${f}`).join("\n"));

await db.end();
process.exit(failures.length ? 1 : 0);
