package com.prevue.nativefixture

import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.fragment.app.FragmentActivity
import com.facebook.react.ReactFragment
import com.facebook.react.modules.core.DefaultHardwareBackBtnHandler

class MainActivity : FragmentActivity(), DefaultHardwareBackBtnHandler {
  private lateinit var openButton: Button

  override fun onCreate(savedInstanceState: Bundle?) {
    val application = application as MainApplication
    val preview = BuildConfig.DEBUG && application.selectPreviewHost(intent.getStringExtra("prevueMetroHost"))
    super.onCreate(savedInstanceState)
    val margin = (16 * resources.displayMetrics.density).toInt()
    val layout = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      fitsSystemWindows = true
      setPadding(margin, margin, margin, 0)
    }
    val heading = TextView(this).apply {
      text = "운송 현황"
      textSize = 28f
      id = R.id.native_landing_heading
    }
    layout.addView(heading)
    openButton = Button(this).apply {
      id = R.id.open_regular_shipment
      text = "운송 화면 열기"
      setOnClickListener { openShipment() }
    }
    layout.addView(openButton)
    val container = FrameLayout(this).apply { id = R.id.shipment_surface }
    layout.addView(container, LinearLayout.LayoutParams(-1, 0, 1f))
    setContentView(layout)
    if (supportFragmentManager.findFragmentByTag("shipment") != null) openButton.visibility = View.GONE
    else if (preview) openShipment()
  }

  private fun openShipment() {
    openButton.visibility = View.GONE
    val shipment = ReactFragment.Builder().setComponentName("PrevueNativeFixture").build()
    supportFragmentManager.beginTransaction().replace(R.id.shipment_surface, shipment, "shipment").commitNow()
  }

  override fun invokeDefaultOnBackPressed() = finish()
}
