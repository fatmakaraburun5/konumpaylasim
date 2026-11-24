// Faz 3: Android Activity Recognition Transition API → JS "onActivity" olayı.
//
// Olay: { type: still|walking|running|cycling|automotive|unknown, confidence: "high", at: ms (cihaz saati) }
//  - Geçiş (transition) olayları PendingIntent yayınıyla gelir (ActivityTransitionReceiver): uygulama arka plandayken
//    ya da JS çalışmıyorken de alınır; son olay SharedPreferences'a yazılır, konum görevi uyandığında
//    `getLastActivity` ile okunur. JS ayaktaysa olay ayrıca anında yayılır.
//  - Geçiş API'si yalnızca "emin olduğu" geçişleri bildirir: güven "high" kabul edilir.
//  - İzin: Android 10+ (API 29) ACTIVITY_RECOGNITION çalışma zamanı izni ("Fiziksel etkinlik").
// [Varsayım] Bu ortamda Android SDK yok: derlenmedi, cihazda doğrulanmalı.
package expo.modules.konumactivity

import android.Manifest
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.location.ActivityRecognition
import com.google.android.gms.location.ActivityTransition
import com.google.android.gms.location.ActivityTransitionRequest
import com.google.android.gms.location.DetectedActivity
import expo.modules.interfaces.permissions.Permissions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class KonumActivityModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("KonumActivity")

    Events("onActivity")

    OnCreate {
      ActivityTransitionReceiver.listener = { payload -> sendEvent("onActivity", payload) }
    }

    OnDestroy {
      ActivityTransitionReceiver.listener = null
    }

    Function("isAvailable") {
      GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context) == ConnectionResult.SUCCESS
    }

    AsyncFunction("getPermissionStatusAsync") { promise: Promise ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
        promise.resolve("granted")
        return@AsyncFunction
      }
      Permissions.getPermissionsWithPermissionsManager(appContext.permissions, promise, Manifest.permission.ACTIVITY_RECOGNITION)
    }

    AsyncFunction("requestPermissionAsync") { promise: Promise ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
        promise.resolve("granted")
        return@AsyncFunction
      }
      Permissions.askForPermissionsWithPermissionsManager(appContext.permissions, promise, Manifest.permission.ACTIVITY_RECOGNITION)
    }

    AsyncFunction("startAsync") { promise: Promise ->
      if (!hasPermission()) {
        promise.resolve(false)
        return@AsyncFunction
      }
      try {
        ActivityRecognition.getClient(context)
          .requestActivityTransitionUpdates(transitionRequest(), pendingIntent())
          .addOnSuccessListener { promise.resolve(true) }
          .addOnFailureListener { promise.resolve(false) }
      } catch (e: SecurityException) {
        promise.resolve(false)
      }
    }

    AsyncFunction("stopAsync") { promise: Promise ->
      try {
        ActivityRecognition.getClient(context)
          .removeActivityTransitionUpdates(pendingIntent())
          .addOnCompleteListener { promise.resolve(null) }
      } catch (e: SecurityException) {
        promise.resolve(null)
      }
    }

    Function("getLastActivity") {
      ActivityTransitionReceiver.readLast(context)
    }
  }

  private fun hasPermission(): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.Q ||
      ContextCompat.checkSelfPermission(context, Manifest.permission.ACTIVITY_RECOGNITION) == PackageManager.PERMISSION_GRANTED

  private fun transitionRequest(): ActivityTransitionRequest {
    val types = listOf(
      DetectedActivity.STILL,
      DetectedActivity.WALKING,
      DetectedActivity.RUNNING,
      DetectedActivity.ON_BICYCLE,
      DetectedActivity.IN_VEHICLE,
    )
    val transitions = types.map { type ->
      ActivityTransition.Builder()
        .setActivityType(type)
        .setActivityTransition(ActivityTransition.ACTIVITY_TRANSITION_ENTER)
        .build()
    }
    return ActivityTransitionRequest(transitions)
  }

  private fun pendingIntent(): PendingIntent {
    val intent = Intent(context, ActivityTransitionReceiver::class.java).setAction(ActivityTransitionReceiver.ACTION)
    // Android 12+: sistem sonuç ekstralarını yazar → MUTABLE zorunlu.
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
    return PendingIntent.getBroadcast(context, 4210, intent, flags)
  }
}
