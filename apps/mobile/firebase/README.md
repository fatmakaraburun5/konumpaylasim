# Firebase yapılandırma dosyaları

Bu klasöre Firebase konsolundan indirilen dosyaları koyun (depoya girmez, bkz. `.gitignore`):

- `google-services.json` (Android, paket adı `com.example.konum`)
- `GoogleService-Info.plist` (iOS, bundle id `com.example.konum`)

Farklı bir yol kullanmak için `.env` içinde `GOOGLE_SERVICES_JSON` / `GOOGLE_SERVICE_INFO_PLIST` tanımlayın.
