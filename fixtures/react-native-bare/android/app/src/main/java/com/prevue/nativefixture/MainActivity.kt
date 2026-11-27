package com.prevue.nativefixture

import android.os.Bundle
import com.facebook.react.packagerconnection.PackagerConnectionSettings
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    if (BuildConfig.DEBUG) {
      val host = intent.getStringExtra("prevueMetroHost")
      val parts = host?.split(':')
      val port = parts?.getOrNull(1)?.toIntOrNull()
      if (parts?.size == 2 && parts[0] == "127.0.0.1" && port != null && port in 1..65535) {
        PackagerConnectionSettings(this).debugServerHost = "127.0.0.1:$port"
      }
    }
    super.onCreate(savedInstanceState)
  }

  override fun getMainComponentName(): String = "PrevueNativeFixture"

  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
}
