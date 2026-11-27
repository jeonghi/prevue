package com.prevue.nativefixture

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.facebook.react.packagerconnection.PackagerConnectionSettings

class MainApplication : Application(), ReactApplication {
  private var previewHost: String? = null
  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      jsMainModulePath = if (BuildConfig.DEBUG && previewHost != null) "index.preview" else "index",
      packageList = PackageList(this).packages,
    )
  }

  fun selectPreviewHost(host: String?): Boolean {
    if (!BuildConfig.DEBUG) return false
    val port = host?.substringAfter("127.0.0.1:", "")?.toIntOrNull()
    val endpoint = if (port != null && port in 1..65535 && host == "127.0.0.1:$port") host else null
    val packager = PackagerConnectionSettings(this)
    val prefs = getSharedPreferences("prevue_fixture", MODE_PRIVATE)
    if (endpoint != null) {
      if (!prefs.contains("previous_host")) prefs.edit().putString("previous_host", packager.debugServerHost).apply()
      packager.debugServerHost = endpoint
    } else if (prefs.contains("previous_host")) {
      packager.debugServerHost = prefs.getString("previous_host", "") ?: ""
      prefs.edit().remove("previous_host").apply()
    }
    previewHost = endpoint
    return endpoint != null
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
  }
}
