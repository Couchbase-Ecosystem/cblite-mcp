package io.github.cblmcp.bridge

import com.couchbase.lite.CouchbaseLiteException
import org.json.JSONArray
import org.json.JSONObject

/** org.json value -> plain Kotlin value that Couchbase Lite's setValue()/setData() understands. */
internal fun jsonToNative(value: Any?): Any? = when (value) {
    null, JSONObject.NULL -> null
    is JSONObject -> {
        val map = LinkedHashMap<String, Any?>()
        for (key in value.keys()) map[key] = jsonToNative(value.get(key))
        map
    }
    is JSONArray -> (0 until value.length()).map { jsonToNative(value.get(it)) }
    else -> value
}

internal fun JSONObject.toNativeMap(): Map<String, Any?> {
    @Suppress("UNCHECKED_CAST")
    return jsonToNative(this) as Map<String, Any?>
}

/** Parses a JSON string that Couchbase Lite produced (toJSON()) back into an org.json value. */
internal fun parseJsonValue(json: String): Any = when (json.trimStart().firstOrNull()) {
    '{' -> JSONObject(json)
    '[' -> JSONArray(json)
    else -> JSONArray("[$json]").get(0)
}

internal fun errorJson(e: Throwable): String {
    val obj = JSONObject()
    obj.put("error", e.message ?: e.javaClass.simpleName)
    obj.put("type", e.javaClass.simpleName)
    if (e is CouchbaseLiteException) {
        obj.put("domain", e.domain)
        obj.put("code", e.code)
    }
    return obj.toString()
}

internal fun jsonOf(vararg pairs: Pair<String, Any?>): JSONObject {
    val obj = JSONObject()
    for ((k, v) in pairs) obj.put(k, v ?: JSONObject.NULL)
    return obj
}

/** getCollections() only returns the default scope; agents need every scope. */
internal fun com.couchbase.lite.Database.allCollections(): List<com.couchbase.lite.Collection> =
    scopes.flatMap { it.collections }
