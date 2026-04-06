package com.AppPlatformReactNativeApp.trakplusble
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.AppPlatformReactNativeApp.R
class AppDeviceBleForegroundService : Service() {
  override fun onCreate() {
    super.onCreate()
    ensureNotificationChannel()
  }
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val notification = buildNotification()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(
        NOTIFICATION_ID,
        notification,
        ServiceInfoCompat.CONNECTED_DEVICE_TYPE
      )
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    return START_STICKY
  }
  override fun onBind(intent: Intent?): IBinder? = null
  override fun onDestroy() {
    stopForeground(STOP_FOREGROUND_REMOVE)
    super.onDestroy()
  }
  private fun ensureNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      return
    }
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    val channel = NotificationChannel(
      CHANNEL_ID,
      CHANNEL_NAME,
      NotificationManager.IMPORTANCE_LOW
    ).apply {
      description = "Maintains reliable AppPlatform BLE connectivity while app is backgrounded."
      setShowBadge(false)
    }
    manager.createNotificationChannel(channel)
  }
  private fun buildNotification(): Notification {
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle("AppPlatform Bluetooth active")
      .setContentText("Maintaining secure device connection")
      .setSmallIcon(R.mipmap.ic_launcher)
      .setOngoing(true)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setOnlyAlertOnce(true)
      .build()
  }
  companion object {
    private const val LOG_TAG = "AppDeviceBLEFgSvc"
    private const val CHANNEL_ID = "trakplus_ble_connected_device"
    private const val CHANNEL_NAME = "AppPlatform BLE Connection"
    private const val NOTIFICATION_ID = 30151
    fun start(context: Context): Boolean {
      return try {
        val intent = Intent(context, AppDeviceBleForegroundService::class.java)
        ContextCompat.startForegroundService(context, intent)
        true
      } catch (e: SecurityException) {
        Log.e(LOG_TAG, "SecurityException starting foreground service: ${e.message}")
        false
      } catch (e: IllegalStateException) {
        Log.w(LOG_TAG, "Cannot start foreground service (background-restricted): ${e.message}")
        false
      }
    }
    fun stop(context: Context) {
      try {
        val intent = Intent(context, AppDeviceBleForegroundService::class.java)
        context.stopService(intent)
      } catch (e: Exception) {
        Log.w(LOG_TAG, "Error stopping foreground service: ${e.message}")
      }
    }
  }
}
private object ServiceInfoCompat {
  const val CONNECTED_DEVICE_TYPE = 0x10
}
