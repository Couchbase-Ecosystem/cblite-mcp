package io.github.cblmcp.bridge

import android.content.ContentProvider
import android.content.ContentValues
import android.content.pm.PackageManager
import android.database.Cursor
import android.net.Uri

/**
 * Starts the bridge when the app process starts, before Application.onCreate(), the same trick
 * LeakCanary uses. Because the library is added with debugImplementation, release builds never
 * contain this provider.
 */
class BridgeInitProvider : ContentProvider() {
    override fun onCreate(): Boolean {
        val ctx = context ?: return true
        // Optional <meta-data> in the app manifest: cblbridge.port, cblbridge.readOnly, cblbridge.autoStart
        val meta = runCatching {
            ctx.packageManager.getApplicationInfo(ctx.packageName, PackageManager.GET_META_DATA).metaData
        }.getOrNull()
        if (meta?.getBoolean("cblbridge.autoStart", true) == false) return true
        CblBridge.start(
            ctx,
            port = meta?.getInt("cblbridge.port", CblBridge.DEFAULT_PORT) ?: CblBridge.DEFAULT_PORT,
            readOnly = meta?.getBoolean("cblbridge.readOnly", false) ?: false,
        )
        return true
    }

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? = null
    override fun getType(uri: Uri): String? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0
}
