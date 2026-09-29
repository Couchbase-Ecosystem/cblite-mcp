import java.net.URI
import java.security.MessageDigest

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// The demo consumes the *published* bridge, exactly like a developer's app would: the AAR attached to the GitHub
// release, downloaded once into libs/ and checksum-verified. Pass -PbridgeFromSource to use the local module
// instead while working on the library itself.
val bridgeFromSource = providers.gradleProperty("bridgeFromSource").isPresent
val bridgeVersion = "0.1.0"
val bridgeSha256 = "77a0a61b38072f33e794dfe591fad88a8d706954f94980716b481218545fa5ee"
val bridgeAar = file("libs/cbl-bridge-$bridgeVersion.aar")
if (!bridgeFromSource && !bridgeAar.exists()) {
    val url = "https://github.com/Couchbase-Ecosystem/cblite-mcp/releases/download/v$bridgeVersion/cbl-bridge-$bridgeVersion.aar"
    logger.lifecycle("Downloading $url")
    val bytes = URI(url).toURL().openStream().use { it.readBytes() }
    val actual = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    check(actual == bridgeSha256) { "cbl-bridge-$bridgeVersion.aar checksum mismatch: $actual" }
    bridgeAar.parentFile.mkdirs()
    bridgeAar.writeBytes(bytes)
}

android {
    namespace = "io.github.cblmcp.brewboard"
    compileSdk = 36

    defaultConfig {
        applicationId = "io.github.cblmcp.brewboard"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    buildFeatures {
        compose = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    implementation("com.couchbase.lite:couchbase-lite-android-ktx:4.1.2")

    // The whole integration: debug builds get the bridge, release builds never see it.
    if (bridgeFromSource) debugImplementation(project(":cbl-bridge"))
    else debugImplementation(files("libs/cbl-bridge-$bridgeVersion.aar"))

    implementation(platform("androidx.compose:compose-bom:2026.03.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.activity:activity-compose:1.12.4")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.10.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
}
