plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "io.github.cblmcp.bridge"
    compileSdk = 36

    defaultConfig {
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
        buildConfigField("String", "BRIDGE_VERSION", "\"0.1.0\"")
    }
    buildFeatures {
        buildConfig = true
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
    // The host app brings its own Couchbase Lite (CE or EE, 3.2+/4.x); the bridge only compiles against it.
    compileOnly("com.couchbase.lite:couchbase-lite-android:4.1.2")
}
