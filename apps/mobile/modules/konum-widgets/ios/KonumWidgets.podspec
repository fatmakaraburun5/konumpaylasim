# Faz 6: ana ekran / kilit ekranı widget köprüsü (yerel Expo modülü, modules/konum-widgets).
# Uygulama tarafı: anlık görüntüyü App Group'a yazar, avatarları küçültür, hızlı paylaşım belirtecini paylaşılan
# anahtarlığa koyar, widget olaylarını okur. Widget'ın kendisi ayrı hedeftir (targets/widgets, @bacons/apple-targets).
# [Varsayım] Bu ortamda Xcode yok: pod derlenmedi; ilk development build'de doğrulanmalı.
Pod::Spec.new do |s|
  s.name           = 'KonumWidgets'
  s.version        = '0.1.0'
  s.summary        = 'Konum: widget anlık görüntüsü / hızlı paylaşım köprüsü'
  s.description    = s.summary
  s.license        = 'UNLICENSED'
  s.author         = 'Konum'
  s.homepage       = 'https://example.com/konum'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'WidgetKit', 'Security', 'UIKit', 'ActivityKit'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
