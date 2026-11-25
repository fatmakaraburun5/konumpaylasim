/**
 * Faz 6: avatar adresini görüntülenebilir kaynağa çevirir. Native: adres olduğu gibi (Storage indirme adresi,
 * expo-image bellek + disk önbelleği). Web demo kardeşi (`avatarUri.web.ts`) demo "Storage" adreslerini tarayıcıda
 * tutulan data: URI'lerine çevirir.
 */
export function resolveAvatarUri(url: string): string {
  return url;
}

/** Yalnızca web demo: sahte Storage adresi → data: URI kaydı. Native'de no-op. */
export function registerAvatarDataUri(_url: string, _dataUri: string): void {}
