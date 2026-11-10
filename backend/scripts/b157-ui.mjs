// Browser smoke for Delivery Runner → Delivery Charges (#sub-157).
//
// `b157-write.mjs` proves the server hands one table to two menus. This proves what the admin
// SEES: that /permissions/34#sub-157 renders the Delivery Charges panel under the Runner menu
// with the runner key suffix in its description, the warning that these rows are shared, and
// the very same scheme the Genie panel at /permissions/33#sub-154 lists — and that the delete
// dialog says "runner is not the only menu that reads it" while still making the admin type
// the row's own location label back. Nothing here writes: the dialog is opened, filled, and
// dismissed with Escape, and the row is re-read over the API afterwards to prove it.
//
// It drives the system Chrome over the DevTools protocol (Node's built-in WebSocket), because
// the panel is client-rendered from a hash route: `#sub-157` never reaches the server, so the
// HTML curl cannot see any of this. It leaves a throwaway profile in `.lh/chrome-profile` —
// about 34 MB, and safe to delete.
//
//   node scripts/b157-ui.mjs            # needs the admin on :3000 and the API on :4000
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

const ADMIN = process.env.B157_ADMIN ?? "http://localhost:3000";
const API = process.env.B157_API_BASE ?? "http://localhost:4000";
const PORT = Number(process.env.B157_CDP_PORT ?? 9333);
const EMAIL = "admin.test@ondemand.local";
const PASSWORD = "TestPass123!";
const SHOT = path.resolve("..", ".lh", "b157-delivery-charges.png");
/** Chrome needs a writable profile; the repo's own artifact folder keeps it out of $HOME. */
const PROFILE = path.resolve("..", ".lh", "chrome-profile");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const failures = [];

function ok(label, cond, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}${detail ? ` — ${String(detail).slice(0, 300)}` : ""}`);
  }
}

function eq(label, actual, want) {
  ok(label, String(actual) === String(want), `got ${JSON.stringify(actual)}, want ${JSON.stringify(want)}`);
}

// ---------------------------------------------------------------------------
// The API side, so the smoke can prove it changed nothing.
// ---------------------------------------------------------------------------

async function apiList(app) {
  const res = await fetch(`${API}/api/delivery-charge/${app}/list`, {
    headers: { "X-Requested-With": "XMLHttpRequest", cookie },
  });
  return res.json();
}

let cookie = "";
{
  const res = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "X-Requested-With": "XMLHttpRequest", "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  cookie = (res.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(";")[0])
    .filter((c) => c.startsWith("at="))
    .join("; ");
  ok("login as the test super admin", res.status === 200 && cookie !== "", `status ${res.status}`);
}

const before = await apiList("runner");
console.log(
  `\nthe shared table before the smoke: ${before.total} live scheme(s) — ` +
    (before.items ?? []).map((r) => `#${r.id} ${r.scopeLabel} ${r.distanceFrom}–${r.distanceTo}`).join(", "),
);

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

const chrome = spawn(
  "google-chrome",
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--no-first-run",
    "--disable-extensions",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
chrome.stderr.on("data", (b) => process.stderr.write(String(b).slice(0, 0)));

async function cdp(p, init) {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`, init);
  return res.json();
}

let target = null;
for (let i = 0; i < 80 && !target; i += 1) {
  await sleep(500);
  try {
    const list = await cdp("/json/list");
    target = list.find((t) => t.type === "page") ?? null;
  } catch {
    /* not up yet */
  }
}
if (!target) {
  console.log("chrome never came up on port " + PORT);
  chrome.kill("SIGKILL");
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error("websocket to chrome failed"));
});

const pending = new Map();
const consoleLines = [];
let pageError = null;
let loaded = false;

ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
    return;
  }
  if (msg.method === "Log.entryAdded") {
    const e = msg.params.entry;
    if (e.level === "error" || e.level === "warning") {
      consoleLines.push(`${e.level} ${e.source ?? "?"}: ${e.text}`);
    }
  } else if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params.exceptionDetails;
    pageError = d.exception?.description ?? d.text;
  } else if (msg.method === "Page.loadEventFired") {
    loaded = true;
  }
};

let mid = 0;

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = (mid += 1);
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const r = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result?.value;
}

async function goto(url) {
  loaded = false;
  await send("Page.navigate", { url });
  for (let i = 0; i < 120 && !loaded; i += 1) await sleep(250);
}

/** Poll an in-page expression until it answers with the wanted string (client routing). */
async function waitFor(expr, want, ms = 30_000) {
  const until = Date.now() + ms;
  let got = "";
  do {
    got = String((await evaluate(`(${expr})() ?? ""`)) ?? "");
    if (got === want) return got;
    await sleep(300);
  } while (Date.now() < until);
  return got;
}

/** The panel mounts after the client fetches its list, so text arrives late. */
async function bodyText(needle, ms = 45_000) {
  const until = Date.now() + ms;
  let text = "";
  do {
    text = (await evaluate("document.body.innerText")) ?? "";
    if (text.includes(needle)) return text;
    await sleep(400);
  } while (Date.now() < until);
  return text;
}

await send("Page.enable");
await send("Runtime.enable");
await send("Log.enable");
await send("Network.enable");

// The admin talks to the API on another port; host-only cookies are shared across ports,
// so handing Chrome the session cookie is the same login the form would have done.
for (const pair of cookie.split("; ")) {
  const [name, ...rest] = pair.split("=");
  if (!name) continue;
  await send("Network.setCookie", {
    name,
    value: rest.join("="),
    url: `${ADMIN}/`,
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
  });
}

const text = (t) => (t ?? "").replace(/\s+/g, " ");

try {
  // =========================================================================
  console.log("\n--- Delivery Runner's own menu renders the Delivery Charges panel ---");
  await goto(`${ADMIN}/permissions/34#sub-157`);
  const runner = text(await bodyText("User Delivery Charges"));
  ok("the panel titles itself the distance-wise way", runner.includes("User Delivery Charges"));
  ok("  because the legacy switch is on for both menus",
    runner.includes("per distance band inside a location"), runner.slice(0, 400));
  ok("  and names the runner key family the guards ask for",
    runner.includes("view/create/edit/delete/update-status-delivery-charges-runner-delivery"),
    runner.slice(0, 500));
  ok("the shared-rows warning is on the panel",
    runner.includes("shared with Delivery Genie and Store deliveries"), runner.slice(0, 500));
  ok("  and says the same rows price all three",
    runner.includes("the same rows price all three"), runner.slice(0, 500));
  ok("the shipped scheme is listed here", runner.includes("All locations"), runner.slice(0, 800));
  ok("  with its stored band", runner.includes("0 – 200 km"), runner.slice(0, 800));
  ok("  and its legacy amounts", runner.includes("$50"), text(await bodyText("$50")).slice(0, 800));
  ok("  listed as the only delivery charge there", /of 1 delivery charges/.test(runner), runner.slice(-400));
  const newBtn = await evaluate(
    "[...document.querySelectorAll('button')].map((b) => b.innerText.trim()).filter((t) => t.includes('New Delivery Charge')).length",
  );
  ok("the runner menu offers its own create button", newBtn > 0, `found ${newBtn}`);

  // =========================================================================
  console.log("\n--- its create route is the runner app's own form, over the same table ---");
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.innerText.includes('New Delivery Charge'));
    b?.click();
    return true;
  })()`);
  const formUrl = await waitFor("() => location.pathname", "/delivery-charge/runner/new", 60_000);
  eq("the button routes to /delivery-charge/runner/new", formUrl, "/delivery-charge/runner/new");
  const form = text(await bodyText("User Delivery Charges"));
  ok("the runner form titles itself the distance-wise way", form.includes("User Delivery Charges"));
  ok("  and carries the same shared-rows warning", form.includes("the same rows price all three"),
    form.slice(0, 600));
  ok("  with no zone to pick but the one the legacy row uses", form.includes("All locations"),
    form.slice(0, 900));

  // =========================================================================
  console.log("\n--- back to the runner list, which still holds the one shared scheme ---");
  await goto(`${ADMIN}/permissions/34#sub-157`);
  const again = text(await bodyText("User Delivery Charges"));
  ok("the panel came back with its own row", again.includes("All locations") && again.includes("$50"),
    again.slice(0, 400));
  await send("Page.captureScreenshot", { format: "png" }).then((r) =>
    writeFileSync(SHOT, Buffer.from(r.data, "base64")),
  );
  console.log(`  screenshot -> ${SHOT}`);

  // =========================================================================
  console.log("\n--- the same rows under the Genie menu, with genie's keys ---");
  await goto(`${ADMIN}/permissions/33#sub-154`);
  const genie = text(await bodyText("User Delivery Charges"));
  ok("genie's panel lists the same All-locations scheme", genie.includes("All locations"));
  ok("  the same band", genie.includes("0 – 200 km"));
  ok("  and the same amounts", genie.includes("$50"));
  ok("but it guards itself with the genie suffix",
    genie.includes("view/create/edit/delete/update-status-delivery-charges-genie-delivery"),
    genie.slice(0, 500));
  ok("  and its own note says so", genie.includes("shared with Delivery Runner and Store deliveries"),
    genie.slice(0, 500));

  // =========================================================================
  console.log("\n--- the delete dialog says what a runner delete really hides ---");
  // Back to the runner menu, because the sentence under the warning is the entry's own.
  await goto(`${ADMIN}/permissions/34#sub-157`);
  await bodyText("User Delivery Charges");
  const opened = await evaluate(`(() => {
    const row = [...document.querySelectorAll('tr')].find((tr) => tr.innerText.includes('All locations'));
    const btn = row && [...row.querySelectorAll('button')].find((b) => /delete/i.test(b.getAttribute('aria-label') || b.title || b.innerText));
    if (!btn) return 'no delete button on the row';
    btn.click();
    return 'clicked';
  })()`);
  const dialog = text(await bodyText("Delete delivery charge?"));
  ok("the dialog opens from the row", dialog.includes("Delete delivery charge?"), `${opened} / ${dialog.slice(0, 200)}`);
  ok("  it warns that runner is not the only menu reading the table",
    dialog.includes("runner is not the only menu that reads it"), dialog.slice(0, 700));
  ok("  and names the row's own location as the thing to type",
    dialog.includes("Type “All locations” to confirm"), dialog.slice(0, 700));
  eq("  and it stays disabled while the words are wrong", await evaluate(`(() => {
    const input = document.getElementById('delete-confirm');
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(input, 'All');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const btn = [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Delete');
    return String(btn?.disabled);
  })()`), "true");
  eq("  enabled once the label is typed back exactly", await evaluate(`(() => {
    const input = document.getElementById('delete-confirm');
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(input, 'All locations');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const btn = [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Delete');
    return String(btn?.disabled);
  })()`), "false");
  await evaluate(`(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const btn = [...document.querySelectorAll('button')].find((b) => b.getAttribute('data-slot') === 'dialog-close');
    btn?.click();
    return true;
  })()`);
  await sleep(800);
  const after = text(await evaluate("document.body.innerText"));
  ok("the dialog was dismissed without deleting", !after.includes("Type “All locations” to confirm"),
    after.slice(0, 200));
} catch (err) {
  failures.push(`the smoke threw: ${err?.message ?? err}`);
  console.log(`  FAIL the smoke threw — ${err?.stack ?? err}`);
} finally {
  // Nothing here is allowed to write, so say so with the table rather than with hope.
  const after = await apiList("runner");
  eq("the runner list still holds what it held", after.total, before.total);
  eq("  the shipped scheme is still Active", after.items?.[0]?.status, before.items?.[0]?.status);
  eq("  with its band untouched",
    `${after.items?.[0]?.distanceFrom}-${after.items?.[0]?.distanceTo}`,
    `${before.items?.[0]?.distanceFrom}-${before.items?.[0]?.distanceTo}`);
  const genie = await apiList("genie");
  eq("  and genie reads the same row", JSON.stringify(genie.items), JSON.stringify(after.items));
  console.log(`\nconsole errors/warnings: ${consoleLines.length ? "\n" + consoleLines.join("\n") : "<none>"}`);
  ok("the page threw no uncaught exception", pageError === null, pageError);
  ws.close();
  chrome.kill("SIGKILL");
}

console.log(`\nb157-ui: ${pass} ok, ${failures.length} failed`);
if (failures.length) console.log(failures.map((f) => ` - ${f}`).join("\n"));
process.exit(failures.length ? 1 : 0);
