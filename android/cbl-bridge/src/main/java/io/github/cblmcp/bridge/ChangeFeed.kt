package io.github.cblmcp.bridge

import com.couchbase.lite.Collection
import com.couchbase.lite.ListenerToken
import org.json.JSONArray
import org.json.JSONObject
import java.util.ArrayDeque
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * Ring buffer of collection changes, fed by Couchbase Lite change listeners on every collection the
 * bridge knows about. Agents long-poll it (GET /changes?since=N) to see what the app itself wrote,
 * e.g. after driving the UI with a tool like mobile-mcp.
 */
internal class ChangeFeed(private val capacity: Int = 2000) {
    private val lock = Object()
    private val events = ArrayDeque<JSONObject>()
    private var lastSeq = 0L
    private val listeners = ConcurrentHashMap<String, ListenerToken>()
    private val recentBridgeWrites = ConcurrentHashMap<String, Long>()
    private val executor = Executors.newSingleThreadExecutor { r -> Thread(r, "cbl-bridge-changes").apply { isDaemon = true } }

    /** Attaches a listener to [collection] once; safe to call repeatedly. */
    fun watch(dbName: String, collection: Collection) {
        val key = "$dbName/${collection.fullName}"
        if (listeners.containsKey(key)) return
        val token = collection.addChangeListener(executor) { change ->
            val now = System.currentTimeMillis()
            val ids = change.documentIDs
            val byBridge = ids.isNotEmpty() && ids.all { id ->
                val t = recentBridgeWrites.remove("$key/$id")
                t != null && now - t < ATTRIBUTION_WINDOW_MS
            }
            record(dbName, collection.fullName, ids, if (byBridge) "bridge" else "app")
        }
        listeners[key] = token
    }

    /** Called just before the bridge writes a document, so the resulting change is attributed to the agent. */
    fun markBridgeWrite(dbName: String, collection: Collection, docId: String) {
        recentBridgeWrites["$dbName/${collection.fullName}/$docId"] = System.currentTimeMillis()
        if (recentBridgeWrites.size > 10_000) recentBridgeWrites.clear()
    }

    fun unwatchAll() {
        listeners.values.forEach { runCatching { it.remove() } }
        listeners.clear()
    }

    private fun record(db: String, collection: String, ids: List<String>, source: String) {
        synchronized(lock) {
            lastSeq++
            events.addLast(
                jsonOf(
                    "seq" to lastSeq,
                    "time" to System.currentTimeMillis(),
                    "database" to db,
                    "collection" to collection,
                    "source" to source,
                    "documentIds" to JSONArray(ids),
                ),
            )
            while (events.size > capacity) events.removeFirst()
            lock.notifyAll()
        }
    }

    fun currentSeq(): Long = synchronized(lock) { lastSeq }

    /** Returns events with seq > [since], waiting up to [timeoutMs] for at least one to arrive. */
    fun poll(since: Long, timeoutMs: Long, limit: Int): JSONObject {
        val deadline = System.currentTimeMillis() + timeoutMs.coerceIn(0, 60_000)
        synchronized(lock) {
            while (lastSeq <= since) {
                val remaining = deadline - System.currentTimeMillis()
                if (remaining <= 0) break
                lock.wait(remaining)
            }
            val out = JSONArray()
            var truncated = false
            for (e in events) {
                if (e.getLong("seq") <= since) continue
                if (out.length() >= limit) { truncated = true; break }
                out.put(e)
            }
            val next = if (truncated) out.getJSONObject(out.length() - 1).getLong("seq") else lastSeq
            // Events older than the ring buffer are gone; say so rather than silently skipping them.
            val oldest = events.firstOrNull()?.getLong("seq") ?: (lastSeq + 1)
            val gap = since < oldest - 1
            return jsonOf("lastSeq" to next, "events" to out, "truncated" to truncated, "gap" to gap)
        }
    }

    companion object {
        private const val ATTRIBUTION_WINDOW_MS = 5_000L
    }
}
