// Covers every MCP tool the main integration test doesn't, plus read-only mode and on-screen UI assertions.
// Requires the Brew Board debug build on a device/emulator (ANDROID_SERIAL selects one).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PKG = "io.github.cblmcp.brewboard";
const adb = (...a) => execFileSync("adb", a, { encoding: "utf8" });

async function mcp(env = {}) {
  const c = new Client({ name: "coverage-test", version: "0" });
  await c.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...process.env, CBL_PACKAGE: PKG, ...env } }));
  return c;
}
async function call(c, name, args = {}) {
  const res = await c.callTool({ name, arguments: args });
  if (res.isError) throw new Error(res.content[0].text);
  return JSON.parse(res.content[0].text);
}

/** Texts currently rendered on screen, via uiautomator (frees the UiAutomation slot mobile-mcp may hold). */
function screenTexts() {
  try { adb("shell", "pkill", "-f", "com.mobilenext.mobilecli.DeviceServer"); } catch {}
  for (let i = 0; ; i++) {
    try { adb("shell", "uiautomator", "dump", "/sdcard/ui.xml"); break; }
    catch (e) { if (i >= 4) throw e; execFileSync("sleep", ["2"]); }
  }
  return [...adb("exec-out", "cat", "/sdcard/ui.xml").matchAll(/text="([^"]*)"/g)].map((m) => m[1]);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let c;
before(async () => {
  adb("shell", "am", "start", "-n", `${PKG}/.MainActivity`);
  await sleep(1500);
  c = await mcp();
});
after(async () => {
  await call(c, "cbl_batch", { collection: "shop.orders", operations: [{ op: "purge", id: "cov-ui" }] }).catch(() => {});
  await call(c, "cbl_delete_collection", { collection: "covscope.tmp" }).catch(() => {});
  await c?.close();
});

test("cbl_list_bridges finds the app; cbl_connect selects it explicitly", async () => {
  const { bridges } = await call(c, "cbl_list_bridges");
  assert.ok(bridges.some((b) => b.package === PKG), JSON.stringify(bridges));
  const r = await call(c, "cbl_connect", { package: PKG });
  assert.equal(r.connected.package, PKG);
  assert.equal(typeof r.info.deviceTimeMs, "number");
});

test("cbl_connect to a package that isn't installed fails with a clear message", async () => {
  await assert.rejects(call(c, "cbl_connect", { package: "com.example.not.installed" }), /com\.example\.not\.installed is not installed/);
  await call(c, "cbl_connect", { package: PKG }); // restore
});

test("a write shows up in the real UI, and an update re-renders it", async () => {
  await call(c, "cbl_put_document", { collection: "shop.orders", id: "cov-ui", body: { customer: "Coverage Carla", items: [{ name: "Cortado", qty: 3 }], total: 12, status: "new", createdAt: Date.now() } });
  await sleep(1200);
  let texts = screenTexts();
  assert.ok(texts.includes("Coverage Carla"), "customer not rendered");
  assert.ok(texts.some((t) => t.includes("3× Cortado")), "items not rendered");
  assert.ok(texts.includes("$12.00"), "total not rendered");
  await call(c, "cbl_put_document", { collection: "shop.orders", id: "cov-ui", mode: "merge", body: { customer: "Coverage Carla II", note: "no sugar" } });
  await sleep(1200);
  texts = screenTexts();
  assert.ok(texts.includes("Coverage Carla II"), "rename not rendered");
  assert.ok(texts.some((t) => t.includes("no sugar")), "note not rendered");
  await call(c, "cbl_delete_document", { collection: "shop.orders", id: "cov-ui" });
  await sleep(1200);
  assert.ok(!screenTexts().includes("Coverage Carla II"), "deleted order still on screen");
  await assert.rejects(call(c, "cbl_get_document", { collection: "shop.orders", id: "cov-ui" }), /No document/);
});

test("collections, indexes, explain", async () => {
  await call(c, "cbl_create_collection", { collection: "covscope.tmp" });
  await call(c, "cbl_put_document", { collection: "covscope.tmp", id: "a", body: { city: "Lisbon", tags: ["x"] } });
  await call(c, "cbl_create_index", { collection: "covscope.tmp", name: "idx_city", expressions: ["city"] });
  await call(c, "cbl_create_index", { collection: "covscope.tmp", name: "fts_city", type: "fts", expressions: ["city"] });
  const { indexes } = await call(c, "cbl_list_indexes", { collection: "covscope.tmp" });
  assert.deepEqual(indexes.sort(), ["fts_city", "idx_city"]);
  const plan = await call(c, "cbl_explain", { sql: "SELECT META().id FROM covscope.tmp WHERE city = 'Lisbon'" });
  assert.match(plan.plan, /idx_city/, plan.plan);
  const fts = await call(c, "cbl_query", { sql: "SELECT META().id AS id FROM covscope.tmp WHERE MATCH(fts_city, 'lisbon')" });
  assert.deepEqual(fts.rows, [{ id: "a" }]);
  await call(c, "cbl_delete_index", { collection: "covscope.tmp", name: "idx_city" });
  assert.deepEqual((await call(c, "cbl_list_indexes", { collection: "covscope.tmp" })).indexes, ["fts_city"]);
  await call(c, "cbl_delete_collection", { collection: "covscope.tmp" });
  const info = await call(c, "cbl_info");
  assert.ok(!info.databases[0].collections.some((x) => x.fullName === "covscope.tmp"));
});

test("blobs round-trip byte-exact (binary, 200 KB)", async () => {
  const bytes = Buffer.alloc(200 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff;
  await call(c, "cbl_put_document", { collection: "shop.menu", id: "cov-blob", body: { name: "Blob test", price: 0, category: "test", available: false } });
  await call(c, "cbl_put_blob", { collection: "shop.menu", id: "cov-blob", property: "photo", contentType: "application/octet-stream", base64: bytes.toString("base64") });
  const b = await call(c, "cbl_get_blob", { collection: "shop.menu", id: "cov-blob", property: "photo" });
  assert.equal(b.length, bytes.length);
  assert.ok(Buffer.from(b.base64, "base64").equals(bytes));
  const small = await call(c, "cbl_get_blob", { collection: "shop.menu", id: "cov-blob", property: "photo", maxBytes: 10 });
  assert.equal(small.base64, undefined);
  await call(c, "cbl_delete_document", { collection: "shop.menu", id: "cov-blob", purge: true });
});

test("optimistic concurrency via expectedRevision", async () => {
  const w = await call(c, "cbl_put_document", { collection: "shop.menu", id: "cov-occ", body: { name: "OCC", price: 1 } });
  await call(c, "cbl_put_document", { collection: "shop.menu", id: "cov-occ", expectedRevision: w.revisionId, mode: "merge", body: { price: 2 } });
  await assert.rejects(call(c, "cbl_put_document", { collection: "shop.menu", id: "cov-occ", expectedRevision: w.revisionId, body: { price: 3 } }), /Revision mismatch/);
  assert.equal((await call(c, "cbl_get_document", { collection: "shop.menu", id: "cov-occ" })).body.price, 2);
  await call(c, "cbl_delete_document", { collection: "shop.menu", id: "cov-occ", purge: true });
});

test("large batch: 2000 docs in one transaction, then counted and removed", async () => {
  const ops = Array.from({ length: 2000 }, (_, i) => ({ op: "put", id: `cov-bulk-${i}`, body: { n: i, even: i % 2 === 0 } }));
  const t = Date.now();
  const r = await call(c, "cbl_batch", { collection: "covbulk.docs", createCollection: true, operations: ops });
  const ms = Date.now() - t;
  assert.equal(r.count, 2000);
  const q = await call(c, "cbl_query", { sql: "SELECT COUNT(*) AS n, SUM(d.n) AS s FROM covbulk.docs AS d WHERE d.even = true" });
  assert.deepEqual(q.rows, [{ n: 1000, s: 999000 }]);
  const page = await call(c, "cbl_query", { sql: "SELECT META().id FROM covbulk.docs", limit: 5 });
  assert.equal(page.rows.length, 5);
  assert.equal(page.rowCount, 2000);
  assert.equal(page.truncated, true);
  await call(c, "cbl_delete_collection", { collection: "covbulk.docs" });
  console.log(`    2000-doc batch took ${ms} ms end to end`);
});

test("replicator tools report cleanly when the app registered none", async () => {
  assert.deepEqual((await call(c, "cbl_replicators")).replicators, []);
  await assert.rejects(call(c, "cbl_replicator_control", { name: "main", action: "start" }), /No replicator 'main'/);
});

test("CBL_MCP_READ_ONLY hides every write tool", async () => {
  const ro = await mcp({ CBL_MCP_READ_ONLY: "1" });
  const names = (await ro.listTools()).tools.map((t) => t.name).sort();
  await ro.close();
  assert.deepEqual(names, [
    "cbl_changes", "cbl_connect", "cbl_describe_collection", "cbl_explain", "cbl_get_blob", "cbl_get_document",
    "cbl_info", "cbl_list_bridges", "cbl_list_indexes", "cbl_query", "cbl_replicators",
  ]);
  const all = (await c.listTools()).tools.length;
  assert.equal(all, 20);
});

test("bridge rejects requests with a wrong token", async () => {
  const conn = JSON.parse(adb("exec-out", "run-as", PKG, "cat", "files/.cbl-bridge/bridge.json"));
  const local = adb("forward", "tcp:0", `tcp:${conn.port}`).trim();
  try {
    const bad = await fetch(`http://127.0.0.1:${local}/query`, { method: "POST", headers: { Authorization: "Bearer nope" }, body: JSON.stringify({ sql: "SELECT 1" }) });
    assert.equal(bad.status, 401);
    const hello = await fetch(`http://127.0.0.1:${local}/hello`).then((r) => r.json());
    assert.deepEqual(Object.keys(hello).sort(), ["bridge", "bridgeVersion", "package", "pid", "port"], "hello must not leak more than identity");
  } finally {
    adb("forward", "--remove", `tcp:${local}`);
  }
});
