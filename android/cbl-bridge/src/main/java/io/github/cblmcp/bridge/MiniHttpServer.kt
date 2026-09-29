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
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.SynchronousQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

internal class HttpRequest(
    val method: String,
    val path: String,
    val query: Map<String, String>,
    val headers: Map<String, String>,
    val body: String,
)

internal class HttpResponse(val status: Int, val body: String, val contentType: String = "application/json")

private class BadRequest(val status: Int, message: String) : Exception(message)

/**
 * Deliberately tiny HTTP/1.1 server: one request per connection, Content-Length bodies only,
 * bound to the loopback interface. It only ever talks to `adb forward`, so nothing fancier is needed
 * and the bridge stays dependency-free.
 *
 * It runs inside someone else's app, so it must never take that app down: every per-connection
 * failure (including Errors such as OutOfMemoryError or StackOverflowError) is contained to the
 * connection, reads have a short timeout so idle or slow clients can't pin threads, and the worker
 * pool is bounded.
 */
internal class MiniHttpServer(
    private val handler: (HttpRequest) -> HttpResponse,
) {
    private var serverSocket: ServerSocket? = null
    private var acceptThread: Thread? = null
    private val workers = ThreadPoolExecutor(
        2, MAX_WORKERS, 30, TimeUnit.SECONDS, SynchronousQueue(),
    ) { r ->
        // Large stack: request handling recurses over JSON, and deeply nested documents are legal.
        Thread(null, r, "cbl-bridge-http", 16L * 1024 * 1024).apply { isDaemon = true }
    }

    val port: Int get() = serverSocket?.localPort ?: -1

    /** Binds to the first free port in [firstPort, firstPort + attempts). */
    fun start(firstPort: Int, attempts: Int): Int {
        var lastError: Exception? = null
        for (p in firstPort until firstPort + attempts) {
            try {
                val socket = ServerSocket(p, 64, InetAddress.getByName("127.0.0.1"))
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
            val client = try {
                socket.accept()
            } catch (e: SocketException) {
                if (!socket.isClosed) Log.w(TAG, "accept failed", e)
                continue
            } catch (e: Throwable) {
                Log.w(TAG, "accept failed", e)
                continue
            }
            try {
                workers.execute { serve(client) }
            } catch (e: RejectedExecutionException) {
                // Every worker is busy: answer 503 from here rather than queueing without bound.
                safely { write(client, HttpResponse(503, """{"error":"bridge busy, retry"}""")) }
                safely { client.close() }
            }
        }
    }

    private fun serve(client: Socket) {
        try {
            client.soTimeout = READ_TIMEOUT_MS
            val response = try {
                val request = parse(BufferedInputStream(client.getInputStream()))
                client.soTimeout = 0 // the handler may legitimately take long (e.g. /changes long-poll)
                handler(request)
            } catch (e: BadRequest) {
                HttpResponse(e.status, jsonOf("error" to e.message).toString())
            } catch (e: java.net.SocketTimeoutException) {
                HttpResponse(408, """{"error":"request not received in time"}""")
            } catch (e: Throwable) {
                Log.w(TAG, "request failed", e)
                HttpResponse(500, errorJson(e))
            }
            write(client, response)
        } catch (_: Throwable) {
            // Client went away mid-response, or anything else: never let it reach the app's uncaught handler.
        } finally {
            safely { client.close() }
        }
    }

    private fun write(client: Socket, response: HttpResponse) {
        val bytes = response.body.toByteArray(Charsets.UTF_8)
        val head = buildString {
            append("HTTP/1.1 ${response.status} ${reason(response.status)}\r\n")
            append("Content-Type: ${response.contentType}; charset=utf-8\r\n")
            append("Content-Length: ${bytes.size}\r\n")
            append("Connection: close\r\n\r\n")
        }
        val out = client.getOutputStream()
        out.write(head.toByteArray(Charsets.US_ASCII))
        out.write(bytes)
        out.flush()
    }

    private fun parse(input: InputStream): HttpRequest {
        val requestLine = readLine(input) ?: throw BadRequest(400, "Empty request")
        val parts = requestLine.split(" ")
        if (parts.size != 3 || !parts[2].startsWith("HTTP/")) throw BadRequest(400, "Malformed request line")
        val headers = mutableMapOf<String, String>()
        while (true) {
            val line = readLine(input) ?: break
            if (line.isEmpty()) break
            if (headers.size >= MAX_HEADERS) throw BadRequest(431, "Too many headers")
            val idx = line.indexOf(':')
            if (idx > 0) headers[line.substring(0, idx).trim().lowercase()] = line.substring(idx + 1).trim()
        }
        if (headers["transfer-encoding"]?.lowercase()?.contains("chunked") == true) {
            throw BadRequest(411, "Chunked bodies are not supported; send Content-Length")
        }
        val lengthHeader = headers["content-length"]
        val length = when {
            lengthHeader == null -> 0
            else -> lengthHeader.toLongOrNull() ?: throw BadRequest(400, "Invalid Content-Length")
        }
        if (length < 0) throw BadRequest(400, "Invalid Content-Length")
        if (length > MAX_BODY) throw BadRequest(413, "Request body too large ($length bytes, max $MAX_BODY)")
        val body = ByteArray(length.toInt())
        var read = 0
        while (read < body.size) {
            val n = input.read(body, read, body.size - read)
            if (n < 0) throw BadRequest(400, "Body shorter than Content-Length ($read of $length bytes)")
            read += n
        }
        val target = parts[1]
        val q = target.indexOf('?')
        val path = if (q >= 0) target.substring(0, q) else target
        val query = if (q >= 0) parseQuery(target.substring(q + 1)) else emptyMap()
        return HttpRequest(parts[0].uppercase(), path, query, headers, String(body, Charsets.UTF_8))
    }

    private fun readLine(input: InputStream): String? {
        val buf = ByteArrayOutputStream()
        while (true) {
            val c = input.read()
            if (c < 0) return if (buf.size() == 0) null else buf.toString("UTF-8")
            if (c == '\n'.code) break
            if (c != '\r'.code) buf.write(c)
            if (buf.size() > MAX_LINE) throw BadRequest(431, "Header line too long")
        }
        return buf.toString("UTF-8")
    }

    private fun parseQuery(raw: String): Map<String, String> = try {
        raw.split('&').filter { it.isNotEmpty() }.associate {
            val i = it.indexOf('=')
            if (i < 0) URLDecoder.decode(it, "UTF-8") to ""
            else URLDecoder.decode(it.substring(0, i), "UTF-8") to URLDecoder.decode(it.substring(i + 1), "UTF-8")
        }
    } catch (e: IllegalArgumentException) {
        throw BadRequest(400, "Malformed query string")
    }

    private fun reason(status: Int) = when (status) {
        200 -> "OK"
        400 -> "Bad Request"
        401 -> "Unauthorized"
        403 -> "Forbidden"
        404 -> "Not Found"
        408 -> "Request Timeout"
        409 -> "Conflict"
        411 -> "Length Required"
        413 -> "Payload Too Large"
        431 -> "Request Header Fields Too Large"
        503 -> "Service Unavailable"
        else -> "Error"
    }

    private inline fun safely(block: () -> Unit) {
        try { block() } catch (_: Throwable) { }
    }

    companion object {
        private const val TAG = "CblBridge"
        private const val MAX_BODY = 32L * 1024 * 1024
        private const val MAX_LINE = 16 * 1024
        private const val MAX_HEADERS = 100
        private const val MAX_WORKERS = 64
        private const val READ_TIMEOUT_MS = 10_000
    }
}
