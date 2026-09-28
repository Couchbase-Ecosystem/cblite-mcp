#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BridgeClient, BridgeError } from "./bridge.js";

const READ_ONLY = /^(1|true|yes)$/i.test(process.env.CBL_MCP_READ_ONLY ?? "");
const client = new BridgeClient();

const server = new McpServer(
  { name: "cbl-mcp", version: "0.1.0" },
  {
    instructions:
      "Tools for the live Couchbase Lite database inside a running Android app (debug build with the cbl-bridge library). " +
      "Writes go through the app's own Database instance, so the app's live queries and UI update immediately. " +
      "Start with cbl_info, then cbl_describe_collection to learn a collection's schema before writing documents. " +
      "Collections are named 'scope.collection' (e.g. 'shop.orders'); SQL++ queries use the same names (FROM shop.orders). " +
      "Use cbl_changes to see what the app itself changed, e.g. after driving the UI with another tool.",
  },
);

type Json = Record<string, unknown>;

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(e: unknown) {
  const msg = e instanceof BridgeError ? e.message : e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

async function run(fn: () => Promise<unknown>) {
  try {
    return ok(await fn());
  } catch (e) {
    return fail(e);
  }
}

const database = z.string().optional().describe("Database name. Optional when the app has exactly one database.");
const collection = z.string().describe("Collection as 'scope.collection' (e.g. 'shop.orders'), or just 'name' for the default scope.");
const docBody = z.record(z.string(), z.any()).describe("The document's JSON body (without the id).");

// ------------------------------------------------------------------ connection & discovery

server.registerTool(
  "cbl_list_bridges",
  {
    title: "List bridged apps",
    description: "Scan every adb-connected device/emulator for running apps that include the Couchbase Lite bridge.",
    annotations: { readOnlyHint: true },
  },
  async () => run(async () => ({ bridges: await client.discover(null), connected: client.connection ?? null })),
);

server.registerTool(
  "cbl_connect",
  {
    title: "Connect to an app",
    description:
      "Connect to the bridge in a specific app/device. Usually unnecessary: other tools auto-connect when exactly one bridged app is running. " +
      "If the package is given but not running, the app is launched first.",
    inputSchema: {
      device: z.string().optional().describe("adb serial, e.g. emulator-5554"),
      package: z.string().optional().describe("Android application id, e.g. com.example.app"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ device, package: pkg }) =>
    run(async () => {
      await client.connect({ device, package: pkg });
      return { connected: client.connection, info: await client.call("/info") };
    }),
);

server.registerTool(
  "cbl_info",
  {
    title: "Database overview",
    description: "Couchbase Lite version, device clock (deviceTimeMs, for writing timestamps), databases, every scope/collection with document counts and indexes, and registered replicators.",
    annotations: { readOnlyHint: true },
  },
  async () =>
    run(async () => {
      const info = await client.call("/info");
      return { connected: client.connection, ...info };
    }),
);

server.registerTool(
  "cbl_describe_collection",
  {
    title: "Describe collection schema",
    description:
      "Sample documents from a collection and infer its schema: every field path with its JSON types, how many sampled docs have it, and an example value. " +
      "Also returns a few full sample documents. Use this before writing documents so new data matches what the app expects.",
    inputSchema: { database, collection, sample: z.number().int().min(1).max(1000).optional().describe("Documents to sample (default 50)") },
    annotations: { readOnlyHint: true },
  },
  async (a) => run(() => client.call("/collection/describe", a)),
);

// ------------------------------------------------------------------ queries

server.registerTool(
  "cbl_query",
  {
    title: "Run SQL++ query",
    description:
      "Run a Couchbase Lite SQL++ query against the live database. Name collections as scope.collection (FROM shop.orders AS o). " +
      "Use META(o).id for document ids and $name placeholders with `parameters`. Supports WHERE, JOIN, GROUP BY, ORDER BY, array functions (ARRAY_LENGTH, ARRAY_CONTAINS, ANY ... SATISFIES; no UNNEST), " +
      "aggregates and full-text MATCH(). Read-only: SQL++ in Couchbase Lite has no INSERT/UPDATE/DELETE, use the document tools for writes.",
    inputSchema: {
      database,
      sql: z.string().describe("SQL++ query"),
      parameters: z.record(z.string(), z.any()).optional().describe("Values for $placeholders, without the $"),
      limit: z.number().int().min(1).max(5000).optional().describe("Max rows returned (default 100); rowCount always reports the full count"),
    },
    annotations: { readOnlyHint: true },
  },
  async (a) => run(() => client.call("/query", a)),
);

server.registerTool(
  "cbl_explain",
  {
    title: "Explain query plan",
    description: "Show the SQLite query plan for a SQL++ query, to check whether it uses an index or scans the collection.",
    inputSchema: { database, sql: z.string() },
    annotations: { readOnlyHint: true },
  },
  async (a) => run(() => client.call("/explain", a)),
);

// ------------------------------------------------------------------ documents

server.registerTool(
  "cbl_get_document",
  {
    title: "Get document",
    description: "Fetch one document by id, with its revision id, sequence and expiration.",
    inputSchema: { database, collection, id: z.string() },
    annotations: { readOnlyHint: true },
  },
  async (a) => run(() => client.call("/doc/get", a)),
);

server.registerTool(
  "cbl_get_blob",
  {
    title: "Get blob",
    description: "Read a blob (attachment) stored in a document property. Returns content type, size, digest and base64 content (if under maxBytes).",
    inputSchema: { database, collection, id: z.string(), property: z.string(), maxBytes: z.number().int().optional() },
    annotations: { readOnlyHint: true },
  },
  async (a) => run(() => client.call("/blob/get", a)),
);

server.registerTool(
  "cbl_list_indexes",
  {
    title: "List indexes",
    description: "List the indexes defined on a collection.",
    inputSchema: { database, collection },
    annotations: { readOnlyHint: true },
  },
  async (a) => run(() => client.call("/index/list", a)),
);

server.registerTool(
  "cbl_changes",
  {
    title: "Watch changes",
    description:
      "Documents changed in the app's database, in order. Each event says which collection and document ids changed and whether the change came from " +
      "this agent ('bridge') or from the app itself ('app', e.g. a user tapping a button). Without `since`, returns everything since your previous " +
      "cbl_changes call (or since connecting). Set timeoutMs to wait for the next change, e.g. right after tapping something in the UI.",
    inputSchema: {
      since: z.number().int().optional().describe("Sequence to read after; omit to continue from the last call"),
      timeoutMs: z.number().int().min(0).max(60000).optional().describe("Wait up to this long for a change (default 0)"),
      limit: z.number().int().min(1).max(2000).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ since, timeoutMs, limit }) => run(() => client.changes(since, timeoutMs ?? 0, limit ?? 200)),
);

server.registerTool(
  "cbl_replicators",
  {
    title: "Replicator status",
    description: "Status of replicators the app registered with the bridge (activity level, progress, last error).",
    annotations: { readOnlyHint: true },
  },
  async () => run(() => client.call("/replicators")),
);

if (!READ_ONLY) {
  server.registerTool(
    "cbl_put_document",
    {
      title: "Write document",
      description:
        "Create or update one document through the app's live Database, so the app's UI and listeners react immediately. " +
        "mode 'replace' (default) sets the whole body; 'merge' applies a JSON Merge Patch (nested objects merge, null deletes a field); " +
        "'create' fails if the id exists. Omit id to let Couchbase Lite generate one. Pass expectedRevision for optimistic concurrency.",
      inputSchema: {
        database,
        collection,
        id: z.string().optional(),
        body: docBody,
        mode: z.enum(["replace", "merge", "create"]).optional(),
        expectedRevision: z.string().optional(),
        createCollection: z.boolean().optional().describe("Create the collection if it doesn't exist"),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async (a) => run(() => client.call("/doc/put", a)),
  );

  server.registerTool(
    "cbl_delete_document",
    {
      title: "Delete document",
      description:
        "Delete a document. A normal delete leaves a tombstone that replicates to the server; purge=true removes it locally without replicating the deletion.",
      inputSchema: { database, collection, id: z.string(), purge: z.boolean().optional() },
      annotations: { destructiveHint: true },
    },
    async (a) => run(() => client.call("/doc/delete", a)),
  );

  server.registerTool(
    "cbl_batch",
    {
      title: "Batch write",
      description:
        "Apply many writes in a single Couchbase Lite transaction (inBatch): all succeed or none do, and the app's live queries fire once. " +
        "Ideal for seeding test data. Each operation: {op: 'put'|'create'|'merge'|'delete'|'purge', id?, body?, collection?}.",
      inputSchema: {
        database,
        collection: collection.optional().describe("Default collection for operations that don't name one"),
        operations: z
          .array(
            z.object({
              op: z.enum(["put", "replace", "create", "merge", "delete", "purge"]),
              id: z.string().optional(),
              body: z.record(z.string(), z.any()).optional(),
              collection: z.string().optional(),
            }),
          )
          .min(1)
          .max(10000),
        createCollection: z.boolean().optional(),
      },
      annotations: { destructiveHint: true },
    },
    async (a) => run(() => client.call("/batch", a, 120_000)),
  );

  server.registerTool(
    "cbl_put_blob",
    {
      title: "Write blob",
      description: "Attach binary content (base64) to a document property as a Couchbase Lite blob.",
      inputSchema: { database, collection, id: z.string(), property: z.string(), contentType: z.string(), base64: z.string() },
      annotations: { destructiveHint: true },
    },
    async (a) => run(() => client.call("/blob/put", a)),
  );

  server.registerTool(
    "cbl_create_collection",
    {
      title: "Create collection",
      description: "Create a collection (and its scope if needed).",
      inputSchema: { database, collection },
    },
    async (a) => run(() => client.call("/collection/create", a)),
  );

  server.registerTool(
    "cbl_delete_collection",
    {
      title: "Delete collection",
      description: "Delete a collection and all of its documents. Irreversible.",
      inputSchema: { database, collection },
      annotations: { destructiveHint: true },
    },
    async (a) => run(() => client.call("/collection/delete", a)),
  );

  server.registerTool(
    "cbl_create_index",
    {
      title: "Create index",
      description:
        "Create a value index (type 'value', expressions are SQL++ expressions like 'status' or 'address.city') or a full-text index (type 'fts') for MATCH() queries.",
      inputSchema: {
        database,
        collection,
        name: z.string(),
        type: z.enum(["value", "fts"]).optional(),
        expressions: z.array(z.string()).min(1),
        where: z.string().optional().describe("Partial index condition (Couchbase Lite 4.0+)"),
        language: z.string().optional().describe("FTS language, e.g. 'en'"),
        ignoreAccents: z.boolean().optional(),
      },
    },
    async (a) => run(() => client.call("/index/create", a)),
  );

  server.registerTool(
    "cbl_delete_index",
    {
      title: "Delete index",
      description: "Delete an index from a collection.",
      inputSchema: { database, collection, name: z.string() },
      annotations: { destructiveHint: true },
    },
    async (a) => run(() => client.call("/index/delete", a)),
  );

  server.registerTool(
    "cbl_replicator_control",
    {
      title: "Start/stop replicator",
      description: "Start or stop a replicator the app registered with the bridge.",
      inputSchema: {
        name: z.string(),
        action: z.enum(["start", "stop"]),
        resetCheckpoint: z.boolean().optional(),
      },
    },
    async ({ name, action, resetCheckpoint }) =>
      run(() => client.call(action === "start" ? "/replicator/start" : "/replicator/stop", { name, resetCheckpoint } as Json)),
  );
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const shutdown = async () => {
    await client.disconnect().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
