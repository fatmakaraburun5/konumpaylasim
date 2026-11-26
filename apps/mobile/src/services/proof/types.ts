/**
 * Faz 9: anlık fotoğraf ispatı — kamera bileşeni ile depolar arasındaki ortak tipler.
 *
 * Yerel `features/proof/CameraCapture.tsx` (expo-camera `CameraView`) ve web demosu `CameraCapture.web.tsx` aynı
 * props'u uygular. GALERİ YOLU YOKTUR: bileşen yalnızca o an kamerayla çekilen kareyi `onCaptured` ile verir.
 */
import type { EpochMs } from '@konum/core';

/** Kameradan gelen kare (yeniden kodlanmış ya da kodlanmaya hazır). */
export interface CapturedPhoto {
  /** JPEG, standart base64, `data:` öneki YOK. */
  base64: string;
  width: number;
  height: number;
  /** Deklanşör anı (cihaz saati, epoch ms). Depo sunucu saatine çevirir. */
  captured_at: EpochMs;
  /** Ham kare dosyası (yerel; kodlamadan sonra silinir). Web'de yok. */
  uri?: string;
}

export interface CameraCaptureProps {
  /** Görünür mü (tam ekran kamera). Verilmezse görünür sayılır. */
  visible?: boolean;
  /** Kullanıcı önizlemede "Fotoğrafı ekle"ye bastı. */
  onCaptured(photo: CapturedPhoto): void;
  onCancel(): void;
  /** Üst başlık; verilmezse `PROOF_TEXT.cameraTitle`. */
  title?: string;
}
