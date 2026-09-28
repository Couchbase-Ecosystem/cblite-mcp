package io.github.cblmcp.bridge

import android.util.Log
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.net.URLDecoder
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

internal class HttpRequest(
    val method: String,
    val path: String,
    val query: Map<String, String>,
    val headers: Map<String, String>,
    val body: String,
)

internal class HttpResponse(val status: Int, val body: String, val contentType: String = "application/json")

/**
 * Deliberately tiny HTTP/1.1 server: one request per connection, Content-Length bodies only,
 * bound to the loopback interface. It only ever talks to `adb forward`, so nothing fancier is needed
 * and the bridge stays dependency-free.
 */
internal class MiniHttpServer(
    private val handler: (HttpRequest) -> HttpResponse,
) {
    private var serverSocket: ServerSocket? = null
    private var acceptThread: Thread? = null
    private val workers: ExecutorService = Executors.newFixedThreadPool(6) { r ->
        Thread(r, "cbl-bridge-http").apply { isDaemon = true }
    }

    val port: Int get() = serverSocket?.localPort ?: -1

    /** Binds to the first free port in [firstPort, firstPort + attempts). */
    fun start(firstPort: Int, attempts: Int): Int {
        var lastError: Exception? = null
        for (p in firstPort until firstPort + attempts) {
            try {
                val socket = ServerSocket(p, 16, InetAddress.getByName("127.0.0.1"))
                socket.reuseAddress = true
                serverSocket = socket
                break
            } catch (e: Exception) {
                lastError = e
            }
        }
        val socket = serverSocket ?: throw IllegalStateException("No free port in $firstPort..${firstPort + attempts - 1}", lastError)
        acceptThread = Thread({ acceptLoop(socket) }, "cbl-bridge-accept").apply {
            isDaemon = true
            start()
        }
        return socket.localPort
    }

    fun stop() {
        try { serverSocket?.close() } catch (_: Exception) { }
        serverSocket = null
    }

    private fun acceptLoop(socket: ServerSocket) {
        while (!socket.isClosed) {
            try {
                val client = socket.accept()
                workers.execute { serve(client) }
            } catch (e: SocketException) {
                if (!socket.isClosed) Log.w(TAG, "accept failed", e)
            } catch (e: Exception) {
                Log.w(TAG, "accept failed", e)
            }
        }
    }

    private fun serve(client: Socket) {
        client.use { s ->
            s.soTimeout = 120_000
            val response = try {
                val request = parse(BufferedInputStream(s.getInputStream()))
                if (request == null) HttpResponse(400, """{"error":"bad request"}""") else handler(request)
            } catch (e: Exception) {
                Log.w(TAG, "request failed", e)
                HttpResponse(500, errorJson(e))
            }
            val bytes = response.body.toByteArray(Charsets.UTF_8)
            val head = buildString {
                append("HTTP/1.1 ${response.status} ${reason(response.status)}\r\n")
                append("Content-Type: ${response.contentType}; charset=utf-8\r\n")
                append("Content-Length: ${bytes.size}\r\n")
                append("Connection: close\r\n\r\n")
            }
            val out = s.getOutputStream()
            out.write(head.toByteArray(Charsets.US_ASCII))
            out.write(bytes)
            out.flush()
        }
    }

    private fun parse(input: InputStream): HttpRequest? {
        val requestLine = readLine(input) ?: return null
        val parts = requestLine.split(" ")
        if (parts.size < 2) return null
        val headers = mutableMapOf<String, String>()
        while (true) {
            val line = readLine(input) ?: break
            if (line.isEmpty()) break
            val idx = line.indexOf(':')
            if (idx > 0) headers[line.substring(0, idx).trim().lowercase()] = line.substring(idx + 1).trim()
        }
        val length = headers["content-length"]?.toIntOrNull() ?: 0
        if (length > MAX_BODY) throw IllegalArgumentException("Request body too large ($length bytes)")
        val body = ByteArray(length)
        var read = 0
        while (read < length) {
            val n = input.read(body, read, length - read)
            if (n < 0) break
            read += n
        }
        val target = parts[1]
        val q = target.indexOf('?')
        val path = if (q >= 0) target.substring(0, q) else target
        val query = if (q >= 0) parseQuery(target.substring(q + 1)) else emptyMap()
        return HttpRequest(parts[0].uppercase(), path, query, headers, String(body, 0, read, Charsets.UTF_8))
    }

    private fun readLine(input: InputStream): String? {
        val buf = ByteArrayOutputStream()
        while (true) {
            val c = input.read()
            if (c < 0) return if (buf.size() == 0) null else buf.toString("UTF-8")
            if (c == '\n'.code) break
            if (c != '\r'.code) buf.write(c)
            if (buf.size() > 16 * 1024) throw IllegalArgumentException("Header line too long")
        }
        return buf.toString("UTF-8")
    }

    private fun parseQuery(raw: String): Map<String, String> =
        raw.split('&').filter { it.isNotEmpty() }.associate {
            val i = it.indexOf('=')
            if (i < 0) URLDecoder.decode(it, "UTF-8") to ""
            else URLDecoder.decode(it.substring(0, i), "UTF-8") to URLDecoder.decode(it.substring(i + 1), "UTF-8")
        }

    private fun reason(status: Int) = when (status) {
        200 -> "OK"
        400 -> "Bad Request"
        401 -> "Unauthorized"
        403 -> "Forbidden"
        404 -> "Not Found"
        409 -> "Conflict"
        else -> "Error"
    }

    companion object {
        private const val TAG = "CblBridge"
        private const val MAX_BODY = 32 * 1024 * 1024
    }
}
