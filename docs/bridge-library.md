# cbl-bridge: the Android library

Package `io.github.cblmcp.bridge`, min SDK 24, no runtime dependencies. It compiles against Couchbase Lite with
`compileOnly`, so the app's own Couchbase Lite (CE or EE) is the one used at runtime.

## Integration

```bash
./gradlew :cbl-bridge:publishToMavenLocal   # from android/ in this repo -> io.github.cblmcp:cbl-bridge:0.1.0
```

```kotlin
// app/build.gradle.kts (add mavenLocal() to your repositories)
dependencies {
    debugImplementation("io.github.cblmcp:cbl-bridge:0.1.0")
}
```

```kotlin
// src/debug/java/<your package>/DebugHooks.kt
object DebugHooks {
    fun onDatabaseOpened(db: Database) = CblBridge.register(db)
    fun onReplicatorCreated(name: String, r: Replicator) = CblBridge.registerReplicator(name, r)
}
// src/release/java/<your package>/DebugHooks.kt: the same functions with empty bodies
```

Call `DebugHooks.onDatabaseOpened(database)` from main code right after you open the database. That's all the demo
app does (see `android/demo-app/src/main/java/.../BrewBoardApp.kt`).

### Optional manifest settings

```xml
<application>
    <meta-data android:name="cblbridge.readOnly" android:value="true" />   <!-- reject all writes (HTTP 403) -->
    <meta-data android:name="cblbridge.port" android:value="47111" />      <!-- first port tried; +9 fallbacks -->
    <meta-data android:name="cblbridge.autoStart" android:value="false" /> <!-- then call CblBridge.start(context) yourself -->
</application>
```

Put these in `src/debug/AndroidManifest.xml` so they only apply to debug builds.

### What it adds to a debug build

- `android.permission.INTERNET`. Couchbase Lite already declares it, so this changes nothing in practice.
- A non-exported `ContentProvider` (`${applicationId}.cblbridge-init`) that starts the server.
- `files/.cbl-bridge/bridge.json`: `{package, port, token, pid, bridgeVersion}`, rewritten on each process start.
- The log line `CblBridge: Couchbase Lite MCP bridge listening on 127.0.0.1:47111 for <package>`.

## HTTP API

Every endpoint except `/hello` needs `Authorization: Bearer <token>`. Bodies and responses are JSON. Errors come back
as `{"error": "...", "type": "...", "domain"?, "code"?}` with status 400/401/403/404/409/500.

Common fields: `database` (optional when the app has one database) and `collection` (`"scope.name"`, `"name"` for the
default scope, default `_default._default`).

| Endpoint | Body | Returns |
|---|---|---|
| `GET /hello` | – | `{bridge, bridgeVersion, package, pid, port}` |
| `GET /info` | – | Couchbase Lite version, `deviceTimeMs`, `deviceTimeZone`, `readOnly`, databases → collections (count, indexes), replicators, `changeSeq` |
| `POST /query` | `{sql, parameters?, limit?}` | `{rows, rowCount, truncated, elapsedMs}` |
| `POST /explain` | `{sql}` | `{plan}` |
| `POST /collection/describe` | `{collection, sample?}` | inferred `fields` (types, presentIn, example), `documentCount`, `indexes`, 3 `sampleDocuments` |
| `POST /collection/create` · `/collection/delete` | `{collection}` | |
| `POST /doc/get` | `{collection, id}` | `{id, revisionId, sequence, expiration, body}` |
| `POST /doc/put` | `{collection, id?, body, mode?: replace\|merge\|create, expectedRevision?, createCollection?}` | `{id, revisionId, created}` |
| `POST /doc/delete` | `{collection, id, purge?}` | |
| `POST /batch` | `{collection?, operations: [{op: put\|replace\|create\|merge\|delete\|purge, id?, body?, collection?}], createCollection?}` | all-or-nothing, in one `inBatch` |
| `POST /index/list` · `/index/create` · `/index/delete` | `{collection, name, type?: value\|fts, expressions, where?, language?, ignoreAccents?}` | |
| `POST /blob/get` | `{collection, id, property, maxBytes?}` | `{contentType, length, digest, base64}` |
| `POST /blob/put` | `{collection, id, property, contentType, base64}` | |
| `GET /changes` | query `since`, `timeoutMs` (≤60000), `limit` | `{lastSeq, events: [{seq, time, database, collection, source: app\|bridge, documentIds}], truncated}` |
| `GET /replicators` | – | activity, progress, error per registered replicator |
| `POST /replicator/start` · `/replicator/stop` | `{name, resetCheckpoint?}` | |

`scripts/bridge_smoke_test.py` exercises all of these. It's also a readable usage example.
