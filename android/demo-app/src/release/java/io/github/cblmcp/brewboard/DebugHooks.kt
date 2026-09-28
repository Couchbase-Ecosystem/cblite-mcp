package io.github.cblmcp.brewboard

import com.couchbase.lite.Database

/** Release builds: no bridge, nothing to do. */
object DebugHooks {
    fun onDatabaseOpened(db: Database) = Unit
}
