package io.github.cblmcp.bridge

import android.content.Context
import android.util.Log
import com.couchbase.lite.Database
import com.couchbase.lite.Replicator
import org.json.JSONObject
import java.io.File
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap

/**
 * Debug-only bridge that exposes the app's live Couchbase Lite databases to an MCP server on the
 * developer's machine (via `adb forward`).
 *
 * Add it with `debugImplementation(...)`. It starts itself when the app process starts
 * ([BridgeInitProvider]); the only call an app normally makes is [register], from a debug-only
 * source file, to hand over the Database instance it already has open.
 */
object CblBridge {
    private const val TAG = "CblBridge"
    const val DEFAULT_PORT = 47111
    private const val PORT_ATTEMPTS = 10

    internal val databases = ConcurrentHashMap<String, Database>()
    internal val replicators = ConcurrentHashMap<String, Replicator>()
    internal val changes = ChangeFeed()

    @Volatile internal var appContext: Context? = null
        private set
    @Volatile internal var readOnly: Boolean = false
        private set

    private var server: MiniHttpServer? = null
    @Volatile private var token: String = ""

    /** Hands the bridge a database the app already opened. Changes made through it fire the app's own listeners. */
    @JvmStatic
    fun register(database: Database) {
        databases[database.name] = database
        runCatching { database.allCollections().forEach { changes.watch(database.name, it) } }
            .onFailure { Log.w(TAG, "could not watch ${database.name}", it) }
        Log.i(TAG, "registered database '${database.name}'")
    }

    /** Optional: lets agents read replication status and start/stop a replicator by [name]. */
    @JvmStatic
    fun registerReplicator(name: String, replicator: Replicator) {
        replicators[name] = replicator
    }

    @JvmStatic
    fun unregister(database: Database) {
        databases.remove(database.name, database)
    }

    /** Called automatically by [BridgeInitProvider]; call it yourself only if you disabled the provider. */
    @JvmStatic
    @Synchronized
    fun start(context: Context, port: Int = DEFAULT_PORT, readOnly: Boolean = false) {
        if (server != null) return
        appContext = context.applicationContext
        this.readOnly = readOnly
        token = newToken()
        val api = BridgeApi(this)
        val s = MiniHttpServer { req -> api.handle(req, token) }
        try {
            val bound = s.start(port, PORT_ATTEMPTS)
            server = s
            writeConnectionFile(context, bound)
            Log.i(TAG, "Couchbase Lite MCP bridge listening on 127.0.0.1:$bound for ${context.packageName}")
        } catch (e: Exception) {
            Log.e(TAG, "bridge failed to start", e)
        }
    }

    @JvmStatic
    @Synchronized
    fun stop() {
        server?.stop()
        server = null
        changes.unwatchAll()
    }

    val port: Int get() = server?.port ?: -1

    /**
     * The token lives in app-private storage, so only something with `run-as` access (i.e. adb on a
     * debuggable build) can read it. Other apps on the device can reach 127.0.0.1 but not the token.
     */
    private fun writeConnectionFile(context: Context, port: Int) {
        val dir = File(context.filesDir, ".cbl-bridge").apply { mkdirs() }
        val info = JSONObject()
            .put("package", context.packageName)
            .put("port", port)
            .put("token", token)
            .put("pid", android.os.Process.myPid())
            .put("bridgeVersion", BuildConfig.BRIDGE_VERSION)
        File(dir, "bridge.json").writeText(info.toString())
    }

    private fun newToken(): String {
        val bytes = ByteArray(24)
        SecureRandom().nextBytes(bytes)
        return bytes.joinToString("") { "%02x".format(it) }
    }
}
