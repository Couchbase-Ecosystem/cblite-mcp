# Couchbase Lite MCP

Let an AI agent query, seed and edit the **live Couchbase Lite database inside a running Android app**,
while the app's UI reacts in real time.

**Demo video:** [`demo/cbl-mcp-demo.mp4`](demo/cbl-mcp-demo.mp4) (3 min, a real, unedited agent session)

```
┌──────────── your machine ────────────┐        ┌──────── Android device / emulator (debug build) ────────┐
│ Claude Code / any MCP client         │        │                                                         │
│      │ MCP (stdio)                   │  adb   │  cbl-bridge  ──►  Couchbase Lite  ──►  App UI           │
│   cbl-mcp  ─────────────────────────────forward──► 127.0.0.1      (the app's own        (live queries   │
│      (Node, 20 tools)                │        │   + token         Database)             re-render)      │
│   mobile-mcp (optional, taps the UI) ─────────────────────────────────────────────────────►             │
└──────────────────────────────────────┘        └─────────────────────────────────────────────────────────┘
```

Three pieces:

| Piece | What it is |
|---|---|
| [`android/cbl-bridge`](android/cbl-bridge) | Tiny Android library (no dependencies) added with `debugImplementation`. Starts a token-protected HTTP server on `127.0.0.1` inside the app and serves the app's own `Database` instance. |
| [`mcp-server`](mcp-server) | Node MCP server (`cbl-mcp`). Finds bridged apps over adb, reads the token with `run-as`, forwards a port and exposes 20 tools. |
| [`android/demo-app`](android/demo-app) | **Brew Board**, a Jetpack Compose coffee-shop order board on Couchbase Lite 4.1 with live queries. Used in the demo video. |

## Why not just adb?

Couchbase Lite stores documents as binary Fleece blobs inside SQLite, so `adb shell sqlite3` can't read or
safely write them. You can `adb pull` the `.cblite2` folder and use the `cblite` CLI, but writes then need
the app stopped, the file pushed back and the app restarted, and the running UI never sees the change.
The bridge writes **through the app's live `Database`**: live queries fire, the UI updates, replication
treats the edit like any local change, and nothing restarts. See [docs/design.md](docs/design.md) for the
full comparison.

## Quick start

**1. Add the bridge to your app's debug build** (`app/build.gradle.kts`):

```kotlin
dependencies {
    implementation("com.couchbase.lite:couchbase-lite-android-ktx:4.1.2")   // what you already have
    debugImplementation(project(":cbl-bridge"))                               // or the published artifact
}
```

It starts automatically. It can then find any database in the app's `files/` directory, but for full fidelity
(the UI reacting to the agent's writes) hand it the instance your app already has open. Do that from a
debug-only source file:

```kotlin
// src/debug/java/.../DebugHooks.kt
object DebugHooks { fun onDatabaseOpened(db: Database) = CblBridge.register(db) }

// src/release/java/.../DebugHooks.kt
object DebugHooks { fun onDatabaseOpened(db: Database) = Unit }
```

Release builds don't contain the bridge classes, its ContentProvider or its server. This was checked on the
demo's release APK.

**2. Build the MCP server and register it:**

```bash
cd mcp-server && npm install && npm run build
claude mcp add cbl -- node "$PWD/dist/index.js"
# optional: pin a device / app
claude mcp add cbl -e ANDROID_SERIAL=emulator-5554 -e CBL_PACKAGE=com.example.app -- node "$PWD/dist/index.js"
```

**3. Run your debug build and ask:** *"What's in this app's database?"*, *"Seed 20 realistic orders"*,
*"Tap Checkout and verify the order document the app wrote"*.

## Tools

| Read | Write (hidden when `CBL_MCP_READ_ONLY=1`) |
|---|---|
| `cbl_list_bridges`, `cbl_connect`, `cbl_info` | `cbl_put_document` (replace / JSON merge patch / create, optimistic concurrency) |
| `cbl_describe_collection`: infers schema by sampling | `cbl_delete_document` (delete or purge) |
| `cbl_query` (SQL++ with `$params`), `cbl_explain` | `cbl_batch`: many writes in one transaction |
| `cbl_get_document`, `cbl_get_blob` | `cbl_put_blob` |
| `cbl_list_indexes` | `cbl_create_collection`, `cbl_delete_collection` |
| `cbl_changes`: change feed; each change is tagged as written by the **app** or the **agent** | `cbl_create_index` (value / full-text), `cbl_delete_index` |
| `cbl_replicators` | `cbl_replicator_control` |

Full reference: [docs/mcp-tools.md](docs/mcp-tools.md). Library and HTTP API: [docs/bridge-library.md](docs/bridge-library.md).

## Security model

- The bridge only exists in builds that include it (`debugImplementation`), and only listens on `127.0.0.1`.
- Every request except `/hello` needs a random per-process token. The token is stored in the app's private
  `files/` directory, so reading it takes `adb run-as`, which works only on debuggable builds. Other apps on
  the device can reach the port but not the token.
- `cblbridge.readOnly` manifest meta-data (bridge side) and `CBL_MCP_READ_ONLY=1` (MCP side) turn off writes.

## The demo

`demo/record_demo.py` runs six plain-English prompts through headless Claude Code (`claude -p`, Opus 5.5) with
only the `cbl` and `mobile` MCP servers enabled. Shell, file and web tools are disabled, so the agent works
purely through MCP. The emulator screen is recorded at the same time. `demo/render_prep.py` and the Remotion
project in `demo/video` turn the run into the video. Idle model-thinking time is shown at 4× and reading pauses
are added, both labelled on screen. The whole six-step session cost $0.52. Details: [docs/demo.md](docs/demo.md).

## Tests

```bash
scripts/bridge_smoke_test.py            # 17 checks against the bridge's HTTP API (needs the demo app running)
cd mcp-server && npm test               # 6 end-to-end MCP tests incl. a real UI tap attributed to the app
```

Both pass against Brew Board on an API 34 emulator with Couchbase Lite CE 4.1.2.

## Status & limitations

v0.1, built and tested in one session. Known gaps are listed in [docs/design.md#limitations](docs/design.md#limitations).
