// Faz 6: widget avatarı — cinsiyet çerçeve şeridi (kadın pembe / erkek mavi / bilinmiyor gri, core GENDER_RING),
// beyaz iç boşluk, içte daire kırpılmış fotoğraf (saveAvatar dosyası) ya da baş harfler. Canvas ile çizilir; RemoteViews
// `setImageViewBitmap` ile taşınır (bit eşlem bellek sınırı için küçük tutulur: en çok 4 x 144 px).
// [Varsayım] Bu ortamda Android SDK yok: derlenmedi.
package expo.modules.konumwidgets

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Shader
import android.graphics.Typeface

object AvatarRenderer {
  private const val NEUTRAL_RING = "#9CA3AF"

  private fun parseColor(hex: String): Int = try {
    Color.parseColor(hex)
  } catch (e: IllegalArgumentException) {
    Color.parseColor(NEUTRAL_RING)
  }

  fun render(ctx: Context, fav: WFavorite, sizePx: Int): Bitmap {
    val size = sizePx.coerceIn(48, 192)
    val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
    val c = Canvas(bmp)
    val r = size / 2f
    val ring = (size * 0.07f).coerceAtLeast(3f)
    val gap = (size * 0.035f).coerceAtLeast(1.5f)
    val inner = r - ring - gap

    // Çerçeve şeridi (dolu daire) + beyaz iç boşluk.
    c.drawCircle(r, r, r, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = parseColor(fav.ring) })
    c.drawCircle(r, r, r - ring, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE })

    val photo = WidgetStore.avatarFile(ctx, fav.avatarFile)?.let { f ->
      try {
        BitmapFactory.decodeFile(f.absolutePath)
      } catch (e: Exception) {
        null
      }
    }
    if (photo != null && photo.width > 0 && photo.height > 0) {
      val bs = BitmapShader(photo, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP)
      val scale = (inner * 2f) / minOf(photo.width, photo.height).toFloat()
      val m = Matrix()
      m.setScale(scale, scale)
      m.postTranslate(r - photo.width * scale / 2f, r - photo.height * scale / 2f)
      bs.setLocalMatrix(m)
      c.drawCircle(r, r, inner, Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG).apply { shader = bs })
    } else {
      c.drawCircle(r, r, inner, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#E5E7EB") })
      val text = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#374151")
        textAlign = Paint.Align.CENTER
        typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        textSize = inner * (if (fav.initials.length > 1) 0.8f else 0.95f)
      }
      val y = r - (text.descent() + text.ascent()) / 2f
      c.drawText(fav.initials.take(2), r, y, text)
    }
    return bmp
  }
}
