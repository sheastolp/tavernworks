plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// Release signing comes from environment variables (GitHub Actions secrets POOL_KEYSTORE_B64 and
// POOL_KEYSTORE_PASSWORD). Without them the APK is signed with the runner's debug key: it installs
// fine, but a later build signed with another key can't update it (uninstall first).
val ksFile = System.getenv("POOL_KEYSTORE")?.let { file(it) }?.takeIf { it.exists() }
val enginePin = rootProject.file("engine-pin.txt").readText().trim()

android {
    namespace = "dev.tavernworks.poolworker"
    compileSdk = 35

    defaultConfig {
        applicationId = "dev.tavernworks.poolworker"
        minSdk = 26
        targetSdk = 35
        versionCode = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()
        versionName = "1.0." + (System.getenv("GITHUB_RUN_NUMBER") ?: "0")
        buildConfigField("String", "ENGINE_PIN", "\"$enginePin\"")
        ndk { abiFilters += "arm64-v8a" }
    }

    signingConfigs {
        if (ksFile != null) create("release") {
            storeFile = ksFile
            storePassword = System.getenv("POOL_KEYSTORE_PASSWORD")
            keyAlias = System.getenv("POOL_KEY_ALIAS") ?: "poolworker"
            keyPassword = System.getenv("POOL_KEY_PASSWORD") ?: System.getenv("POOL_KEYSTORE_PASSWORD")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = if (ksFile != null) signingConfigs.getByName("release") else signingConfigs.getByName("debug")
        }
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    packaging {
        jniLibs {
            // The rpc-server programs must land on disk in the native library folder: Android
            // only lets an app start programs from there.
            useLegacyPackaging = true
            keepDebugSymbols += "**/*.so"
        }
    }
    androidResources {
        // The GPU engine's libraries are copied out of the APK as they are.
        noCompress += "so"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation(platform("androidx.compose:compose-bom:2024.10.01"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
}
