/** Web demo: yerel widget yok; avatar indirme no-op (önizlemeler doğrudan fotoğraf adresini çizer). */
export async function downloadWidgetAvatar(_uid: string, _url: string): Promise<string | null> {
  return null;
}

export async function clearWidgetAvatarDownloads(): Promise<void> {}
