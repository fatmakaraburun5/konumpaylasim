/**
 * Faz 6 (native): favorinin küçük boy fotoğrafını (160 px, indirme token'lı adres) önbellek klasörüne indirir;
 * widgetSync sonra yerel `saveAvatar(uid, dosya)` ile 120 px kopyasını paylaşılan alana (App Group / uygulama
 * dosyaları) yazdırır. Widget uzantısı ağa çıkmaz. Hata → null (widget baş harfleri gösterir).
 */
import { Directory, File, Paths } from 'expo-file-system';

const DIR = 'widget-avatars';

export async function downloadWidgetAvatar(uid: string, url: string): Promise<string | null> {
  if (!/^https?:\/\//.test(url) || !/^[A-Za-z0-9_-]{1,128}$/.test(uid)) return null;
  try {
    const dir = new Directory(Paths.cache, DIR);
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    const out = await File.downloadFileAsync(url, new File(dir, `${uid}.jpg`), { idempotent: true });
    return out.uri;
  } catch {
    return null;
  }
}

export async function clearWidgetAvatarDownloads(): Promise<void> {
  try {
    const dir = new Directory(Paths.cache, DIR);
    if (dir.exists) dir.delete();
  } catch {
    // yok say
  }
}
