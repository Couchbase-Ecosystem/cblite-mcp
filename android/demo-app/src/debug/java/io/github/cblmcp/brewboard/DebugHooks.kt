package io.github.cblmcp.brewboard

import com.couchbase.lite.Database
import io.github.cblmcp.bridge.CblBridge

/** Debug builds only: hand the live database to the MCP bridge. This is the entire app-side integration. */
object DebugHooks {
    fun onDatabaseOpened(db: Database) = CblBridge.register(db)
}
