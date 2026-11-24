#!/usr/bin/env bash
# Faz 2 entegrasyon e2e (GERÇEK emülatörler + gerçek web derlemesi + mobil yayıncı kodu).
# Emülatörlerin İÇİNDEN çalıştırılır:
#   cd backend && npm run build && \
#     npx firebase emulators:exec --project demo-konum --only auth,firestore,database,functions "bash ../apps/web/e2e/run-emulator.sh"
# Ortam: OUT (ekran görüntüleri, varsayılan apps/web/e2e-output), WEB_PORT (varsayılan 8211), SKIP_WEB_BUILD=1.
set -euo pipefail
web="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$web/../.." && pwd)"
# İstemci trafiği doğrudan emülatöre gider (vekil sunucu yok).
unset HTTPS_PROXY https_proxy HTTP_PROXY http_proxy
export NO_PROXY=127.0.0.1,localhost
export NODE_PATH="$repo/backend/functions/node_modules:$repo/backend/node_modules${NODE_PATH:+:$NODE_PATH}"
cd "$web"
node e2e/integration/build-lib.mjs
if [ "${SKIP_WEB_BUILD:-0}" != "1" ]; then
  VITE_USE_EMULATORS=1 npx vite build --outDir dist-emu --emptyOutDir --logLevel warn
fi
node e2e/emulator.cjs
