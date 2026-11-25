// Faz 6: widget yapılandırması (iOS 17 AppIntentConfiguration) — "Kişi" seçici, seçenekler anlık görüntüdeki
// favorilerden gelir (uygulama sırası = widget sırası). Seçim yoksa / kişi artık favori değilse default_uid kullanılır.
// [Varsayım] Bu ortamda Xcode yok: derlenmedi, cihazda doğrulanmalı.
import AppIntents
import Foundation
import WidgetKit

struct FavoriteEntity: AppEntity {
  let id: String
  let name: String

  static var typeDisplayRepresentation: TypeDisplayRepresentation = "Favori kişi"
  static var defaultQuery = FavoriteQuery()

  var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(title: "\(name)")
  }
}

struct FavoriteQuery: EntityQuery {
  private func all() -> [FavoriteEntity] {
    guard let snap = WidgetStore.loadSnapshot(), snap.signedIn else { return [] }
    return snap.favorites.map { FavoriteEntity(id: $0.uid, name: $0.name) }
  }

  func entities(for identifiers: [FavoriteEntity.ID]) async throws -> [FavoriteEntity] {
    let wanted = Set(identifiers)
    return all().filter { wanted.contains($0.id) }
  }

  func suggestedEntities() async throws -> [FavoriteEntity] {
    return all()
  }

  func defaultResult() async -> FavoriteEntity? {
    guard let snap = WidgetStore.loadSnapshot(), snap.signedIn, let f = snap.selected(nil) else { return nil }
    return FavoriteEntity(id: f.uid, name: f.name)
  }
}

struct SelectFavoriteIntent: WidgetConfigurationIntent {
  static var title: LocalizedStringResource = "Favori kişi"
  static var description = IntentDescription("Widget'ta durumu gösterilecek ve tek dokunuşla 1 saat paylaşılacak kişi.")

  @Parameter(title: "Kişi")
  var favorite: FavoriteEntity?

  init() {}
}
