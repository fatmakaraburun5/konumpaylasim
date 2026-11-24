/**
 * QR sayfasında isteğe bağlı ek eylem yuvası. Native'de hiçbir şey çizmez; web önizlemesi aynı adla
 * `LinkPreviewAction.web.tsx` sağlar (tek dosyalık web derlemesinde adres çubuğu sabit kaldığı için
 * bağlantıyı uygulama içi izleyicide açan "Bağlantıyı önizle" düğmesi).
 */
export interface LinkPreviewActionProps {
  url: string;
  /** Yönlendirmeden hemen önce (QR sayfasını kapatmak için). */
  onBeforeOpen: () => void;
}

export function LinkPreviewAction(_props: LinkPreviewActionProps) {
  return null;
}
