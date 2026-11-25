// Faz 6: widget görünümleri. Aileler: systemSmall (seçili kişi + "1 sa" düğmesi), systemMedium (en çok 4 favori,
// her birinde düğme), accessoryCircular (baş harf + geri sayım halkası; dokunuş = hızlı paylaşım), accessoryRectangular
// (ad + durum + zaman / geri sayım), accessoryInline (tek satır).
//
// Gizlilik: `privacy.lock_screen_details == false` (varsayılan) iken kilit ekranı aileleri yalnızca ad + durum + zaman
// gösterir; ana ekrandaki yer / pil satırı `.privacySensitive()` (kilitliyken / StandBy'da örtülür).
// Cinsiyet çerçevesi: kadın pembe, erkek mavi, bilinmiyor gri (core GENDER_RING), beyaz iç boşluk + foto / baş harf.
// [Varsayım] Bu ortamda Xcode yok: derlenmedi, cihazda doğrulanmalı.
import AppIntents
import SwiftUI
import WidgetKit

extension Color {
  init(hex: String) {
    var s = hex.trimmingCharacters(in: .whitespacesAndNewlines)
    if s.hasPrefix("#") { s.removeFirst() }
    if s.count == 6, let v = UInt64(s, radix: 16) {
      self.init(
        red: Double((v >> 16) & 0xFF) / 255.0,
        green: Double((v >> 8) & 0xFF) / 255.0,
        blue: Double(v & 0xFF) / 255.0
      )
    } else {
      self.init(red: 0.61, green: 0.64, blue: 0.69)
    }
  }
}

enum WidgetPalette {
  static let accent = Color(hex: "#2563EB")
  static let initialsBg = Color(hex: "#E5E7EB")
  static let initialsFg = Color(hex: "#374151")
  static let danger = Color(hex: "#DC2626")
  static let live = Color(hex: "#16A34A")
}

struct AvatarView: View {
  let fav: WFavorite
  let size: CGFloat

  var body: some View {
    let ringWidth = max(2, size * 0.07)
    let gap = max(1, size * 0.035)
    let inner = max(1, size - 2 * (ringWidth + gap))
    ZStack {
      Circle().fill(Color(hex: fav.ringHex))
      Circle().fill(Color.white).padding(ringWidth)
      photo
        .frame(width: inner, height: inner)
        .clipShape(Circle())
    }
    .frame(width: size, height: size)
  }

  @ViewBuilder
  private var photo: some View {
    if let img = WidgetStore.avatarImage(fav.avatarFile) {
      Image(uiImage: img)
        .resizable()
        .scaledToFill()
    } else {
      ZStack {
        WidgetPalette.initialsBg
        Text(fav.initials)
          .font(.system(size: size * 0.34, weight: .semibold))
          .foregroundColor(WidgetPalette.initialsFg)
          .minimumScaleFactor(0.5)
          .lineLimit(1)
      }
    }
  }
}

/// Paylaşımım sürüyorsa geri sayım; yoksa "1 sa paylaş" düğmesi (arka plan) ya da derin bağlantı (uygulamayı aç).
struct QuickControl: View {
  let entry: KonumEntry
  let fav: WFavorite
  let source: String
  /// systemSmall ve kilit ekranında `Link` çalışmaz: o zaman yalnızca etiket çizilir, dokunuş `widgetURL`'e düşer.
  let linkAllowed: Bool
  let compact: Bool

  var body: some View {
    if let end = fav.activeShareEnd(nowMs: entry.nowMs) {
      HStack(spacing: 3) {
        Image(systemName: "location.fill")
        Text(timerInterval: entry.date...Date(ms: end), countsDown: true)
          .monospacedDigit()
          .lineLimit(1)
      }
      .font(.system(size: compact ? 11 : 13, weight: .semibold))
      .foregroundColor(WidgetPalette.accent)
    } else if fav.sharingWithoutEnd {
      HStack(spacing: 3) {
        Image(systemName: "location.fill")
        Text("Paylaşıyorsun").lineLimit(1).minimumScaleFactor(0.7)
      }
      .font(.system(size: compact ? 11 : 13, weight: .semibold))
      .foregroundColor(WidgetPalette.accent)
    } else if entry.isPending(fav.uid) {
      label(text: "Başlatılıyor…", icon: "hourglass")
    } else {
      switch entry.route(for: fav.uid) {
      case .background:
        Button(intent: StartQuickShareIntent(toUid: fav.uid, source: source)) {
          label(text: compact ? "1 sa" : "1 sa paylaş", icon: "location.fill")
        }
        .buttonStyle(.plain)
        .invalidatableContent()
      case .openApp:
        if linkAllowed {
          Link(destination: WidgetLinks.quickShare(fav.uid, src: source)) {
            label(text: compact ? "Aç" : "Uygulamada aç", icon: "arrow.up.forward.app")
          }
        } else {
          label(text: compact ? "Aç" : "Uygulamada aç", icon: "arrow.up.forward.app")
        }
      }
    }
  }

  private func label(text: String, icon: String) -> some View {
    HStack(spacing: 3) {
      Image(systemName: icon)
      Text(text).lineLimit(1).minimumScaleFactor(0.7)
    }
    .font(.system(size: compact ? 11 : 13, weight: .semibold))
    .foregroundColor(.white)
    .padding(.horizontal, compact ? 6 : 10)
    .padding(.vertical, compact ? 3 : 5)
    .background(Capsule().fill(WidgetPalette.accent))
  }
}

struct EmptyStateView: View {
  let entry: KonumEntry

  var body: some View {
    VStack(spacing: 6) {
      Image(systemName: "location.circle.fill")
        .font(.system(size: 26))
        .foregroundColor(WidgetPalette.accent)
      Text(WidgetText.emptyText(entry.snapshot))
        .font(.caption)
        .multilineTextAlignment(.center)
        .foregroundColor(.secondary)
    }
  }
}

struct SmallView: View {
  let entry: KonumEntry

  var body: some View {
    if let snap = entry.snapshot, let fav = entry.selected {
      VStack(alignment: .leading, spacing: 4) {
        HStack(spacing: 8) {
          AvatarView(fav: fav, size: 44)
          VStack(alignment: .leading, spacing: 1) {
            Text(fav.name).font(.subheadline.weight(.semibold)).lineLimit(1)
            Text(WidgetText.status(fav, nowMs: entry.nowMs))
              .font(.caption2)
              .foregroundColor(WidgetText.isLive(fav, nowMs: entry.nowMs) ? WidgetPalette.live : .secondary)
              .lineLimit(2)
          }
        }
        if let detail = WidgetText.detail(fav) {
          if snap.privacy.lockScreenDetails {
            Text(detail).font(.caption2).foregroundColor(.secondary).lineLimit(1)
          } else {
            Text(detail).font(.caption2).foregroundColor(.secondary).lineLimit(1).privacySensitive()
          }
        }
        if let err = entry.errorText(for: fav.uid) {
          Text(err).font(.caption2).foregroundColor(WidgetPalette.danger).lineLimit(1)
        }
        Spacer(minLength: 0)
        QuickControl(entry: entry, fav: fav, source: "ios_widget", linkAllowed: false, compact: false)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .widgetURL(tapURL(fav))
    } else {
      EmptyStateView(entry: entry).widgetURL(WidgetLinks.openApp)
    }
  }

  /// Küçük widget tek dokunuş hedefidir: düğme arka planda çalışamıyorsa tüm widget hızlı paylaşım bağlantısını açar.
  private func tapURL(_ fav: WFavorite) -> URL {
    if fav.activeShareEnd(nowMs: entry.nowMs) == nil, !fav.sharingWithoutEnd, !entry.canRunInBackground(fav.uid) {
      return WidgetLinks.quickShare(fav.uid, src: "ios_widget")
    }
    return WidgetLinks.openApp
  }
}

struct MediumView: View {
  let entry: KonumEntry

  var body: some View {
    if let snap = entry.snapshot, snap.signedIn, !snap.favorites.isEmpty {
      HStack(alignment: .top, spacing: 6) {
        ForEach(Array(snap.favorites.prefix(4)), id: \.uid) { fav in
          VStack(spacing: 3) {
            AvatarView(fav: fav, size: 40)
            Text(fav.name).font(.caption.weight(.semibold)).lineLimit(1)
            Text(WidgetText.status(fav, nowMs: entry.nowMs))
              .font(.system(size: 10))
              .foregroundColor(WidgetText.isLive(fav, nowMs: entry.nowMs) ? WidgetPalette.live : .secondary)
              .multilineTextAlignment(.center)
              .lineLimit(2)
            if let err = entry.errorText(for: fav.uid) {
              Text(err).font(.system(size: 9)).foregroundColor(WidgetPalette.danger).lineLimit(1)
            }
            Spacer(minLength: 0)
            QuickControl(entry: entry, fav: fav, source: "ios_widget", linkAllowed: true, compact: true)
          }
          .frame(maxWidth: .infinity)
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .widgetURL(WidgetLinks.openApp)
    } else {
      EmptyStateView(entry: entry).widgetURL(WidgetLinks.openApp)
    }
  }
}

struct CircularView: View {
  let entry: KonumEntry

  var body: some View {
    if let fav = entry.selected {
      if let end = fav.activeShareEnd(nowMs: entry.nowMs) {
        let start = min(entry.date, Date(ms: end - WidgetLimits.quickShareDurationMs))
        ProgressView(timerInterval: start...Date(ms: end), countsDown: true) {
          EmptyView()
        } currentValueLabel: {
          Text(fav.initials).font(.system(size: 14, weight: .bold))
        }
        .progressViewStyle(.circular)
        .widgetURL(WidgetLinks.openApp)
      } else if fav.sharingWithoutEnd {
        VStack(spacing: 0) {
          Text(fav.initials).font(.system(size: 15, weight: .bold)).lineLimit(1).minimumScaleFactor(0.6)
          Image(systemName: "location.fill").font(.system(size: 10))
        }
        .widgetAccentable()
        .widgetURL(WidgetLinks.openApp)
      } else if entry.canRunInBackground(fav.uid) {
        Button(intent: StartQuickShareIntent(toUid: fav.uid, source: "ios_lock")) {
          circleLabel(fav)
        }
        .buttonStyle(.plain)
        .invalidatableContent()
      } else {
        circleLabel(fav).widgetURL(WidgetLinks.quickShare(fav.uid, src: "ios_lock"))
      }
    } else {
      Image(systemName: "location.circle").font(.system(size: 22)).widgetURL(WidgetLinks.openApp)
    }
  }

  private func circleLabel(_ fav: WFavorite) -> some View {
    VStack(spacing: 0) {
      Text(fav.initials).font(.system(size: 15, weight: .bold)).lineLimit(1).minimumScaleFactor(0.6)
      Text("1 sa").font(.system(size: 10, weight: .semibold))
    }
    .widgetAccentable()
  }
}

struct RectangularView: View {
  let entry: KonumEntry

  var body: some View {
    if let snap = entry.snapshot, let fav = entry.selected {
      VStack(alignment: .leading, spacing: 1) {
        HStack(spacing: 4) {
          Image(systemName: "location.fill")
          Text(fav.name).font(.headline).lineLimit(1)
        }
        .widgetAccentable()
        Text(WidgetText.status(fav, nowMs: entry.nowMs, lock: true)).font(.caption).lineLimit(1)
        if let end = fav.activeShareEnd(nowMs: entry.nowMs) {
          HStack(spacing: 3) {
            Text("Paylaşımın:").font(.caption2)
            Text(timerInterval: entry.date...Date(ms: end), countsDown: true).font(.caption2).monospacedDigit()
          }
        } else if snap.privacy.lockScreenDetails, let detail = WidgetText.detail(fav) {
          Text(detail).font(.caption2).lineLimit(1)
        } else if let err = entry.errorText(for: fav.uid) {
          Text(err).font(.caption2).lineLimit(1)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .widgetURL(WidgetLinks.openApp)
    } else {
      Text(WidgetText.emptyText(entry.snapshot)).font(.caption).widgetURL(WidgetLinks.openApp)
    }
  }
}

struct InlineView: View {
  let entry: KonumEntry

  var body: some View {
    if let fav = entry.selected {
      if let end = fav.activeShareEnd(nowMs: entry.nowMs) {
        Text("\(fav.name) · paylaşım \(WidgetText.countdown(end - entry.nowMs))")
      } else {
        Text("\(fav.name) · \(WidgetText.status(fav, nowMs: entry.nowMs, lock: true))")
      }
    } else {
      Text("Konum")
    }
  }
}

struct KonumWidgetEntryView: View {
  @Environment(\.widgetFamily) var family
  let entry: KonumEntry

  var body: some View {
    switch family {
    case .systemMedium:
      MediumView(entry: entry)
        .containerBackground(for: .widget) { Color(uiColor: .systemBackground) }
    case .accessoryCircular:
      CircularView(entry: entry)
        .containerBackground(for: .widget) { AccessoryWidgetBackground() }
    case .accessoryRectangular:
      RectangularView(entry: entry)
        .containerBackground(for: .widget) { Color.clear }
    case .accessoryInline:
      InlineView(entry: entry)
        .containerBackground(for: .widget) { Color.clear }
    default:
      SmallView(entry: entry)
        .containerBackground(for: .widget) { Color(uiColor: .systemBackground) }
    }
  }
}
