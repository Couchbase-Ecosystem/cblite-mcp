plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
    `maven-publish`
}

group = "io.github.cblmcp"
version = "0.1.0"

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
    publishing {
        singleVariant("release") {
            withSourcesJar()
        }
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

// ./gradlew :cbl-bridge:publishToMavenLocal  ->  io.github.cblmcp:cbl-bridge:0.1.0 in ~/.m2
publishing {
    publications {
        register<MavenPublication>("release") {
            artifactId = "cbl-bridge"
            afterEvaluate { from(components["release"]) }
        }
    }
}
