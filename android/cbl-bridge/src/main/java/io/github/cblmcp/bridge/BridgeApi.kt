package io.github.cblmcp.bridge

import android.util.Base64
import android.util.Log
import com.couchbase.lite.Blob
import com.couchbase.lite.Collection
import com.couchbase.lite.CouchbaseLite
import com.couchbase.lite.CouchbaseLiteException
import com.couchbase.lite.Database
import com.couchbase.lite.FullTextIndexConfiguration
import com.couchbase.lite.MutableDocument
import com.couchbase.lite.Parameters
import com.couchbase.lite.ValueIndexConfiguration
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ConcurrentHashMap

internal class ApiException(val status: Int, message: String) : Exception(message)

/** Routes bridge HTTP requests onto the Couchbase Lite API. Every body and response is JSON. */
internal class BridgeApi(private val bridge: CblBridge) {
    /** Databases the app never registered but that exist on disk; opened lazily by name. */
    private val discovered = ConcurrentHashMap<String, Database>()

    fun handle(req: HttpRequest, token: String): HttpResponse {
        if (req.path == "/hello") return ok(hello())
        val auth = req.headers["authorization"]?.removePrefix("Bearer ")?.trim() ?: req.headers["x-bridge-token"]
        if (auth != token) return HttpResponse(401, """{"error":"missing or invalid bridge token"}""")
        return try {
            val body = if (req.body.isBlank()) JSONObject() else JSONObject(req.body)
            ok(route(req, body))
        } catch (e: ApiException) {
            HttpResponse(e.status, jsonOf("error" to e.message).toString())
        } catch (e: CouchbaseLiteException) {
            HttpResponse(400, errorJson(e))
        } catch (e: org.json.JSONException) {
            HttpResponse(400, jsonOf("error" to "Invalid JSON: ${e.message}").toString())
        } catch (e: Exception) {
            Log.w(TAG, "${req.method} ${req.path} failed", e)
            HttpResponse(500, errorJson(e))
        }
    }

    private fun ok(obj: JSONObject) = HttpResponse(200, obj.toString())

    private fun route(req: HttpRequest, b: JSONObject): JSONObject = when (req.path) {
        "/info" -> info()
        "/query" -> query(b)
        "/explain" -> jsonOf("plan" to db(b).createQuery(b.getString("sql")).explain())
        "/collection/describe" -> describe(b)
        "/collection/create" -> write { createCollection(b) }
        "/collection/delete" -> write { deleteCollection(b) }
        "/doc/get" -> getDoc(b)
        "/doc/put" -> write { putDoc(b) }
        "/doc/delete" -> write { deleteDoc(b) }
        "/batch" -> write { batch(b) }
        "/index/list" -> listIndexes(b)
        "/index/create" -> write { createIndex(b) }
        "/index/delete" -> write { deleteIndex(b) }
        "/blob/get" -> getBlob(b)
        "/blob/put" -> write { putBlob(b) }
        "/changes" -> changes(req)
        "/replicators" -> replicators()
        "/replicator/start" -> write { replicatorControl(b, start = true) }
        "/replicator/stop" -> write { replicatorControl(b, start = false) }
        else -> throw ApiException(404, "Unknown endpoint ${req.path}")
    }

    private inline fun write(block: () -> JSONObject): JSONObject {
        if (bridge.readOnly) throw ApiException(403, "Bridge is in read-only mode (cblbridge.readOnly=true)")
        return block()
    }

    // ---------------------------------------------------------------- discovery

    private fun hello() = jsonOf(
        "bridge" to "cbl-mcp-bridge",
        "bridgeVersion" to BuildConfig.BRIDGE_VERSION,
        "package" to bridge.appContext?.packageName,
        "pid" to android.os.Process.myPid(),
        "port" to bridge.port,
    )

    private fun info(): JSONObject {
        val dbs = JSONArray()
        for ((name, db) in allDatabases()) {
            val cols = JSONArray()
            for (c in db.allCollections().sortedBy { it.fullName }) {
                bridge.changes.watch(name, c)
                cols.put(
                    jsonOf(
                        "scope" to c.scope.name,
                        "name" to c.name,
                        "fullName" to c.fullName,
                        "count" to c.count,
                        "indexes" to JSONArray(c.indexes.sorted()),
                    ),
                )
            }
            dbs.put(
                jsonOf(
                    "name" to name,
                    "path" to db.path,
                    "registeredByApp" to bridge.databases.containsKey(name),
                    "collections" to cols,
                ),
            )
        }
        for (name in onDiskNames() - allDatabases().keys) {
            dbs.put(jsonOf("name" to name, "registeredByApp" to false, "opened" to false))
        }
        val info = hello()
        info.put("couchbaseLiteVersion", cblVersion())
        // Agents need "now" in the device's clock to write realistic timestamps.
        info.put("deviceTimeMs", System.currentTimeMillis())
        info.put("deviceTimeZone", java.util.TimeZone.getDefault().id)
        info.put("readOnly", bridge.readOnly)
        info.put("databases", dbs)
        info.put("replicators", JSONArray(bridge.replicators.keys.sorted()))
        info.put("changeSeq", bridge.changes.currentSeq())
        return info
    }

    private fun cblVersion(): String? = runCatching {
        Class.forName("com.couchbase.lite.BuildConfig").getField("VERSION_NAME").get(null) as String
    }.getOrNull()

    private fun allDatabases(): Map<String, Database> = bridge.databases + discovered.filterKeys { !bridge.databases.containsKey(it) }

    private fun onDiskNames(): Set<String> {
        val dir = bridge.appContext?.filesDir ?: return emptySet()
        return dir.listFiles { f: File -> f.isDirectory && f.name.endsWith(".cblite2") }
            ?.map { it.name.removeSuffix(".cblite2") }?.toSet() ?: emptySet()
    }

    private fun db(b: JSONObject): Database {
        val requested = b.optString("database").ifEmpty { null }
        val known = allDatabases()
        if (requested == null) {
            if (known.size == 1) return known.values.first()
            val names = (known.keys + onDiskNames()).sorted()
            if (names.size == 1) return openDiscovered(names[0])
            throw ApiException(400, "Specify 'database'. Available: $names")
        }
        return known[requested] ?: openDiscovered(requested)
    }

    private fun openDiscovered(name: String): Database {
        discovered[name]?.let { return it }
        if (name !in onDiskNames()) throw ApiException(404, "No database named '$name'. Available: ${(allDatabases().keys + onDiskNames()).sorted()}")
        synchronized(discovered) {
            discovered[name]?.let { return it }
            bridge.appContext?.let { ctx -> runCatching { CouchbaseLite.init(ctx) } }
            val db = Database(name)
            db.allCollections().forEach { bridge.changes.watch(name, it) }
            discovered[name] = db
            return db
        }
    }

    /** Accepts "orders", "shop.orders" or "_default". */
    private fun collection(db: Database, b: JSONObject, create: Boolean = false): Collection {
        val spec = b.optString("collection").ifEmpty { "_default._default" }
        val dot = spec.indexOf('.')
        val scope = if (dot >= 0) spec.substring(0, dot) else "_default"
        val name = if (dot >= 0) spec.substring(dot + 1) else spec
        val c = db.getCollection(name, scope)
            ?: if (create) db.createCollection(name, scope) else throw ApiException(404, "No collection '$scope.$name' in '${db.name}'")
        bridge.changes.watch(db.name, c)
        return c
    }

    // ---------------------------------------------------------------- queries

    private fun query(b: JSONObject): JSONObject {
        val db = db(b)
        val limit = b.optInt("limit", 100).coerceIn(1, 5000)
        val started = System.nanoTime()
        val q = db.createQuery(b.getString("sql"))
        b.optJSONObject("parameters")?.let { p ->
            val params = Parameters()
            for (k in p.keys()) params.setValue(k, jsonToNative(p.get(k)))
            q.parameters = params
        }
        val rows = JSONArray()
        var total = 0
        q.execute().use { rs ->
            for (r in rs) {
                total++
                if (rows.length() < limit) rows.put(JSONObject(r.toJSON()))
            }
        }
        return jsonOf(
            "rows" to rows,
            "rowCount" to total,
            "truncated" to (total > rows.length()),
            "elapsedMs" to (System.nanoTime() - started) / 1_000_000.0,
        )
    }

    /** Samples documents and infers a field -> types summary so an agent can learn the schema cheaply. */
    private fun describe(b: JSONObject): JSONObject {
        val db = db(b)
        val c = collection(db, b)
        val sample = b.optInt("sample", 50).coerceIn(1, 1000)
        val fields = sortedMapOf<String, MutableMap<String, Int>>()
        val examples = mutableMapOf<String, Any?>()
        val docs = JSONArray()
        val sql = "SELECT META(c).id AS id, c AS doc FROM `${c.scope.name}`.`${c.name}` AS c LIMIT $sample"
        var seen = 0
        db.createQuery(sql).execute().use { rs ->
            for (r in rs) {
                seen++
                val doc = JSONObject(r.toJSON()).optJSONObject("doc") ?: continue
                collectFields("", doc, fields, examples)
                if (docs.length() < 3) docs.put(jsonOf("id" to r.getString("id"), "body" to doc))
            }
        }
        val schema = JSONObject()
        for ((path, types) in fields) {
            schema.put(
                path,
                jsonOf(
                    "types" to JSONObject(types as Map<*, *>),
                    "presentIn" to types.values.sum(),
                    "example" to examples[path],
                ),
            )
        }
        return jsonOf(
            "collection" to c.fullName,
            "documentCount" to c.count,
            "sampled" to seen,
            "fields" to schema,
            "indexes" to JSONArray(c.indexes.sorted()),
            "sampleDocuments" to docs,
        )
    }

    private fun collectFields(prefix: String, obj: JSONObject, fields: MutableMap<String, MutableMap<String, Int>>, examples: MutableMap<String, Any?>) {
        for (key in obj.keys()) {
            val path = if (prefix.isEmpty()) key else "$prefix.$key"
            val v = obj.get(key)
            val type = when (v) {
                JSONObject.NULL -> "null"
                is JSONObject -> if (v.optString("@type") == "blob") "blob" else "object"
                is JSONArray -> "array"
                is String -> "string"
                is Boolean -> "boolean"
                is Number -> "number"
                else -> v.javaClass.simpleName
            }
            val counts = fields.getOrPut(path) { mutableMapOf() }
            counts[type] = (counts[type] ?: 0) + 1
            if (path !in examples && type != "object") {
                examples[path] = if (v is JSONArray && v.length() > 3) JSONArray().apply { for (i in 0 until 3) put(v.get(i)) } else v
            }
            if (v is JSONObject && type == "object" && prefix.count { it == '.' } < 3) collectFields(path, v, fields, examples)
        }
    }

    // ---------------------------------------------------------------- documents

    private fun docJson(doc: com.couchbase.lite.Document, c: Collection) = jsonOf(
        "id" to doc.id,
        "collection" to c.fullName,
        "revisionId" to doc.revisionID,
        "sequence" to doc.sequence,
        "expiration" to c.getDocumentExpiration(doc.id)?.time,
        "body" to JSONObject(doc.toJSON()),
    )

    private fun getDoc(b: JSONObject): JSONObject {
        val db = db(b)
        val c = collection(db, b)
        val id = b.getString("id")
        val doc = c.getDocument(id) ?: throw ApiException(404, "No document '$id' in ${c.fullName}")
        return docJson(doc, c)
    }

    private fun putDoc(b: JSONObject): JSONObject {
        val db = db(b)
        val c = collection(db, b, create = b.optBoolean("createCollection", false))
        return saveOne(db, c, b.optString("id").ifEmpty { null }, b.getJSONObject("body"), b.optString("mode", "replace"), b.optString("expectedRevision").ifEmpty { null })
    }

    private fun saveOne(db: Database, c: Collection, id: String?, body: JSONObject, mode: String, expectedRevision: String?): JSONObject {
        val existing = id?.let { c.getDocument(it) }
        if (expectedRevision != null && existing?.revisionID != expectedRevision) {
            throw ApiException(409, "Revision mismatch for '$id': expected $expectedRevision, found ${existing?.revisionID}")
        }
        val doc: MutableDocument = when (mode) {
            "create" -> {
                if (existing != null) throw ApiException(409, "Document '$id' already exists in ${c.fullName}")
                if (id == null) MutableDocument(body.toNativeMap()) else MutableDocument(id, body.toNativeMap())
            }
            "merge" -> {
                if (existing == null) throw ApiException(404, "Cannot merge: no document '$id' in ${c.fullName}")
                @Suppress("UNCHECKED_CAST")
                val merged = mergePatch(existing.toMap(), body.toNativeMap()) as Map<String, Any?>
                existing.toMutable().setData(merged)
            }
            "replace" -> when {
                existing != null -> existing.toMutable().setData(body.toNativeMap())
                id != null -> MutableDocument(id, body.toNativeMap())
                else -> MutableDocument(body.toNativeMap())
            }
            else -> throw ApiException(400, "mode must be replace, merge or create")
        }
        bridge.changes.markBridgeWrite(db.name, c, doc.id)
        c.save(doc)
        val saved = c.getDocument(doc.id)!!
        return jsonOf("id" to saved.id, "collection" to c.fullName, "revisionId" to saved.revisionID, "created" to (existing == null))
    }

    /** RFC 7396 JSON Merge Patch: objects merge recursively, null removes a key, anything else replaces. */
    private fun mergePatch(target: Any?, patch: Any?): Any? {
        if (patch !is Map<*, *>) return patch
        val result = LinkedHashMap<String, Any?>()
        if (target is Map<*, *>) for ((k, v) in target) result[k as String] = v
        for ((k, v) in patch) {
            val key = k as String
            if (v == null) result.remove(key) else result[key] = mergePatch(result[key], v)
        }
        return result
    }

    private fun deleteDoc(b: JSONObject): JSONObject {
        val db = db(b)
        val c = collection(db, b)
        val id = b.getString("id")
        val doc = c.getDocument(id) ?: throw ApiException(404, "No document '$id' in ${c.fullName}")
        bridge.changes.markBridgeWrite(db.name, c, id)
        if (b.optBoolean("purge", false)) c.purge(doc) else c.delete(doc)
        return jsonOf("id" to id, "collection" to c.fullName, "deleted" to true, "purged" to b.optBoolean("purge", false))
    }

    /** Runs many writes in one Couchbase Lite transaction (inBatch): all succeed or none do. */
    private fun batch(b: JSONObject): JSONObject {
        val db = db(b)
        val ops = b.getJSONArray("operations")
        if (ops.length() > 10_000) throw ApiException(400, "At most 10000 operations per batch")
        val results = JSONArray()
        db.inBatch<Exception> {
            for (i in 0 until ops.length()) {
                val op = ops.getJSONObject(i)
                val opBody = JSONObject(op.toString()).put("database", db.name)
                if (!op.has("collection") && b.has("collection")) opBody.put("collection", b.getString("collection"))
                val c = collection(db, opBody, create = b.optBoolean("createCollection", false))
                val id = op.optString("id").ifEmpty { null }
                when (val kind = op.optString("op", "put")) {
                    "put", "replace" -> results.put(saveOne(db, c, id, op.getJSONObject("body"), "replace", null))
                    "create" -> results.put(saveOne(db, c, id, op.getJSONObject("body"), "create", null))
                    "merge" -> results.put(saveOne(db, c, id, op.getJSONObject("body"), "merge", null))
                    "delete", "purge" -> {
                        val doc = c.getDocument(id ?: throw ApiException(400, "operation $i: delete needs an id"))
                            ?: throw ApiException(404, "operation $i: no document '$id' in ${c.fullName}")
                        bridge.changes.markBridgeWrite(db.name, c, doc.id)
                        if (kind == "purge") c.purge(doc) else c.delete(doc)
                        results.put(jsonOf("id" to id, "collection" to c.fullName, "deleted" to true))
                    }
                    else -> throw ApiException(400, "operation $i: unknown op '$kind'")
                }
            }
        }
        return jsonOf("committed" to true, "count" to results.length(), "results" to results)
    }

    // ---------------------------------------------------------------- collections & indexes

    private fun createCollection(b: JSONObject): JSONObject {
        val db = db(b)
        val c = collection(db, b, create = true)
        return jsonOf("collection" to c.fullName, "count" to c.count)
    }

    private fun deleteCollection(b: JSONObject): JSONObject {
        val db = db(b)
        val c = collection(db, b)
        val full = c.fullName
        db.deleteCollection(c.name, c.scope.name)
        return jsonOf("deleted" to full)
    }

    private fun listIndexes(b: JSONObject): JSONObject {
        val c = collection(db(b), b)
        return jsonOf("collection" to c.fullName, "indexes" to JSONArray(c.indexes.sorted()))
    }

    private fun createIndex(b: JSONObject): JSONObject {
        val c = collection(db(b), b)
        val exprs = b.getJSONArray("expressions").let { a -> (0 until a.length()).map { a.getString(it) } }
        val where = b.optString("where").ifEmpty { null }
        val config = when (b.optString("type", "value")) {
            "value" -> ValueIndexConfiguration(exprs).apply { if (where != null) setWhere(where) }
            "fts", "full-text" -> FullTextIndexConfiguration(exprs).apply {
                b.optString("language").ifEmpty { null }?.let { setLanguage(it) }
                if (b.optBoolean("ignoreAccents", false)) ignoreAccents(true)
                if (where != null) setWhere(where)
            }
            else -> throw ApiException(400, "type must be 'value' or 'fts'")
        }
        c.createIndex(b.getString("name"), config)
        return jsonOf("collection" to c.fullName, "created" to b.getString("name"), "indexes" to JSONArray(c.indexes.sorted()))
    }

    private fun deleteIndex(b: JSONObject): JSONObject {
        val c = collection(db(b), b)
        c.deleteIndex(b.getString("name"))
        return jsonOf("collection" to c.fullName, "deleted" to b.getString("name"))
    }

    // ---------------------------------------------------------------- blobs

    private fun getBlob(b: JSONObject): JSONObject {
        val c = collection(db(b), b)
        val id = b.getString("id")
        val doc = c.getDocument(id) ?: throw ApiException(404, "No document '$id'")
        val blob = doc.getBlob(b.getString("property")) ?: throw ApiException(404, "No blob at '${b.getString("property")}' in '$id'")
        val max = b.optInt("maxBytes", 1_000_000)
        val out = jsonOf("contentType" to blob.contentType, "length" to blob.length(), "digest" to blob.digest())
        if (blob.length() <= max) out.put("base64", Base64.encodeToString(blob.content, Base64.NO_WRAP))
        else out.put("omitted", "Blob is larger than maxBytes ($max)")
        return out
    }

    private fun putBlob(b: JSONObject): JSONObject {
        val db = db(b)
        val c = collection(db, b)
        val id = b.getString("id")
        val doc = c.getDocument(id)?.toMutable() ?: throw ApiException(404, "No document '$id'")
        val bytes = Base64.decode(b.getString("base64"), Base64.DEFAULT)
        doc.setBlob(b.getString("property"), Blob(b.getString("contentType"), bytes))
        bridge.changes.markBridgeWrite(db.name, c, id)
        c.save(doc)
        return jsonOf("id" to id, "property" to b.getString("property"), "length" to bytes.size, "revisionId" to c.getDocument(id)!!.revisionID)
    }

    // ---------------------------------------------------------------- changes & replication

    private fun changes(req: HttpRequest): JSONObject {
        for ((name, db) in allDatabases()) runCatching { db.allCollections().forEach { bridge.changes.watch(name, it) } }
        val since = req.query["since"]?.toLongOrNull() ?: bridge.changes.currentSeq()
        val timeout = req.query["timeoutMs"]?.toLongOrNull() ?: 0L
        val limit = (req.query["limit"]?.toIntOrNull() ?: 200).coerceIn(1, 2000)
        return bridge.changes.poll(since, timeout, limit)
    }

    private fun replicators(): JSONObject {
        val arr = JSONArray()
        for ((name, r) in bridge.replicators) {
            val s = r.status
            arr.put(
                jsonOf(
                    "name" to name,
                    "activity" to s.activityLevel.name,
                    "completed" to s.progress.completed,
                    "total" to s.progress.total,
                    "error" to s.error?.message,
                    "type" to r.config.type.name,
                    "continuous" to r.config.isContinuous,
                ),
            )
        }
        return jsonOf("replicators" to arr)
    }

    private fun replicatorControl(b: JSONObject, start: Boolean): JSONObject {
        val name = b.getString("name")
        val r = bridge.replicators[name] ?: throw ApiException(404, "No replicator '$name'. Registered: ${bridge.replicators.keys}")
        if (start) r.start(b.optBoolean("resetCheckpoint", false)) else r.stop()
        return jsonOf("name" to name, "activity" to r.status.activityLevel.name)
    }

    companion object {
        private const val TAG = "CblBridge"
    }
}
