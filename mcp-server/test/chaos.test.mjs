// Lifecycle chaos: the app dies, sleeps, goes to the background; adb restarts; clients compete.
// Requires the Brew Board debug build on a device/emulator (ANDROID_SERIAL selects one).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PKG = "io.github.cblmcp.brewboard";
const adb = (...a) => execFileSync("adb", a, { encoding: "utf8" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mcp() {
  const c = new Client({ name: "chaos-test", version: "0" });
  await c.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...process.env, CBL_PACKAGE: PKG } }));
  return c;
}
async function call(c, name, args = {}) {
  const res = await c.callTool({ name, arguments: args });
  if (res.isError) throw new Error(res.content[0].text);
  return JSON.parse(res.content[0].text);
}

let c;
before(async () => {
  adb("shell", "am", "start", "-n", `${PKG}/.MainActivity`);
  await sleep(2000);
  c = await mcp();
  await call(c, "cbl_info");
});
after(async () => {
  try { adb("shell", "dumpsys", "deviceidle", "unforce"); } catch {}
  adb("shell", "am", "start", "-n", `${PKG}/.MainActivity`);
  await c?.close();
});

test("app killed during a long-poll: the call returns quickly and says the app restarted", async () => {
  const t = Date.now();
  const pending = c.callTool({ name: "cbl_changes", arguments: { timeoutMs: 30000 } });
  await sleep(1500);
  adb("shell", "am", "force-stop", PKG);
  const res = await pending;
  const secs = (Date.now() - t) / 1000;
  assert.ok(secs < 20, `took ${secs}s`);
  const text = res.content[0].text;
  if (!res.isError) {
    const d = JSON.parse(text);
    assert.equal(d.appRestarted, true, text);
    // and the reset cursor really sees new writes from the restarted process
    await call(c, "cbl_put_document", { collection: "shop.orders", id: "chaos-after", body: { x: 1 } });
    const after = await call(c, "cbl_changes", { timeoutMs: 3000 });
    assert.ok(after.events.some((e) => e.documentIds.includes("chaos-after")), JSON.stringify(after));
    await call(c, "cbl_delete_document", { collection: "shop.orders", id: "chaos-after", purge: true });
  } else {
    assert.match(text, /Lost connection|not running|No running app|restart/i, text);
  }
  // next call relaunches the app (CBL_PACKAGE) and works
  const info = await call(c, "cbl_info");
  assert.equal(info.connected.package, PKG);
});

test("app not running at all: the next call launches it", async () => {
  adb("shell", "am", "force-stop", PKG);
  await sleep(500);
  const info = await call(c, "cbl_info");
  assert.equal(info.connected.package, PKG);
  assert.ok(adb("shell", "pidof", PKG).trim(), "app not running after call");
});

test("app in the background still answers, and writes still land", async () => {
  adb("shell", "input", "keyevent", "KEYCODE_HOME");
  await sleep(1500);
  await call(c, "cbl_put_document", { collection: "shop.orders", id: "chaos-bg", body: { customer: "Background Bea", status: "new", total: 1, createdAt: Date.now() } });
  const d = await call(c, "cbl_get_document", { collection: "shop.orders", id: "chaos-bg" });
  assert.equal(d.body.customer, "Background Bea");
  await call(c, "cbl_delete_document", { collection: "shop.orders", id: "chaos-bg", purge: true });
});

test("forced Doze with the app in the background: works, or fails within 60 s with a Doze diagnosis", async () => {
  adb("shell", "input", "keyevent", "KEYCODE_HOME");
  await sleep(1500);
  adb("shell", "dumpsys", "deviceidle", "force-idle");
  const t = Date.now();
  try {
    const res = await c.callTool({ name: "cbl_query", arguments: { sql: "SELECT COUNT(*) AS n FROM shop.menu" } }, undefined, { timeout: 120_000 });
    const secs = (Date.now() - t) / 1000;
    assert.ok(secs < 60, `took ${secs}s`);
    if (res.isError) assert.match(res.content[0].text, /Doze|foreground/, res.content[0].text);
    else assert.ok(JSON.parse(res.content[0].text).rows[0].n > 0);
    console.log(`    doze outcome after ${secs.toFixed(1)}s: ${res.isError ? res.content[0].text.slice(0, 160) : "answered"}`);
  } finally {
    adb("shell", "dumpsys", "deviceidle", "unforce");
  }
  // once the device leaves Doze, the same client works again (recovery foregrounds the app if needed)
  await sleep(3000);
  const q = await call(c, "cbl_query", { sql: "SELECT COUNT(*) AS n FROM shop.menu" });
  assert.ok(q.rows[0].n > 0);
});

test("adb server killed mid-session: the next call recovers", async () => {
  execFileSync("adb", ["kill-server"]);
  await sleep(1000);
  execFileSync("adb", ["start-server"]);
  await sleep(2000);
  const info = await call(c, "cbl_info");
  assert.equal(info.connected.package, PKG);
});

test("two MCP clients at the same time see each other's writes", async () => {
  const c2 = await mcp();
  try {
    await Promise.all([
      call(c, "cbl_put_document", { collection: "shop.orders", id: "chaos-a", body: { by: "one" } }),
      call(c2, "cbl_put_document", { collection: "shop.orders", id: "chaos-b", body: { by: "two" } }),
    ]);
    assert.equal((await call(c2, "cbl_get_document", { collection: "shop.orders", id: "chaos-a" })).body.by, "one");
    assert.equal((await call(c, "cbl_get_document", { collection: "shop.orders", id: "chaos-b" })).body.by, "two");
    await call(c, "cbl_batch", { collection: "shop.orders", operations: [{ op: "purge", id: "chaos-a" }, { op: "purge", id: "chaos-b" }] });
  } finally {
    await c2.close();
  }
});

test("NUL characters are refused end to end instead of being truncated", async () => {
  await assert.rejects(call(c, "cbl_put_document", { collection: "shop.orders", id: "chaos-nul", body: { a: "ab\u0000cd" } }), /NUL/);
  await assert.rejects(call(c, "cbl_get_document", { collection: "shop.orders", id: "chaos-nul" }), /No document/);
});
