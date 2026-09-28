package io.github.cblmcp.brewboard

import com.couchbase.lite.Collection
import com.couchbase.lite.Database
import com.couchbase.lite.ListenerToken
import com.couchbase.lite.Result
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.time.Instant

data class OrderItem(val name: String, val qty: Int)

data class Order(
    val id: String,
    val revision: String,
    val customer: String,
    val items: List<OrderItem>,
    val total: Double,
    val status: String,
    val createdAt: Long,
    val note: String?,
)

val STATUS_FLOW = listOf("new", "brewing", "ready", "picked_up")

/** Live view over shop.orders: a Couchbase Lite live query pushes every change (app or agent) into a StateFlow. */
class OrderRepository(private val db: Database, private val orders: Collection) {
    private val _orders = MutableStateFlow<List<Order>>(emptyList())
    val openOrders: StateFlow<List<Order>> = _orders

    private val _servedToday = MutableStateFlow(0)
    val servedToday: StateFlow<Int> = _servedToday

    private var token: ListenerToken? = null

    fun start() {
        val query = db.createQuery(
            """
            SELECT META(o).id AS id, META(o).sequence AS rev, o.customer, o.items, o.total, o.status, o.createdAt, o.note
            FROM shop.orders AS o
            ORDER BY o.createdAt
            """.trimIndent(),
        )
        token = query.addChangeListener { change ->
            val all = change.results?.allResults()?.mapNotNull(::toOrder) ?: return@addChangeListener
            _orders.value = all.filter { it.status != "picked_up" }
            _servedToday.value = all.count { it.status == "picked_up" }
        }
    }

    fun stop() {
        token?.remove()
    }

    fun advance(order: Order) {
        val doc = orders.getDocument(order.id)?.toMutable() ?: return
        val idx = STATUS_FLOW.indexOf(doc.getString("status") ?: "new")
        val next = STATUS_FLOW.getOrNull(idx + 1) ?: return
        doc.setString("status", next)
        doc.setLong(
            when (next) {
                "brewing" -> "startedAt"
                "ready" -> "readyAt"
                else -> "pickedUpAt"
            },
            System.currentTimeMillis(),
        )
        orders.save(doc)
    }

    private fun toOrder(r: Result): Order? {
        val id = r.getString("id") ?: return null
        val items = r.getArray("items")?.toList()?.mapNotNull { raw ->
            val m = raw as? Map<*, *> ?: return@mapNotNull null
            OrderItem(m["name"]?.toString() ?: "?", (m["qty"] as? Number)?.toInt() ?: 1)
        } ?: emptyList()
        return Order(
            id = id,
            revision = r.getLong("rev").toString(),
            customer = r.getString("customer") ?: "(no name)",
            items = items,
            total = r.getNumber("total")?.toDouble() ?: 0.0,
            status = r.getString("status") ?: "new",
            createdAt = parseTime(r.getValue("createdAt")),
            note = r.getString("note"),
        )
    }

    private fun parseTime(v: Any?): Long = when (v) {
        is Number -> v.toLong()
        is String -> runCatching { Instant.parse(v).toEpochMilli() }.getOrDefault(0L)
        else -> 0L
    }
}
