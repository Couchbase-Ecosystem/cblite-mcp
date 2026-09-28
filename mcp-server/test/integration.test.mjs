// End-to-end: real MCP client -> cbl-mcp (stdio) -> adb forward -> bridge inside the running demo app.
// Requires the Brew Board debug build running on a device/emulator (ANDROID_SERIAL selects one).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PKG = "io.github.cblmcp.brewboard";
let client;

async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content[0].text;
  if (res.isError) throw new Error(text);
  return JSON.parse(text);
}

function adb(...args) {
  return execFileSync("adb", args, { encoding: "utf8" });
}

/** Finds a button by its text in the live UI hierarchy and taps its centre, like a user would. */
function tapText(label) {
  adb("shell", "uiautomator", "dump", "/sdcard/ui.xml");
  const xml = adb("exec-out", "cat", "/sdcard/ui.xml");
  const m = xml.match(new RegExp(`text="${label}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`));
  assert.ok(m, `no "${label}" on screen`);
  const [x1, y1, x2, y2] = m.slice(1).map(Number);
  adb("shell", "input", "tap", String((x1 + x2) >> 1), String((y1 + y2) >> 1));
}

before(async () => {
  adb("shell", "am", "start", "-n", `${PKG}/.MainActivity`);
  client = new Client({ name: "integration-test", version: "0" });
  await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...process.env, CBL_PACKAGE: PKG } }));
});

after(async () => {
  await call("cbl_batch", {
    collection: "shop.orders",
    operations: [{ op: "purge", id: "it-1" }, { op: "purge", id: "it-2" }],
  }).catch(() => {});
  await client?.close();
});

test("exposes the expected tools", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const n of ["cbl_info", "cbl_query", "cbl_describe_collection", "cbl_put_document", "cbl_batch", "cbl_changes"]) {
    assert.ok(names.includes(n), n);
  }
});

test("auto-connects and reports collections", async () => {
  const info = await call("cbl_info");
  assert.equal(info.connected.package, PKG);
  const cols = info.databases.flatMap((d) => d.collections.map((c) => c.fullName));
  assert.ok(cols.includes("shop.orders") && cols.includes("shop.menu"));
});

test("describe infers the menu schema", async () => {
  const d = await call("cbl_describe_collection", { collection: "shop.menu" });
  assert.deepEqual(Object.keys(d.fields).sort(), ["available", "category", "name", "price"]);
});

test("seed via batch, query, then UI tap shows up as an app change", async () => {
  await call("cbl_changes"); // move the cursor to now
  const now = Date.now();
  await call("cbl_batch", {
    collection: "shop.orders",
    operations: [
      { op: "put", id: "it-1", body: { customer: "Integration Ivy", items: [{ name: "Cortado", qty: 1 }], total: 4, status: "new", createdAt: now - 120000 } },
      { op: "put", id: "it-2", body: { customer: "Integration Ian", items: [{ name: "Chai Latte", qty: 2 }], total: 8.5, status: "ready", createdAt: now - 60000 } },
    ],
  });
  const q = await call("cbl_query", { sql: "SELECT META(o).id AS id FROM shop.orders AS o WHERE o.customer LIKE 'Integration%' ORDER BY META(o).id" });
  assert.deepEqual(q.rows.map((r) => r.id), ["it-1", "it-2"]);

  const agentChanges = await call("cbl_changes", { timeoutMs: 2000 });
  assert.ok(agentChanges.events.some((e) => e.source === "bridge" && e.documentIds.includes("it-1")));

  // Only it-1 is "new", so "Start" is unambiguous if the DB has no other new orders.
  const others = await call("cbl_query", { sql: "SELECT COUNT(*) AS n FROM shop.orders WHERE status = 'new'" });
  assert.equal(others.rows[0].n, 1, "test expects it-1 to be the only NEW order");
  await new Promise((r) => setTimeout(r, 800));
  tapText("Start");
  const appChanges = await call("cbl_changes", { timeoutMs: 5000 });
  const ev = appChanges.events.find((e) => e.documentIds.includes("it-1"));
  assert.ok(ev, JSON.stringify(appChanges));
  assert.equal(ev.source, "app");
  const doc = await call("cbl_get_document", { collection: "shop.orders", id: "it-1" });
  assert.equal(doc.body.status, "brewing");
  assert.equal(typeof doc.body.startedAt, "number");
});

test("merge patch and errors surface cleanly", async () => {
  await call("cbl_put_document", { collection: "shop.orders", id: "it-2", mode: "merge", body: { note: "oat milk" } });
  const doc = await call("cbl_get_document", { collection: "shop.orders", id: "it-2" });
  assert.equal(doc.body.note, "oat milk");
  assert.equal(doc.body.customer, "Integration Ian");
  await assert.rejects(call("cbl_get_document", { collection: "shop.orders", id: "does-not-exist" }), /No document/);
  await assert.rejects(call("cbl_query", { sql: "SELEKT nonsense" }), /Error/);
});

test("reconnects transparently after the app restarts", async () => {
  adb("shell", "am", "force-stop", PKG);
  adb("shell", "am", "start", "-n", `${PKG}/.MainActivity`);
  await new Promise((r) => setTimeout(r, 3000));
  const info = await call("cbl_info");
  assert.equal(info.connected.package, PKG);
});
