// Faz 6: Android widget depoları.
//  - SharedPreferences "konum_widgets" (MODE_PRIVATE): anlık görüntü JSON'u (`konum.widget.snapshot.v1`), olaylar,
//    geçici hızlı paylaşım durumu, belirteç bitişi + uç nokta (gizli değil).
//  - Belirteç: AndroidKeyStore'daki AES-256-GCM anahtarıyla şifrelenip aynı dosyada saklanır (anahtar cihazdan
//    çıkarılamaz). androidx.security:security-crypto 1.1.0'da EncryptedSharedPreferences kullanımdan kaldırıldığı
//    için doğrudan Keystore kullanıldı. `allowBackup=false` (app.config.ts) → yedeğe de girmez.
//  - Avatarlar: filesDir/konum_widget_avatars/<uid>.jpg (120 px kare JPEG, saveAvatar).
// [Varsayım] Bu ortamda Android SDK yok: derlenmedi.
package expo.modules.konumwidgets

import android.content.Context
import android.content.SharedPreferences
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Rect
import android.net.Uri
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class QuickCredential(val token: String, val endpoint: String, val expiresAt: Long)

object WidgetStore {
  private const val PREFS = "konum_widgets"
  const val KEY_SNAPSHOT = "konum.widget.snapshot.v1"
  private const val KEY_EVENTS = "konum.widget.events.v1"
  private const val KEY_QUICK_STATE = "konum.widget.quick_state.v1"
  private const val KEY_TOKEN_EXP = "konum.widget.token_exp.v1"
  private const val KEY_ENDPOINT = "konum.widget.endpoint.v1"
  private const val KEY_TOKEN_ENC = "konum.widget.token_enc.v1"
  private const val KEYSTORE = "AndroidKeyStore"
  private const val KEY_ALIAS = "konum_widget_token_key"
  private const val AVATARS_DIR = "konum_widget_avatars"
  private const val AVATAR_PX = 120
  private const val MAX_EVENTS = 20

  private fun prefs(ctx: Context): SharedPreferences =
    ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  // --- Anlık görüntü

  fun snapshotJson(ctx: Context): String? = prefs(ctx).getString(KEY_SNAPSHOT, null)

  fun snapshot(ctx: Context): WSnapshot? = WidgetJson.parseSnapshot(snapshotJson(ctx))

  fun setSnapshot(ctx: Context, json: String) {
    prefs(ctx).edit().putString(KEY_SNAPSHOT, json).apply()
  }

  /**
   * Hızlı paylaşım sonrası yerinde yama (org.json bilinmeyen alanları korur). core `applyQuickShareToSnapshot` ile
   * aynı: `my_share_expires_at` (süresizse null) + `my_share_active = true`.
   */
  @Synchronized
  fun patchSnapshot(ctx: Context, myShareUid: String?, expiresAt: Long?, tokenOk: Boolean?) {
    val raw = snapshotJson(ctx) ?: return
    try {
      val root = JSONObject(raw)
      if (myShareUid != null) {
        val favs = root.optJSONArray("favorites")
        if (favs != null) {
          for (i in 0 until favs.length()) {
            val f = favs.optJSONObject(i) ?: continue
            if (f.optString("uid") == myShareUid) {
              f.put("my_share_expires_at", expiresAt ?: JSONObject.NULL)
              f.put("my_share_active", true)
            }
          }
        }
      }
      if (tokenOk != null) root.optJSONObject("quick")?.put("token_ok", tokenOk)
      prefs(ctx).edit().putString(KEY_SNAPSHOT, root.toString()).commit()
    } catch (e: Exception) {
      // Bozuk görüntü: uygulamanın bir sonraki yazımı düzeltir.
    }
  }

  // --- Geçici hızlı paylaşım durumu

  fun quickState(ctx: Context): WQuickState? = WQuickState.parse(prefs(ctx).getString(KEY_QUICK_STATE, null))

  fun setQuickState(ctx: Context, s: WQuickState?) {
    val e = prefs(ctx).edit()
    if (s == null) e.remove(KEY_QUICK_STATE) else e.putString(KEY_QUICK_STATE, s.toJson())
    e.commit()
  }

  // --- Olaylar (JS `consumeEvents`)

  @Synchronized
  fun appendEvent(ctx: Context, event: JSONObject) {
    val p = prefs(ctx)
    val list = try {
      JSONArray(p.getString(KEY_EVENTS, "[]") ?: "[]")
    } catch (e: Exception) {
      JSONArray()
    }
    list.put(event)
    val out = JSONArray()
    val from = (list.length() - MAX_EVENTS).coerceAtLeast(0)
    for (i in from until list.length()) out.put(list.get(i))
    p.edit().putString(KEY_EVENTS, out.toString()).commit()
  }

  @Synchronized
  fun consumeEvents(ctx: Context): String {
    val p = prefs(ctx)
    val raw = p.getString(KEY_EVENTS, null) ?: return "[]"
    p.edit().remove(KEY_EVENTS).commit()
    return raw
  }

  // --- Belirteç (Keystore AES-GCM)

  fun tokenExpiresAt(ctx: Context): Long? {
    val v = prefs(ctx).getLong(KEY_TOKEN_EXP, 0L)
    return if (v > 0L) v else null
  }

  private const val FUNCTIONS_REGION = "europe-west1" // backend REGION (functions/src/config.ts)
  private val CALLABLE_NAME_RE = Regex("^[a-z0-9_]{1,64}$")

  /**
   * Uç nokta: tam http(s) URL'si aynen; yalnızca callable adı (core `endpoint_path`, ör. "widget_quick_share")
   * verilirse google-services eklentisinin ürettiği `project_id` kaynağı + europe-west1 ile tam URL kurulur.
   */
  fun resolveEndpoint(ctx: Context, raw: String): String? {
    val e = raw.trim()
    if (e.startsWith("https://") || e.startsWith("http://")) return e
    if (!CALLABLE_NAME_RE.matches(e)) return null
    val res = ctx.applicationContext.resources
    val id = res.getIdentifier("project_id", "string", ctx.applicationContext.packageName)
    if (id == 0) return null
    val projectId = res.getString(id).takeIf { it.isNotBlank() } ?: return null
    return "https://$FUNCTIONS_REGION-$projectId.cloudfunctions.net/$e"
  }

  fun setCredential(ctx: Context, token: String, endpointRaw: String, expiresAt: Long): Boolean {
    val endpoint = resolveEndpoint(ctx, endpointRaw)
    if (endpoint == null) {
      clearCredential(ctx)
      return false
    }
    return try {
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.ENCRYPT_MODE, secretKey())
      val ct = cipher.doFinal(token.toByteArray(Charsets.UTF_8))
      val enc = Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(ct, Base64.NO_WRAP)
      prefs(ctx).edit()
        .putString(KEY_TOKEN_ENC, enc)
        .putString(KEY_ENDPOINT, endpoint)
        .putLong(KEY_TOKEN_EXP, expiresAt)
        .commit()
    } catch (e: Exception) {
      clearCredential(ctx)
      false
    }
  }

  fun clearCredential(ctx: Context) {
    prefs(ctx).edit().remove(KEY_TOKEN_ENC).remove(KEY_ENDPOINT).remove(KEY_TOKEN_EXP).commit()
  }

  fun credential(ctx: Context): QuickCredential? {
    val p = prefs(ctx)
    val enc = p.getString(KEY_TOKEN_ENC, null) ?: return null
    val endpoint = p.getString(KEY_ENDPOINT, null) ?: return null
    val exp = p.getLong(KEY_TOKEN_EXP, 0L)
    if (exp <= 0L) return null
    return try {
      val parts = enc.split(":")
      if (parts.size != 2) return null
      val iv = Base64.decode(parts[0], Base64.NO_WRAP)
      val ct = Base64.decode(parts[1], Base64.NO_WRAP)
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, iv))
      val token = String(cipher.doFinal(ct), Charsets.UTF_8)
      if (token.isEmpty()) null else QuickCredential(token, endpoint, exp)
    } catch (e: Exception) {
      null
    }
  }

  private fun secretKey(): SecretKey {
    val ks = KeyStore.getInstance(KEYSTORE)
    ks.load(null)
    val existing = ks.getKey(KEY_ALIAS, null)
    if (existing is SecretKey) return existing
    val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
    gen.init(
      KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build(),
    )
    return gen.generateKey()
  }

  // --- Avatarlar

  fun avatarFileName(uid: String): String? {
    val safe = uid.filter { it.isLetterOrDigit() && it.code < 128 || it == '_' || it == '-' }.take(64)
    return if (safe.isEmpty()) null else "$safe.jpg"
  }

  private fun avatarsDir(ctx: Context): File {
    val dir = File(ctx.applicationContext.filesDir, AVATARS_DIR)
    if (!dir.exists()) dir.mkdirs()
    return dir
  }

  fun avatarFile(ctx: Context, name: String?): File? {
    if (name.isNullOrEmpty() || name.contains('/') || name.contains("..")) return null
    val f = File(avatarsDir(ctx), name)
    return if (f.isFile) f else null
  }

  /** Yerel dosyayı (file:// ya da content://) 120 px kare JPEG'e küçültüp saklar; dosya adını döner. */
  fun saveAvatar(ctx: Context, uid: String, uri: String): String? {
    val name = avatarFileName(uid) ?: return null
    if (!(uri.startsWith("file://") || uri.startsWith("content://") || uri.startsWith("/"))) return null
    val parsed = if (uri.startsWith("/")) Uri.fromFile(File(uri)) else Uri.parse(uri)
    return try {
      val resolver = ctx.applicationContext.contentResolver
      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      resolver.openInputStream(parsed)?.use { BitmapFactory.decodeStream(it, null, bounds) }
      if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
      var sample = 1
      while (bounds.outWidth / (sample * 2) >= AVATAR_PX && bounds.outHeight / (sample * 2) >= AVATAR_PX) sample *= 2
      val opts = BitmapFactory.Options().apply { inSampleSize = sample }
      val src = resolver.openInputStream(parsed)?.use { BitmapFactory.decodeStream(it, null, opts) } ?: return null
      val side = minOf(src.width, src.height)
      val out = Bitmap.createBitmap(AVATAR_PX, AVATAR_PX, Bitmap.Config.ARGB_8888)
      Canvas(out).drawBitmap(
        src,
        Rect((src.width - side) / 2, (src.height - side) / 2, (src.width + side) / 2, (src.height + side) / 2),
        Rect(0, 0, AVATAR_PX, AVATAR_PX),
        Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG),
      )
      src.recycle()
      val tmp = File(avatarsDir(ctx), "$name.tmp")
      FileOutputStream(tmp).use { out.compress(Bitmap.CompressFormat.JPEG, 85, it) }
      out.recycle()
      val dest = File(avatarsDir(ctx), name)
      if (!tmp.renameTo(dest)) {
        tmp.copyTo(dest, overwrite = true)
        tmp.delete()
      }
      name
    } catch (e: Exception) {
      null
    }
  }

  fun removeAvatar(ctx: Context, uid: String) {
    val name = avatarFileName(uid) ?: return
    File(avatarsDir(ctx), name).delete()
  }
}
