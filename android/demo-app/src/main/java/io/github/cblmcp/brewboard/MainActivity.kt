package io.github.cblmcp.brewboard

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.delay
import java.util.Locale

private val Espresso = Color(0xFF1A110D)
private val Roast = Color(0xFF2B1B14)
private val CardBg = Color(0xFF34231A)
private val Crema = Color(0xFFF4E3D3)
private val Muted = Color(0xFFB9A393)
private val Caramel = Color(0xFFE8A15C)
private val StatusColors = mapOf(
    "new" to Color(0xFF6FB7FF),
    "brewing" to Color(0xFFE8A15C),
    "ready" to Color(0xFF7DDC8C),
)
private val StatusLabels = mapOf("new" to "New", "brewing" to "Brewing", "ready" to "Ready")
private val ActionLabels = mapOf("new" to "Start", "brewing" to "Mark ready", "ready" to "Picked up")

class MainActivity : ComponentActivity() {
    private lateinit var repo: OrderRepository

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val app = application as BrewBoardApp
        repo = OrderRepository(app.database, app.orders).also { it.start() }
        setContent {
            MaterialTheme(colorScheme = darkColorScheme(background = Espresso, surface = Roast, primary = Caramel)) {
                BrewBoard(repo)
            }
        }
    }

    override fun onDestroy() {
        repo.stop()
        super.onDestroy()
    }
}

@Composable
private fun BrewBoard(repo: OrderRepository) {
    val orders by repo.openOrders.collectAsStateWithLifecycle()
    val served by repo.servedToday.collectAsStateWithLifecycle()

    // Remember each order's last-seen sequence so cards that change (from the app OR an agent) can flash.
    val seen = remember { mutableStateMapOf<String, String>() }
    val flashing = remember { mutableStateMapOf<String, Long>() }
    var firstLoad by remember { mutableStateOf(true) }
    LaunchedEffect(orders) {
        val now = System.currentTimeMillis()
        for (o in orders) {
            val prev = seen[o.id]
            if (!firstLoad && prev != o.revision) flashing[o.id] = now
            seen[o.id] = o.revision
        }
        firstLoad = false
    }

    Column(
        Modifier
            .fillMaxSize()
            .background(Espresso)
            .safeDrawingPadding(),
    ) {
        Header(orders, served)
        if (orders.isEmpty()) {
            EmptyState()
        } else {
            LazyColumn(
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
                modifier = Modifier.fillMaxSize(),
            ) {
                for (status in listOf("new", "brewing", "ready")) {
                    val group = orders.filter { it.status == status }
                    if (group.isEmpty()) continue
                    item(key = "h-$status") { SectionHeader(status, group.size) }
                    items(group, key = { it.id }) { order ->
                        OrderCard(order, flashing[order.id], onAdvance = { repo.advance(order) })
                    }
                }
                val other = orders.filter { it.status !in StatusColors }
                if (other.isNotEmpty()) {
                    item(key = "h-other") { SectionHeader("other", other.size) }
                    items(other, key = { it.id }) { order -> OrderCard(order, flashing[order.id], onAdvance = {}) }
                }
            }
        }
    }
}

@Composable
private fun Header(orders: List<Order>, served: Int) {
    Column(Modifier.padding(start = 20.dp, end = 20.dp, top = 12.dp, bottom = 8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("☕", fontSize = 26.sp)
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text("Brew Board", color = Crema, fontSize = 24.sp, fontWeight = FontWeight.Bold)
                Text("Couchbase Lite · shop.orders", color = Muted, fontSize = 13.sp)
            }
            LiveDot()
        }
        Spacer(Modifier.height(14.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            for (s in listOf("new", "brewing", "ready")) {
                StatTile(StatusLabels[s]!!, orders.count { it.status == s }.toString(), StatusColors[s]!!, Modifier.weight(1f))
            }
            StatTile("Served", served.toString(), Crema, Modifier.weight(1f))
        }
        Spacer(Modifier.height(8.dp))
        val openValue = orders.sumOf { it.total }
        Text(
            "Open tickets ${"$"}${String.format(Locale.US, "%.2f", openValue)}",
            color = Muted,
            fontSize = 13.sp,
        )
    }
}

@Composable
private fun LiveDot() {
    val t = rememberInfiniteTransition(label = "live")
    val a by t.animateFloat(0.3f, 1f, infiniteRepeatable(tween(900), RepeatMode.Reverse), label = "a")
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .clip(RoundedCornerShape(50))
            .background(Roast)
            .padding(horizontal = 10.dp, vertical = 5.dp),
    ) {
        Box(Modifier.size(8.dp).alpha(a).clip(CircleShape).background(Color(0xFF7DDC8C)))
        Spacer(Modifier.width(6.dp))
        Text("LIVE", color = Crema, fontSize = 11.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.sp)
    }
}

@Composable
private fun StatTile(label: String, value: String, accent: Color, modifier: Modifier) {
    Column(
        modifier
            .clip(RoundedCornerShape(14.dp))
            .background(Roast)
            .padding(horizontal = 12.dp, vertical = 10.dp),
    ) {
        Text(value, color = accent, fontSize = 22.sp, fontWeight = FontWeight.Bold)
        Text(label, color = Muted, fontSize = 12.sp)
    }
}

@Composable
private fun SectionHeader(status: String, count: Int) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 10.dp, bottom = 2.dp)) {
        Box(Modifier.size(10.dp).clip(CircleShape).background(StatusColors[status] ?: Muted))
        Spacer(Modifier.width(8.dp))
        Text(
            (StatusLabels[status] ?: "Other").uppercase(),
            color = Crema,
            fontSize = 13.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = 1.2.sp,
        )
        Spacer(Modifier.width(6.dp))
        Text("$count", color = Muted, fontSize = 13.sp)
    }
}

@Composable
private fun OrderCard(order: Order, flashAt: Long?, onAdvance: () -> Unit) {
    val accent = StatusColors[order.status] ?: Muted
    var flash by remember { mutableStateOf(false) }
    LaunchedEffect(flashAt) {
        if (flashAt != null) {
            flash = true
            delay(1600)
            flash = false
        }
    }
    val border by animateColorAsState(if (flash) Caramel else Color.Transparent, tween(350), label = "flash")
    val bg by animateColorAsState(if (flash) Color(0xFF4A3021) else CardBg, tween(350), label = "bg")

    Row(
        Modifier
            .fillMaxWidth()
            .height(IntrinsicSize.Min)
            .clip(RoundedCornerShape(16.dp))
            .background(bg)
            .border(2.dp, border, RoundedCornerShape(16.dp)),
    ) {
        Box(Modifier.width(6.dp).fillMaxHeight().background(accent))
        Column(Modifier.weight(1f).padding(start = 14.dp, top = 12.dp, bottom = 12.dp, end = 8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    order.customer,
                    color = Crema,
                    fontSize = 18.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                Spacer(Modifier.width(8.dp))
                Text(age(order.createdAt), color = Muted, fontSize = 12.sp)
            }
            Spacer(Modifier.height(4.dp))
            Text(
                order.items.joinToString(" · ") { "${it.qty}× ${it.name}" }.ifEmpty { "No items" },
                color = Muted,
                fontSize = 14.sp,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            order.note?.let {
                Spacer(Modifier.height(2.dp))
                Text("“$it”", color = Caramel, fontSize = 13.sp, fontStyle = FontStyle.Italic, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        Column(
            horizontalAlignment = Alignment.End,
            modifier = Modifier.padding(top = 12.dp, end = 12.dp, bottom = 12.dp),
        ) {
            Text("${"$"}${String.format(Locale.US, "%.2f", order.total)}", color = Crema, fontSize = 17.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(12.dp))
            ActionLabels[order.status]?.let { label ->
                Button(
                    onClick = onAdvance,
                    colors = ButtonDefaults.buttonColors(containerColor = accent, contentColor = Espresso),
                    contentPadding = PaddingValues(horizontal = 14.dp, vertical = 6.dp),
                ) { Text(label, fontSize = 13.sp, fontWeight = FontWeight.Bold) }
            }
        }
    }
}

@Composable
private fun EmptyState() {
    Column(
        Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("☕", fontSize = 56.sp)
        Spacer(Modifier.height(12.dp))
        Text("No open orders", color = Crema, fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(6.dp))
        Text("Waiting for the morning rush…", color = Muted, fontSize = 14.sp)
    }
}

@Composable
private fun age(createdAt: Long): String {
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(15_000)
            now = System.currentTimeMillis()
        }
    }
    if (createdAt <= 0) return ""
    val mins = ((now - createdAt) / 60_000).coerceAtLeast(0)
    return when {
        mins < 1 -> "just now"
        mins < 60 -> "$mins min"
        else -> "${mins / 60}h ${mins % 60}m"
    }
}
