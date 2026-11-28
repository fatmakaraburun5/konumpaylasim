// Faz 6: WidgetKit giriş noktası. Tek widget türü, beş aile; yapılandırma = favori kişi seçici (AppIntentConfiguration).
// Uzantının dağıtım hedefi iOS 17.0 (expo-target.config.js): AppIntentConfiguration, Button(intent:),
// containerBackground ve invalidatableContent doğrudan kullanılabilir.
// [Varsayım] Bu ortamda Xcode yok: derlenmedi, cihazda doğrulanmalı.
import SwiftUI
import WidgetKit

struct KonumFavoritesWidget: Widget {
  static let kind = "KonumFavoritesWidget"

  var body: some WidgetConfiguration {
    AppIntentConfiguration(kind: Self.kind, intent: SelectFavoriteIntent.self, provider: KonumProvider()) { entry in
      KonumWidgetEntryView(entry: entry)
    }
    .configurationDisplayName("Konum favorileri")
    .description("Favori kişilerinin durumu; tek dokunuşla 1 saatlik konum paylaşımı.")
    .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular, .accessoryInline])
  }
}

@main
struct KonumWidgetsBundle: WidgetBundle {
  var body: some Widget {
    KonumFavoritesWidget()
    // Faz 12: kilit ekranı canlı sayacı + Dynamic Island (ActivityKit).
    KonumShareLiveActivity()
  }
}
