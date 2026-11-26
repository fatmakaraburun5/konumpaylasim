/**
 * Faz 9: kamera → `proofStore.addPhoto` akışı (durum notu sayfası ve paylaşım kitapçığı ortak kullanır).
 * Kamera kapanır kapanmaz yükleme başlar; ilerleme `proofStore.phase` ("Ekleniyor…"), hata uyarıyla gösterilir.
 * Galeri yolu yoktur (bkz. CameraCapture).
 */
import { PROOF_TEXT } from '@konum/core';
import { useCallback, useState } from 'react';
import { Alert } from 'react-native';
import type { CapturedPhoto } from '../../services/proof/types';
import { proofStore } from '../../state/proofStore';
import { CameraCapture } from './CameraCapture';

export interface ProofCaptureProps {
  visible: boolean;
  /** Fotoğraf açıklaması (ör. durum notu metni "Mekana geçtim, masamız burası"). */
  caption?: string | null;
  onClose: () => void;
  /** Yükleme bitti (başarılı mı). */
  onDone?: (ok: boolean) => void;
}

export function ProofCapture({ visible, caption = null, onClose, onDone }: ProofCaptureProps) {
  const [retry, setRetry] = useState(false);
  const captured = useCallback(
    async (photo: CapturedPhoto) => {
      onClose();
      const r = await proofStore.getState().addPhoto(photo, { caption });
      onDone?.(r.ok);
      if (r.ok) return;
      proofStore.getState().clearError();
      if (r.error.code === 'proof_stale_capture') {
        Alert.alert(PROOF_TEXT.cameraTitle, PROOF_TEXT.stale, [
          { text: 'Vazgeç', style: 'cancel' },
          { text: PROOF_TEXT.retake, onPress: () => setRetry(true) },
        ]);
      } else {
        Alert.alert('Fotoğraf eklenemedi', r.error.message);
      }
    },
    [caption, onClose, onDone],
  );
  return (
    <CameraCapture
      visible={visible || retry}
      onCaptured={(p) => {
        setRetry(false);
        void captured(p);
      }}
      onCancel={() => {
        setRetry(false);
        onClose();
      }}
    />
  );
}
