/**
 * Web demo: anlık fotoğraf kamerası (native `CameraCapture.tsx` ile aynı props) — docs/PHASE9.md §1.1, §7.
 *
 *   simüle vizör (tuvalde canlı sahne: kafe masası / trafik) · deklanşör → o anın karesi
 *   `canvas.toDataURL('image/jpeg', 0,7)` → önizleme: "Yeniden çek" / "Fotoğrafı ekle" → `onCaptured(photo)`
 *
 * YALNIZCA kamera: galeri düğmesi, dosya seçici (`<input type=file>`), sürükle-bırak YOKTUR; tarayıcı kamerası da
 * istenmez (demo bir iPhone kamerasını taklit eder). Kamera izni demo izin simülasyonundan okunur.
 * Kaplama telefon çerçevesinin içine çizilir (`ScreenPortal`).
 */
import { PROOF_LIMITS, PROOF_TEXT } from '@konum/core';
import { useEffect, useRef, useState } from 'react';
import { Image, Pressable, StyleSheet, View } from 'react-native';
import { ScreenPortal } from '../../demo/web/screenHost';
import { drawProofScene, PROOF_SCENES, renderProofJpeg, type ProofSceneKind } from '../../demo/web/proofScene';
import { readMediaPermissions, requestCameraPermission } from '../../services/permissions/mediaPermissions';
import type { CameraCaptureProps, CapturedPhoto } from '../../services/proof/types';
import { Button, Text } from '../../ui';

const FG = '#FFFFFF';
/** Portre kare (telefon arka kamerası): 960 × 1280. */
const SHOT_W = 960;
const SHOT_H = 1280;

export function CameraCapture({ visible = true, onCaptured, onCancel, title }: CameraCaptureProps) {
  if (!visible) return null;
  return (
    <ScreenPortal>
      <CameraSheet onCaptured={onCaptured} onCancel={onCancel} title={title} />
    </ScreenPortal>
  );
}

function CameraSheet({ onCaptured, onCancel, title }: Omit<CameraCaptureProps, 'visible'>) {
  const [perm, setPerm] = useState<'checking' | 'granted' | 'denied'>('checking');
  const [scene, setScene] = useState<ProofSceneKind>('cafe');
  const [shot, setShot] = useState<CapturedPhoto | null>(null);
  const [flash, setFlash] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef(scene);
  sceneRef.current = scene;

  useEffect(() => {
    let live = true;
    void (async () => {
      const p = await readMediaPermissions();
      const st = p.camera === 'granted' ? 'granted' : p.cameraCanAskAgain ? await requestCameraPermission() : p.camera;
      if (live) setPerm(st === 'granted' ? 'granted' : 'denied');
    })().catch(() => live && setPerm('denied'));
    return () => {
      live = false;
    };
  }, []);

  // Vizör: her karede sahne (buhar / arka lambalar / el titremesi).
  useEffect(() => {
    if (perm !== 'granted' || shot) return;
    let raf = 0;
    const t0 = performance.now();
    const loop = () => {
      const c = canvasRef.current;
      const ctx = c?.getContext('2d');
      if (c && ctx) drawProofScene(ctx, c.width, c.height, performance.now() - t0 + 1, sceneRef.current, true);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [perm, shot]);

  const take = () => {
    const at = Date.now();
    const img = renderProofJpeg(sceneRef.current, at, SHOT_W, SHOT_H, PROOF_LIMITS.jpegQuality);
    if (!img) return;
    setFlash(true);
    setTimeout(() => setFlash(false), 140);
    setShot({ base64: img.base64, width: img.width, height: img.height, captured_at: at });
  };

  const use = () => {
    if (!shot) return;
    const s = shot;
    setShot(null);
    onCaptured(s);
  };

  return (
    <View style={[StyleSheet.absoluteFill, styles.root]} accessibilityViewIsModal testID="proof-camera">
      <View style={styles.top}>
        <Pressable accessibilityRole="button" accessibilityLabel="Vazgeç" onPress={onCancel} hitSlop={8} testID="proof-camera-cancel">
          <Text variant="label" style={{ color: FG }}>
            Vazgeç
          </Text>
        </Pressable>
        <Text variant="label" style={{ color: FG, fontWeight: '600' }}>
          {title ?? PROOF_TEXT.cameraTitle}
        </Text>
        <View style={{ width: 52 }} />
      </View>

      <View style={styles.frame}>
        {perm === 'denied' ? (
          <View style={styles.center}>
            <Text variant="body" style={{ color: FG, textAlign: 'center' }}>
              {PROOF_TEXT.noCamera}
            </Text>
          </View>
        ) : shot ? (
          <Image source={{ uri: `data:image/jpeg;base64,${shot.base64}` }} style={styles.media} resizeMode="cover" accessibilityLabel="Çekilen fotoğraf" testID="proof-camera-preview" />
        ) : (
          <canvas ref={canvasRef} width={360} height={480} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        )}
        {flash ? <View style={[StyleSheet.absoluteFill, { backgroundColor: '#FFFFFF' }]} /> : null}
        {!shot && perm === 'granted' ? (
          <View style={styles.liveBadge} pointerEvents="none">
            <Text variant="caption" style={{ color: FG, fontWeight: '600' }}>
              ● CANLI · demo kamera
            </Text>
          </View>
        ) : null}
      </View>

      <Text variant="caption" style={styles.hint}>
        {PROOF_TEXT.addHint} {PROOF_TEXT.ttlHint}
      </Text>

      {shot ? (
        <View style={styles.actions}>
          <View style={{ flex: 1 }}>
            <Button title={PROOF_TEXT.retake} variant="secondary" onPress={() => setShot(null)} testID="proof-camera-retake" />
          </View>
          <View style={{ flex: 1 }}>
            <Button title={PROOF_TEXT.use} onPress={use} testID="proof-camera-use" />
          </View>
        </View>
      ) : (
        <View style={styles.controls}>
          <View style={styles.scenes}>
            {PROOF_SCENES.map((s) => (
              <Pressable
                key={s.kind}
                accessibilityRole="button"
                accessibilityState={{ selected: s.kind === scene }}
                onPress={() => setScene(s.kind)}
                style={[styles.sceneChip, s.kind === scene ? styles.sceneChipOn : null]}
              >
                <Text variant="caption" style={{ color: s.kind === scene ? '#000000' : FG, fontWeight: '600' }}>
                  {s.label}
                </Text>
              </Pressable>
            ))}
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={PROOF_TEXT.shutter}
            disabled={perm !== 'granted'}
            onPress={take}
            style={({ pressed }) => [styles.shutter, { opacity: perm === 'granted' ? 1 : 0.4, transform: [{ scale: pressed ? 0.92 : 1 }] }]}
            testID="proof-camera-shutter"
          >
            <View style={styles.shutterInner} />
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: '#000000', zIndex: 60, paddingTop: 52, paddingBottom: 28 },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, paddingBottom: 10 },
  frame: { flex: 1, marginHorizontal: 0, overflow: 'hidden', backgroundColor: '#111111' },
  media: { width: '100%', height: '100%' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  liveBadge: { position: 'absolute', top: 10, left: 10, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, backgroundColor: 'rgba(0,0,0,0.45)' },
  hint: { color: 'rgba(255,255,255,0.75)', textAlign: 'center', paddingHorizontal: 18, paddingTop: 10, fontWeight: '400' },
  actions: { flexDirection: 'row', gap: 12, paddingHorizontal: 18, paddingTop: 14 },
  controls: { alignItems: 'center', gap: 12, paddingTop: 12 },
  scenes: { flexDirection: 'row', gap: 8 },
  sceneChip: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.18)' },
  sceneChipOn: { backgroundColor: '#FFD60A' },
  shutter: { width: 72, height: 72, borderRadius: 36, borderWidth: 4, borderColor: FG, alignItems: 'center', justifyContent: 'center' },
  shutterInner: { width: 56, height: 56, borderRadius: 28, backgroundColor: FG },
});
