package io.github.cblmcp.brewboard

import android.app.Application
import com.couchbase.lite.Collection
import com.couchbase.lite.CouchbaseLite
import com.couchbase.lite.Database
import com.couchbase.lite.MutableDocument
import com.couchbase.lite.ValueIndexConfiguration

class BrewBoardApp : Application() {
    lateinit var database: Database
        private set
    lateinit var orders: Collection
        private set
    lateinit var menu: Collection
        private set

    override fun onCreate() {
        super.onCreate()
        CouchbaseLite.init(this)
        database = Database("brewboard")
        orders = database.getCollection("orders", "shop") ?: database.createCollection("orders", "shop")
        menu = database.getCollection("menu", "shop") ?: database.createCollection("menu", "shop")
        if (!orders.indexes.contains("idx_orders_status")) {
            orders.createIndex("idx_orders_status", ValueIndexConfiguration("status", "createdAt"))
        }
        seedMenu()
        DebugHooks.onDatabaseOpened(database)
    }

    private fun seedMenu() {
        if (menu.count > 0) return
        val items = listOf(
            Triple("espresso", "Espresso", 3.00),
            Triple("cortado", "Cortado", 4.00),
            Triple("flat-white", "Flat White", 4.50),
            Triple("oat-latte", "Oat Latte", 5.00),
            Triple("matcha-latte", "Matcha Latte", 5.25),
            Triple("cold-brew", "Cold Brew", 4.75),
            Triple("chai", "Chai Latte", 4.25),
            Triple("croissant", "Butter Croissant", 3.25),
            Triple("banana-bread", "Banana Bread", 3.50),
        )
        database.inBatch<Exception> {
            for ((id, name, price) in items) {
                menu.save(
                    MutableDocument(id)
                        .setString("name", name)
                        .setDouble("price", price)
                        .setString("category", if (id in setOf("croissant", "banana-bread")) "food" else "drink")
                        .setBoolean("available", true),
                )
            }
        }
    }
}
