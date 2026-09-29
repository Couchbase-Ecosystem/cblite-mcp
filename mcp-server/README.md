# @couchbase-ecosystem/cblite-mcp

MCP server that gives AI agents a live window into the **Couchbase Lite database inside a running Android app**:
inspect, query (SQL++), seed and edit data through the app's own `Database` instance, so the UI updates as the
agent works.

It pairs with **cbl-bridge**, a tiny debug-only Android library you add to your app with `debugImplementation`.

```bash
claude mcp add cbl -- npx -y @couchbase-ecosystem/cblite-mcp
```

```json
{ "mcpServers": { "cbl": { "command": "npx", "args": ["-y", "@couchbase-ecosystem/cblite-mcp"] } } }
```

Requires Node.js 20+ and `adb`. Environment variables: `ANDROID_SERIAL`, `CBL_PACKAGE`, `CBL_MCP_READ_ONLY=1`,
`CBL_MCP_DEBUG=1`.

**Full guide** (adding the library to your app, the 20 tools, the demo app, troubleshooting):
https://github.com/Couchbase-Ecosystem/cblite-mcp#readme

MIT licensed.
