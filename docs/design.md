# Design notes

## The question: build an MCP, or just use adb?

An agent that builds or tests an Android app backed by Couchbase Lite needs to read and change the app's data.
There were three options:

| Approach | Reads | Writes | Running app sees changes? | Needs |
|---|---|---|---|---|
| `adb shell sqlite3` on `db.sqlite3` | ✗ bodies are binary Fleece blobs | ✗ triggers call LiteCore-only functions, so writes fail or corrupt data | – | root or `run-as` |
| `adb pull` + [`cblite` CLI](https://github.com/couchbaselabs/couchbase-mobile-tools) + `adb push` | ✓ snapshot | ✓ only with the app stopped | ✗ app must be restarted; live queries/listeners never fire | `run-as` + host binary |
| **In-app bridge + MCP (this repo)** | ✓ live | ✓ live, transactional | ✓ immediately, through the app's own `Database` | `run-as` (debug build) |

Couchbase's own wiki says `sqlite3` "isn't very useful, even with the knowledge found below, because (a) most of
the interesting data is encoded in binary formats, and (b) most mutating operations will fail because they
invoke triggers that use custom functions not available outside LiteCore"
([Database Schema](https://github.com/couchbase/couchbase-lite-core/wiki/Database-Schema)).

The pull/push route is fine for inspecting a snapshot, but it misses the loop that matters when an agent works
on an app: *change data → watch the UI react → act in the UI → verify what the app wrote*. The bridge supports
that loop, and the change feed tags every change as written by the `app` or by the agent (`bridge`).

The official [Couchbase MCP server](https://github.com/couchbase/mcp-server-couchbase) targets Couchbase Server
and Capella, not Couchbase Lite. For apps that sync, writing to the server and letting Sync Gateway replicate
down is an alternative, but it's slower and can't reach local-only data.

## Architecture

- **Transport.** The bridge is a ~160-line HTTP/1.1 server (`MiniHttpServer`) bound to `127.0.0.1`,
  one request per connection, JSON bodies, no dependencies. The MCP server reaches it with `adb forward tcp:0 tcp:<port>`.
- **Startup.** A `ContentProvider` (`BridgeInitProvider`, `initOrder=-100`) starts the server before
  `Application.onCreate()`, the same way LeakCanary does. So adding the dependency is enough, and databases can be
  registered at any later point.
- **Which database.** `CblBridge.register(db)` makes the bridge use the app's own instance, so change listeners,
  live queries and replicators all see agent writes. Without registration the bridge scans `filesDir/*.cblite2`
  and opens a second instance lazily (see limitations).
- **Discovery.** The MCP server probes device ports 47111–47120 with `GET /hello` (unauthenticated; returns
  package + pid only), then reads `files/.cbl-bridge/bridge.json` (port + token) via `adb exec-out run-as <pkg> cat`.
- **Restarts.** A 401 or connection error triggers one transparent reconnect: new pid, new token, new port forward.
- **Change feed.** Collection change listeners fill a 2,000-event ring buffer. `/changes?since=N&timeoutMs=T`
  long-polls. The MCP server keeps a cursor, so `cbl_changes` with no arguments means "what changed since I last
  looked". Writes made through the bridge record `(collection, docId)` first, so the matching change event is
  attributed to `bridge`; every other change is attributed to `app`.
- **Writes.** `replace` edits the existing document with `toMutable().setData()` so revision history stays intact.
  `merge` is RFC 7396 JSON Merge Patch. `create` fails on an existing id. `expectedRevision` gives optimistic
  concurrency (HTTP 409). `/batch` runs in `Database.inBatch`, so one failure rolls everything back and live
  queries fire once.
- **Schema inference.** `/collection/describe` samples N documents with SQL++ and reports each field path (up to 4
  levels deep) with its JSON types, how many documents have it, and an example. This is how the agent in the demo
  matched the app's schema without seeing its source.
- **Clock.** `/info` returns `deviceTimeMs` and `deviceTimeZone`, so an agent without shell access can write
  realistic timestamps.

## Limitations

- **Debug builds only.** `run-as` needs `android:debuggable`. That's intentional, but it means production builds
  on a real user's phone are out of reach.
- **Change attribution is a heuristic.** It matches document ids written by the bridge within the last 5 seconds.
  If the app rewrites the same document inside that window, the event can be labelled `bridge`.
- **Unregistered databases** are opened as a second `Database` instance. Reads and writes on that path were
  tested manually; I haven't verified that the app's live queries fire for writes made through a second instance. Register the instance to be
  safe. Encrypted (EE) databases can only be reached through registration, because the bridge doesn't know the key.
- **Blobs inside `body`** (`{"@type": "blob", ...}`) aren't converted into Blobs on write. Use `cbl_put_blob`.
- **Replicator tools** (`cbl_replicators`, `cbl_replicator_control`) are implemented but untested: the demo app has
  no Sync Gateway.
- **Versions.** Built and tested only with Couchbase Lite CE 4.1.2 on an Android 14 (API 34) emulator. The library
  compiles against 4.1.2 with `compileOnly`. 3.2 shares the collection APIs, but partial indexes (`where`) need 4.0+.
  3.x is untested.
- **mobile-mcp conflict.** mobile-mcp leaves a `com.mobilenext.mobilecli.DeviceServer` process that holds the
  device's single UiAutomation connection, so a later `uiautomator dump` crashes with "UiAutomationService already
  registered". The integration test kills that process before it taps.
- **Leaked port forwards.** If the MCP server is killed hard (e.g. its client exits), the `adb forward` it created
  stays behind until adb restarts or you run `adb forward --remove-all`. Harmless, but it accumulates.
- **NUL characters are refused.** Couchbase Lite for Android (4.1.2) silently truncates strings and property names
  at U+0000 when saving (`"ab\u0000cd"` is stored as `"ab"`, confirmed with SQL++ `LENGTH()`). The bridge returns
  400 instead of storing corrupted data. Worth reporting upstream. Empty property names (`""`) are also rejected, by
  Couchbase Lite itself.
- **Doze + background.** When the device is in Doze and the app is in the background, Android can block the app's
  network, localhost included, and the device's own shell commands stall. The MCP server tries to recover by
  bringing the app to the foreground and otherwise fails within about 40 s with a hint. A phone connected over USB is
  charging, so it doesn't enter Doze in normal use; this mostly matters for wireless adb.
- **adb forwarding has limits.** Thousands of back-to-back connections through one `adb forward` can knock the
  forward over, on the emulator in particular. Normal agent traffic is nowhere near that.
- **No iOS.** A Swift bridge using the same HTTP contract would let the same MCP server work over
  `iproxy`/`devicectl`. Not built.
