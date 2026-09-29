# cblite-mcp tool reference

Published on npm as [`@couchbase-ecosystem/cblite-mcp`](https://www.npmjs.com/package/@couchbase-ecosystem/cblite-mcp):

```bash
claude mcp add cbl -- npx -y @couchbase-ecosystem/cblite-mcp
```

Environment variables:

| Variable | Effect |
|---|---|
| `ANDROID_SERIAL` | Only look for bridges on this device |
| `CBL_PACKAGE` | Connect to this app. If it isn't running and exactly one device is attached, it's launched |
| `CBL_MCP_READ_ONLY=1` | Don't register any write tools |
| `ADB` / `ANDROID_HOME` | Where to find `adb` (defaults to `adb` on `PATH`) |

Tools connect lazily: the first call finds the single running bridged app, or the one selected by the variables
above. After an app restart they reconnect by themselves.

| Tool | Purpose |
|---|---|
| `cbl_list_bridges` | Scan all adb devices for running apps that include the bridge |
| `cbl_connect(device?, package?)` | Choose an app explicitly (launches it if needed) |
| `cbl_info` | Couchbase Lite version, device clock, databases, collections with counts and indexes, replicators |
| `cbl_describe_collection(collection, sample?)` | Inferred schema: field paths, JSON types, frequency, examples, sample docs |
| `cbl_query(sql, parameters?, limit?)` | SQL++ (read-only) |
| `cbl_explain(sql)` | Query plan: does it use an index? |
| `cbl_get_document(collection, id)` | Body plus revision, sequence, expiration |
| `cbl_get_blob(collection, id, property, maxBytes?)` | Attachment as base64 |
| `cbl_list_indexes(collection)` | |
| `cbl_changes(since?, timeoutMs?, limit?)` | Change feed tagged `app` or `bridge`. With no `since` it continues from the previous call |
| `cbl_replicators` | Status of replicators the app registered |
| `cbl_put_document(collection, id?, body, mode?, expectedRevision?, createCollection?)` | Write one document (replace / merge patch / create) |
| `cbl_delete_document(collection, id, purge?)` | Delete (tombstone, replicates) or purge (local only) |
| `cbl_batch(collection?, operations[], createCollection?)` | Many writes in one transaction |
| `cbl_put_blob(collection, id, property, contentType, base64)` | |
| `cbl_create_collection` / `cbl_delete_collection` | |
| `cbl_create_index(collection, name, expressions[], type?, where?, language?, ignoreAccents?)` / `cbl_delete_index` | Value or full-text indexes |
| `cbl_replicator_control(name, action)` | Start/stop a registered replicator |

Read tools carry `readOnlyHint`; destructive ones carry `destructiveHint`, so MCP clients can gate them.

## Prompts that work well

- "What's in this app's database? How is an order structured?" → `cbl_info`, `cbl_describe_collection`
- "Seed 50 realistic users with edge cases: empty names, emoji, very long addresses" → `cbl_batch`
- "Tap Checkout (use mobile-mcp), then show me exactly what the app wrote" → `cbl_changes`, `cbl_get_document`
- "Is the query on the orders screen using an index?" → `cbl_explain`, then maybe `cbl_create_index`
- "Put the database back how you found it" → `cbl_batch` with `delete`/`purge`
