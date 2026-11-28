plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Release signing comes from environment variables (GitHub Actions secrets). Without them the
// release APK is signed with the debug key, which still installs fine but can't update a copy
// signed with a different key.
val ksFile = System.getenv("ROSIN_KEYSTORE")?.let { file(it) }?.takeIf { it.exists() }

android {
    namespace = "dev.tavernworks.rosin"
    compileSdk = 35

    defaultConfig {
        applicationId = "dev.tavernworks.rosin"
        minSdk = 26
        targetSdk = 35
        versionCode = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()
        versionName = System.getenv("ROSIN_VERSION")?.takeIf { it.isNotBlank() } ?: ("1.0." + (System.getenv("GITHUB_RUN_NUMBER") ?: "0"))
    }

    signingConfigs {
        if (ksFile != null) create("release") {
            storeFile = ksFile
            storePassword = System.getenv("ROSIN_KEYSTORE_PASSWORD")
            keyAlias = System.getenv("ROSIN_KEY_ALIAS") ?: "rosin"
            keyPassword = System.getenv("ROSIN_KEY_PASSWORD") ?: System.getenv("ROSIN_KEYSTORE_PASSWORD")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = if (ksFile != null) signingConfigs.getByName("release") else signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.webkit:webkit:1.12.1")
}
