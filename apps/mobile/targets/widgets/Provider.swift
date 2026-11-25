// Faz 6: zaman çizelgesi. Veri yalnızca App Group'taki anlık görüntüden okunur (uzantı ağa çıkmaz; ağ yalnızca
// StartQuickShareIntent'te). Yenileme stratejisi:
//  - Uygulama: önemli değişiklikte (durum / paylaşımım / favoriler / oturum / belirteç) hemen, küçük değişiklikte
//    (son görülme / pil / yer) core WIDGET_LIMITS.reloadMinIntervalMs (5 dk) kısıtıyla `reloadAllTimelines`.
//  - Çizelge: şimdi + 5 dk adımlarla 60 dk (metinlerdeki "N dk önce" güncel kalsın; giriş eklemek yenileme
//    bütçesi harcamaz) + her favorinin bayatlık sınırı (son paket + 15 dk) + paylaşımımın bitişi + hata
//    durumunun bitişi; politika `.after(şimdi + 60 dk)`.
//  - Geri sayım `Text(timerInterval:)` ile sistemce canlı çizilir (giriş gerektirmez).
// [Varsayım] Bu ortamda Xcode yok: derlenmedi, cihazda doğrulanmalı.
import Foundation
import WidgetKit

struct KonumEntry: TimelineEntry {
  let date: Date
  let snapshot: WSnapshot?
  let configuredUid: String?
  let tokenExpMs: Double?
  let quick: WQuickState?

  var nowMs: Double { date.ms }

  var selected: WFavorite? {
    guard let snap = snapshot, snap.signedIn else { return nil }
    return snap.selected(configuredUid)
  }

  func route(for uid: String) -> QuickRoute {
    return WidgetRoute.route(snapshot: snapshot, targetUid: uid, tokenExpMs: tokenExpMs, quick: quick, nowMs: nowMs)
  }

  func canRunInBackground(_ uid: String) -> Bool {
    return route(for: uid) == .background
  }

  /// Bu kişi için son 2 dk içindeki hata metni (yoksa nil).
  func errorText(for uid: String) -> String? {
    guard let q = quick, q.phase == "error", q.toUid == uid, nowMs - q.at < WidgetLimits.errorFallbackMs else { return nil }
    return WidgetText.quickError(q.error)
  }

  func isPending(_ uid: String) -> Bool {
    guard let q = quick, q.phase == "pending", q.toUid == uid else { return false }
    return nowMs - q.at < WidgetLimits.pendingMs
  }

  func at(_ date: Date) -> KonumEntry {
    return KonumEntry(date: date, snapshot: snapshot, configuredUid: configuredUid, tokenExpMs: tokenExpMs, quick: quick)
  }

  static func load(date: Date, configuredUid: String?) -> KonumEntry {
    return KonumEntry(
      date: date,
      snapshot: WidgetStore.loadSnapshot(),
      configuredUid: configuredUid,
      tokenExpMs: WidgetStore.tokenExpiresAt(),
      quick: WidgetStore.quickState()
    )
  }

  static var placeholder: KonumEntry {
    let now = Date()
    let fav = WFavorite(
      uid: "placeholder", name: "Ayşe", initials: "A", gender: "female", ring: "#EC4899", avatarFile: nil,
      status: "sharing_live", lastSeenAt: now.ms - 180_000, place: "Ev", batteryPct: 76, batteryLow: false,
      myShareExpiresAt: nil, myShareActive: false
    )
    let snap = WSnapshot(
      v: 1, generatedAt: now.ms, signedIn: true, meInitials: "B", defaultUid: fav.uid, favorites: [fav],
      quick: WQuick(tokenOk: true, bgLocationOk: true), privacy: WPrivacy(lockScreenDetails: false)
    )
    return KonumEntry(date: now, snapshot: snap, configuredUid: nil, tokenExpMs: nil, quick: nil)
  }
}

struct KonumProvider: AppIntentTimelineProvider {
  func placeholder(in context: Context) -> KonumEntry {
    return KonumEntry.placeholder
  }

  func snapshot(for configuration: SelectFavoriteIntent, in context: Context) async -> KonumEntry {
    let entry = KonumEntry.load(date: Date(), configuredUid: configuration.favorite?.id)
    if context.isPreview && entry.selected == nil { return KonumEntry.placeholder }
    return entry
  }

  func timeline(for configuration: SelectFavoriteIntent, in context: Context) async -> Timeline<KonumEntry> {
    let now = Date()
    let base = KonumEntry.load(date: now, configuredUid: configuration.favorite?.id)
    let horizon = now.addingTimeInterval(60 * 60)
    var dates: [Date] = (0...12).map { now.addingTimeInterval(Double($0) * 5 * 60) }

    func add(_ ms: Double) {
      let d = Date(ms: ms + 1_000)
      if d > now && d < horizon { dates.append(d) }
    }
    if let snap = base.snapshot {
      for f in snap.favorites {
        // core `widgetNextChangeAt`: canlı → bağlantı yok sınırı ve paylaşımımın bitişi.
        if f.status == "sharing_live", let t = f.lastSeenAt { add(t + WidgetLimits.staleAfterMs) }
        if let e = f.myShareExpiresAt { add(e) }
      }
    }
    if let q = base.quick {
      add(q.at + (q.phase == "pending" ? WidgetLimits.pendingMs : WidgetLimits.errorFallbackMs))
    }
    let sorted = Array(Set(dates.map { $0.timeIntervalSince1970.rounded() })).sorted().map { Date(timeIntervalSince1970: $0) }
    return Timeline(entries: sorted.map { base.at($0) }, policy: .after(horizon))
  }
}
