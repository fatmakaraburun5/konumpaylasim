/**
 * Faz 9: anlık fotoğraf kamerası (yerel, tam ekran) — docs/PHASE9.md §1.1.
 *
 *   expo-camera `CameraView` · deklanşör · ön/arka kamera · kapat
 *   → önizleme: "Yeniden çek" / "Fotoğrafı ekle" → `onCaptured(photo)` (kodlama ve yükleme depoda: proofStore.addPhoto)
 *
 * YALNIZCA kamera: galeri düğmesi, galeri izni, dosya seçici YOKTUR; `launchImageLibraryAsync` bu akışta hiç
 * çağrılmaz. Kamera izni yoksa yalnızca "İzin ver" / "Ayarları aç" gösterilir. Vazgeçilen / yeniden çekilen ham kare
 * önbellek dizininden hemen silinir (kullanılan kare kodlamadan sonra `encodeProofPhoto` tarafından silinir).
 * Web demosu: `CameraCapture.web.tsx` (aynı props).
 */
import { PROOF_TEXT } from '@konum/core';
import { CameraView, useCameraPermissions, type CameraType } from 'expo-camera';
import { Image } from 'expo-image';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { deleteLocalFiles } from '../../services/proof/encode';
import type { CameraCaptureProps, CapturedPhoto } from '../../services/proof/types';
import { Button, Icon, IconButton, Overlay, Text, useTheme } from '../../ui';

const FG = '#FFFFFF';

export function CameraCapture({ visible = true, onCaptured, onCancel, title }: CameraCaptureProps) {
  const { spacing, radius } = useTheme();
  const insets = useSafeAreaInsets();
  const [perm, requestPerm] = useCameraPermissions();
  const cam = useRef<CameraView>(null);
  const [facing, setFacing] = useState<CameraType>('back');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [shot, setShot] = useState<CapturedPhoto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shotRef = useRef<CapturedPhoto | null>(null);
  shotRef.current = shot;

  // Kapanınca: kullanılmayan ham kare silinir, durum sıfırlanır.
  useEffect(() => {
    if (visible) return;
    const s = shotRef.current;
    if (s?.uri) deleteLocalFiles([s.uri]);
    setShot(null);
    setReady(false);
    setBusy(false);
    setError(null);
  }, [visible]);

  // İlk açılışta sistem istemi (yalnızca kamera; mikrofon / galeri istenmez).
  useEffect(() => {
    if (visible && perm && perm.status === 'undetermined' && perm.canAskAgain) void requestPerm().catch(() => undefined);
  }, [visible, perm, requestPerm]);

  const take = async () => {
    if (!cam.current || busy || !ready) return;
    setBusy(true);
    setError(null);
    try {
      const at = Date.now();
      const p = await cam.current.takePictureAsync({ quality: 0.85, exif: false, base64: false });
      if (!p?.uri) throw new Error('no_picture');
      setShot({ base64: p.base64 ?? '', width: p.width, height: p.height, captured_at: at, uri: p.uri });
    } catch {
      setError(PROOF_TEXT.unavailable);
    } finally {
      setBusy(false);
    }
  };

  const retake = () => {
    if (shot?.uri) deleteLocalFiles([shot.uri]);
    setShot(null);
  };

  const use = () => {
    if (!shot) return;
    const s = shot;
    // Dosya artık depoya ait (kodlamadan sonra silinir).
    setShot(null);
    onCaptured(s);
  };

  const cancel = () => {
    retake();
    onCancel();
  };

  const granted = perm?.granted === true;
  const blocked = perm !== null && !perm.granted && !perm.canAskAgain;

  return (
    <Overlay visible={visible} onRequestClose={cancel} testID="proof-camera">
      <View style={styles.root}>
        {granted && !shot ? (
          <CameraView
            ref={cam}
            style={StyleSheet.absoluteFill}
            facing={facing}
            mode="picture"
            mute
            animateShutter
            active={visible}
            onCameraReady={() => setReady(true)}
            onMountError={() => setError(PROOF_TEXT.unavailable)}
          />
        ) : null}
        {shot ? <Image source={{ uri: shot.uri }} style={StyleSheet.absoluteFill} contentFit="contain" cachePolicy="none" accessibilityLabel="Çekilen fotoğrafın önizlemesi" /> : null}

        <View style={[styles.top, { paddingTop: insets.top + spacing.xs, paddingHorizontal: spacing.sm }]}>
          <IconButton icon="close" accessibilityLabel="Kamerayı kapat" onPress={cancel} variant="soft" size={40} />
          <Text variant="heading" style={[styles.fg, styles.flex, { textAlign: 'center' }]} accessibilityRole="header">
            {title ?? PROOF_TEXT.cameraTitle}
          </Text>
          <View style={{ width: 44 }} />
        </View>

        {!granted ? (
          <View style={[styles.center, { padding: spacing.lg, gap: spacing.md }]}>
            <Icon name="camera" size={44} color={FG} />
            <Text variant="body" style={[styles.fg, { textAlign: 'center' }]}>
              {PROOF_TEXT.noCamera}
            </Text>
            {perm === null ? (
              <ActivityIndicator color={FG} />
            ) : blocked ? (
              <Button title={PROOF_TEXT.noCameraAction} onPress={() => void Linking.openSettings().catch(() => undefined)} block={false} />
            ) : (
              <Button title="İzin ver" onPress={() => void requestPerm().catch(() => undefined)} block={false} />
            )}
          </View>
        ) : null}

        <View style={[styles.bottom, { paddingBottom: insets.bottom + spacing.lg, paddingHorizontal: spacing.lg, gap: spacing.sm }]}>
          {error ? (
            <Text variant="label" style={[styles.fg, { textAlign: 'center' }]} accessibilityLiveRegion="assertive">
              {error}
            </Text>
          ) : (
            <Text variant="caption" style={[styles.fgSoft, { textAlign: 'center' }]}>
              {`${PROOF_TEXT.addHint} ${PROOF_TEXT.ttlHint}`}
            </Text>
          )}
          {shot ? (
            <View style={[styles.row, { gap: spacing.sm }]}>
              <Button title={PROOF_TEXT.retake} variant="secondary" onPress={retake} style={styles.flex} block={false} testID="proof-retake" />
              <Button title={PROOF_TEXT.use} onPress={use} style={styles.flex} block={false} testID="proof-use" />
            </View>
          ) : granted ? (
            <View style={[styles.row, styles.shutterRow]}>
              <View style={{ width: 56 }} />
              <Pressable
                onPress={() => void take()}
                disabled={!ready || busy}
                accessibilityRole="button"
                accessibilityLabel={PROOF_TEXT.shutter}
                accessibilityState={{ disabled: !ready || busy, busy }}
                testID="proof-shutter"
                style={({ pressed }) => [styles.shutter, { opacity: !ready ? 0.5 : pressed ? 0.75 : 1 }]}
              >
                {busy ? <ActivityIndicator color="#0F172A" /> : <View style={styles.shutterInner} />}
              </Pressable>
              <Pressable
                onPress={() => setFacing((f) => (f === 'back' ? 'front' : 'back'))}
                accessibilityRole="button"
                accessibilityLabel={facing === 'back' ? 'Ön kameraya geç' : 'Arka kameraya geç'}
                hitSlop={8}
                style={[styles.flip, { borderRadius: radius.pill }]}
              >
                <Icon name="flip" size={26} color={FG} />
              </Pressable>
            </View>
          ) : null}
        </View>
      </View>
    </Overlay>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000000' },
  top: { position: 'absolute', left: 0, right: 0, top: 0, flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.35)', paddingBottom: 8 },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.45)', paddingTop: 12 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  fg: { color: FG },
  fgSoft: { color: 'rgba(255,255,255,0.85)' },
  shutterRow: { justifyContent: 'space-between' },
  shutter: { width: 76, height: 76, borderRadius: 38, borderWidth: 4, borderColor: FG, alignItems: 'center', justifyContent: 'center' },
  shutterInner: { width: 60, height: 60, borderRadius: 30, backgroundColor: FG },
  flip: { width: 56, height: 56, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.18)' },
});
