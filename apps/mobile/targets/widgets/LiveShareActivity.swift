// Faz 12: kilit ekranı canlı sayacı (Live Activity) + Dynamic Island.
//
// Veri modeli core `liveActivity.ts` ile birebir (snake_case JSON → Codable). Uygulama tarafı aynı adlı
// `KonumShareAttributes` yapısını modules/konum-widgets/ios/LiveShareBridge.swift içinde tanımlar; ActivityKit iki
// hedefteki yapıyı ADI ve Codable biçimi üzerinden eşler — iki dosya birlikte değişmeli.
//
// Sayaç yerelde akar: `Text(timerInterval:countsDown:)` + `ProgressView(timerInterval:)`; uygulama yalnızca içerik
// değişince günceller (alıcı / mola / ETA / son 5 dk / bitti).
// Görünüm:
//   kilit ekranı: [avatar (pembe/mavi halka)] "Konumun paylaşılıyor · Ayşe +1"  ⏱ 41:52
//                 ilerleme çubuğu · "Ayşe ~12 dk" (ETA) · [Mola 15 dk] [Durdur]
//   Dynamic Island kompakt: avatar | 42 dk (molada "☕ 12 dk")   minimal: halka içinde kalan dakika
// [Varsayım] Bu ortamda Xcode yok: derlenmedi, cihazda doğrulanmalı (iOS 16.2+, Dynamic Island iPhone 14 Pro+).
import ActivityKit
import SwiftUI
import WidgetKit

struct KonumShareAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable {
    struct Person: Codable, Hashable {
      var uid: String
      var name: String
      var initials: String
      var ring: String // female | male | none
      var avatar_key: String?
    }
    struct Eta: Codable, Hashable {
      var label: String
      var kind: String
      var arrive_at: Double
      var computed_at: Double
    }
    var v: Int
    var phase: String // sharing | expiring | paused | ended
    var ends_at: Double?
    var started_at: Double
    var break_until: Double?
    var lead: Person
    var receivers: Int
    var eta: Eta?
    var title: String
    var subtitle: String
    var at: Double
  }

  var v: Int
  var activity_id: String
  var started_at: Double
}

private extension KonumShareAttributes.ContentState {
  var ringColor: Color {
    switch lead.ring {
    case "female": return Color(hex: "#EC4899")
    case "male": return Color(hex: "#3B82F6")
    default: return Color(hex: "#9CA3AF")
    }
  }
  var tint: Color {
    switch phase {
    case "expiring": return Color(hex: "#F59E0B")
    case "paused": return Color(hex: "#A16207")
    case "ended": return Color(hex: "#6B7280")
    default: return WidgetPalette.live
    }
  }
  var endDate: Date? { ends_at.map { Date(timeIntervalSince1970: $0 / 1000) } }
  var startDate: Date { Date(timeIntervalSince1970: started_at / 1000) }
  var breakDate: Date? { break_until.map { Date(timeIntervalSince1970: $0 / 1000) } }
  var arriveDate: Date? { eta.map { Date(timeIntervalSince1970: $0.arrive_at / 1000) } }
}

private func liveLink(_ action: String) -> URL {
  URL(string: "konum://live?action=\(action)")!
}

struct LiveAvatar: View {
  let state: KonumShareAttributes.ContentState
  let size: CGFloat

  var body: some View {
    let ring = max(2, size * 0.08)
    ZStack {
      Circle().fill(state.ringColor)
      Circle().fill(Color.white).padding(ring)
      Group {
        if let img = WidgetStore.avatarImage(state.lead.avatar_key.map { "\($0).jpg" }) {
          Image(uiImage: img).resizable().scaledToFill()
        } else {
          ZStack {
            WidgetPalette.initialsBg
            Text(state.lead.initials).font(.system(size: size * 0.36, weight: .semibold)).foregroundColor(WidgetPalette.initialsFg)
          }
        }
      }
      .frame(width: size - ring * 2 - 3, height: size - ring * 2 - 3)
      .clipShape(Circle())
    }
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }
}

/// Kalan süre: sayaç (süreli) · "Süresiz" · mola geri sayımı · "Bitti".
struct LiveCountdown: View {
  let state: KonumShareAttributes.ContentState
  var font: Font = .title2.monospacedDigit().weight(.semibold)

  var body: some View {
    Group {
      if state.phase == "ended" {
        Text("Bitti")
      } else if state.phase == "paused", let b = state.breakDate, b > Date() {
        Text(timerInterval: Date()...b, countsDown: true)
      } else if let end = state.endDate, end > Date() {
        Text(timerInterval: Date()...end, countsDown: true)
      } else if state.ends_at == nil {
        Text("Süresiz")
      } else {
        Text("0:00")
      }
    }
    .font(font)
    .foregroundColor(state.tint)
    .multilineTextAlignment(.trailing)
  }
}

struct LiveLockScreenView: View {
  let state: KonumShareAttributes.ContentState

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 10) {
        LiveAvatar(state: state, size: 44)
        VStack(alignment: .leading, spacing: 2) {
          Text(state.title).font(.subheadline.weight(.semibold)).lineLimit(1)
          Text(state.subtitle).font(.caption).foregroundColor(.secondary).lineLimit(1)
        }
        Spacer(minLength: 4)
        LiveCountdown(state: state)
      }
      if state.phase != "ended", let end = state.endDate, end > state.startDate {
        ProgressView(timerInterval: state.startDate...end, countsDown: true) { EmptyView() } currentValueLabel: { EmptyView() }
          .tint(state.tint)
      }
      if state.phase != "ended" {
        HStack(spacing: 8) {
          if let eta = state.eta, let at = state.arriveDate, at > Date() {
            Label {
              Text("\(eta.label) · ") + Text(at, style: .relative)
            } icon: {
              Image(systemName: eta.kind == "friend" ? "figure.walk" : "flag.checkered")
            }
            .font(.caption.weight(.medium))
            .lineLimit(1)
          }
          Spacer(minLength: 0)
          Link(destination: liveLink(state.phase == "paused" ? "resume" : "break15")) {
            Text(state.phase == "paused" ? "Devam et" : "Mola 15 dk").font(.caption.weight(.semibold))
              .padding(.horizontal, 10).padding(.vertical, 6)
              .background(Capsule().fill(Color.secondary.opacity(0.18)))
          }
          Link(destination: liveLink("stop")) {
            Text("Durdur").font(.caption.weight(.semibold)).foregroundColor(WidgetPalette.danger)
              .padding(.horizontal, 10).padding(.vertical, 6)
              .background(Capsule().fill(WidgetPalette.danger.opacity(0.14)))
          }
        }
      }
    }
    .padding(14)
    .accessibilityElement(children: .combine)
  }
}

struct KonumShareLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: KonumShareAttributes.self) { context in
      LiveLockScreenView(state: context.state)
        .activityBackgroundTint(Color(.systemBackground).opacity(0.92))
        .activitySystemActionForegroundColor(.primary)
        .widgetURL(liveLink("open"))
    } dynamicIsland: { context in
      let s = context.state
      return DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          LiveAvatar(state: s, size: 40)
        }
        DynamicIslandExpandedRegion(.trailing) {
          LiveCountdown(state: s, font: .title3.monospacedDigit().weight(.semibold))
        }
        DynamicIslandExpandedRegion(.center) {
          VStack(spacing: 2) {
            Text(s.title).font(.caption.weight(.semibold)).lineLimit(1)
            Text(s.subtitle).font(.caption2).foregroundColor(.secondary).lineLimit(1)
          }
        }
        DynamicIslandExpandedRegion(.bottom) {
          if s.phase != "ended", let end = s.endDate, end > s.startDate {
            ProgressView(timerInterval: s.startDate...end, countsDown: true) { EmptyView() } currentValueLabel: { EmptyView() }
              .tint(s.tint)
          }
        }
      } compactLeading: {
        LiveAvatar(state: s, size: 22)
      } compactTrailing: {
        if s.phase == "paused" {
          Text("☕").font(.caption2)
        } else {
          LiveCountdown(state: s, font: .caption2.monospacedDigit().weight(.semibold)).frame(maxWidth: 48)
        }
      } minimal: {
        LiveAvatar(state: s, size: 22)
      }
      .widgetURL(liveLink("open"))
      .keylineTint(s.tint)
    }
  }
}
