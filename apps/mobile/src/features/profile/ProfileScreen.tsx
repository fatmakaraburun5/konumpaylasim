/**
 * Faz 6: profil ve widget ayarları (`/profile`; haritadaki menü ve Arkadaşlar ekranından).
 *
 *  - Fotoğraf: kamera / galeri (kare kırpma, 512 + 160 px JPEG; yeniden kodlama EXIF'i — konum dahil — siler),
 *    iyimser önizleme, hata → "Tekrar dene", izin reddi → "Ayarları aç", "Fotoğrafı kaldır".
 *  - Ad ve cinsiyet (`user_bootstrap`; arkadaşların kopyasına sunucu yayar).
 *  - Favoriler: widget sırası (yukarı / aşağı), çıkar; seçim Arkadaşlar ekranındaki yıldızla.
 *  - Widget: "Kilit ekranında ayrıntı göster" (varsayılan KAPALI: kilit ekranında yer ve pil gizli), durum
 *    (hızlı paylaşım hazır mı, arka plan konumu, son güncelleme, son hızlı paylaşım).
 */
import { formatAgo, GENDER_TEXT, toQuickShareError, quickShareErrorText, type Gender } from '@konum/core';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNow } from '../../lib/useNow';
import { now as serverNow } from '../../lib/clock';
import { PICK_DENIED_TEXT } from '../../services/profile/avatarPipeline';
import { avatarPlatform } from '../../services/profile/avatarUpload';
import { capabilities } from '../../services/widgets/widgetBridge';
import { useAuthStore } from '../../state/authStore';
import { favoritesStore, useFavoriteIds, useFavoritesStore } from '../../state/favoritesStore';
import { avatarRecyclingKey, useFriendsById } from '../../state/friendsStore';
import { profileStore, useProfileStore } from '../../state/profileStore';
import { useQuickShareStore } from '../../state/quickShareStore';
import { useWidgetStore, widgetStore } from '../../state/widgetStore';
import { Avatar, Button, cardShadow, IconButton, MIN_TOUCH, Text, useTheme } from '../../ui';
import { FriendAvatar } from './FriendAvatar';
import { GenderPicker } from './GenderPicker';

const PHASE_TEXT = { processing: 'Fotoğraf hazırlanıyor…', uploading: 'Yükleniyor…', saving: 'Kaydediliyor…' } as const;
const LAST_STATUS_TEXT: Record<string, string> = {
  started: 'başladı',
  extended: '1 saate uzatıldı',
  already_active: 'zaten açıktı',
};
const SOURCE_TEXT = { app: 'uygulama', link: 'widget bağlantısı', widget: 'widget' } as const;

export function ProfileScreen() {
  const { colors, radius, spacing, typography } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const profile = useAuthStore((s) => s.profile);
  const updateProfile = useAuthStore((s) => s.updateProfile);
  const signOut = useAuthStore((s) => s.signOut);
  const now = useNow(30_000);

  const photo = useProfileStore((s) => s);
  const favoriteIds = useFavoriteIds();
  const favSaving = useFavoritesStore((s) => s.saving);
  const favError = useFavoritesStore((s) => s.error);
  const byId = useFriendsById();
  const lockDetails = useWidgetStore((s) => s.lockScreenDetails);
  const lastSnapshot = useWidgetStore((s) => s.lastSnapshot);
  const lastWriteAt = useWidgetStore((s) => s.lastWriteAt);
  const tokenError = useWidgetStore((s) => s.tokenError);
  const lastQuick = useQuickShareStore((s) => s.last);
  const [caps] = useState(() => capabilities());

  const [name, setName] = useState(profile?.display_name ?? '');
  const [nameBusy, setNameBusy] = useState(false);
  const [nameMsg, setNameMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [genderBusy, setGenderBusy] = useState(false);
  const [genderError, setGenderError] = useState<string | null>(null);

  if (!profile) return null;

  const trimmed = name.trim();
  const nameChanged = trimmed.length > 0 && trimmed !== profile.display_name;
  const photoBusy = photo.phase === 'processing' || photo.phase === 'uploading' || photo.phase === 'saving';
  const hasPhoto = !!(profile.avatar_url || profile.avatar_thumb_url);
  const shownPhoto = photo.previewUri ?? profile.avatar_url ?? profile.avatar_thumb_url;

  const saveName = async () => {
    setNameBusy(true);
    setNameMsg(null);
    const r = await updateProfile({ display_name: trimmed });
    setNameBusy(false);
    setNameMsg(r.ok ? { ok: true, text: 'Adın güncellendi.' } : { ok: false, text: r.message });
  };

  const saveGender = async (g: Gender) => {
    if (g === profile.gender) return;
    setGenderBusy(true);
    setGenderError(null);
    const r = await updateProfile({ gender: g });
    setGenderBusy(false);
    if (!r.ok) setGenderError(r.message);
  };

  const card = [cardShadow, { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.md, gap: spacing.sm }];

  const quickReady = lastSnapshot?.quick.token_ok ?? false;
  const bgOk = lastSnapshot?.quick.bg_location_ok ?? false;
  const lastQuickName = lastQuick ? ((lastQuick.to ? byId[lastQuick.to]?.displayName : undefined) ?? lastQuick.to_name ?? 'Arkadaşın') : null;

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]} testID="profile-screen">
      <View style={[styles.header, { paddingTop: insets.top + spacing.xs, paddingHorizontal: spacing.xs }]}>
        <IconButton icon="chevronLeft" accessibilityLabel="Geri" onPress={() => router.back()} />
        <Text variant="title" accessibilityRole="header">
          Profil ve widget
        </Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: spacing.md, gap: spacing.md, paddingBottom: insets.bottom + spacing.xl }} keyboardShouldPersistTaps="handled">
        {/* --- Fotoğraf --- */}
        <View style={[card, styles.center]} testID="profile-photo-card">
          <View>
            <Avatar
              name={profile.display_name || '?'}
              size={112}
              photoUrl={shownPhoto}
              gender={profile.gender}
              recyclingKey={photo.previewUri ? photo.previewUri : avatarRecyclingKey(shownPhoto)}
              accessibilityLabel={hasPhoto || photo.previewUri ? 'Profil fotoğrafın' : 'Profil fotoğrafı yok, baş harflerin gösteriliyor'}
            />
            {photoBusy ? (
              <View style={[StyleSheet.absoluteFill, styles.center, { borderRadius: 999, backgroundColor: 'rgba(15, 23, 42, 0.35)' }]}>
                <ActivityIndicator color="#FFFFFF" />
              </View>
            ) : null}
          </View>
          {photoBusy ? (
            <Text variant="label" color="textSecondary" accessibilityLiveRegion="polite">
              {PHASE_TEXT[photo.phase as keyof typeof PHASE_TEXT]}
            </Text>
          ) : null}
          {photo.phase === 'error' && photo.error ? (
            <Text variant="label" color="danger" accessibilityLiveRegion="assertive" style={styles.textCenter}>
              {photo.error}
            </Text>
          ) : null}
          {photo.denied ? (
            <View style={[styles.center, { gap: spacing.xs }]}>
              <Text variant="label" color="warning" style={styles.textCenter} accessibilityLiveRegion="polite">
                {PICK_DENIED_TEXT[photo.denied.source]}
              </Text>
              <Button
                title="Ayarları aç"
                variant="secondary"
                block={false}
                onPress={() => {
                  profileStore.getState().clearDenied();
                  void avatarPlatform.openSettings();
                }}
              />
            </View>
          ) : null}
          <View style={[styles.row, { gap: spacing.sm, alignSelf: 'stretch' }]}>
            {avatarPlatform.cameraAvailable ? (
              <Button
                title="Kamera"
                variant="secondary"
                block={false}
                style={styles.flex}
                disabled={photoBusy}
                testID="profile-photo-camera"
                onPress={() => void profileStore.getState().changePhoto('camera')}
              />
            ) : null}
            <Button
              title="Galeri"
              variant="secondary"
              block={false}
              style={styles.flex}
              disabled={photoBusy}
              testID="profile-photo-library"
              onPress={() => void profileStore.getState().changePhoto('library')}
            />
          </View>
          {photo.phase === 'error' && photo.previewUri ? (
            <Button title="Tekrar dene" onPress={() => void profileStore.getState().retryPhoto()} testID="profile-photo-retry" />
          ) : null}
          {hasPhoto && !photoBusy ? (
            <Button title="Fotoğrafı kaldır" variant="ghost" onPress={() => void profileStore.getState().removePhoto()} testID="profile-photo-remove" />
          ) : null}
          <Text variant="label" color="textSecondary" style={styles.textCenter}>
            Fotoğrafın küçültülüp yeniden kaydedilir; içindeki konum (EXIF) bilgisi silinir. Arkadaşların haritada, listede ve widget’ta görür.
          </Text>
        </View>

        {/* --- Ad --- */}
        <View style={card}>
          <Text variant="heading">Adın</Text>
          <TextInput
            value={name}
            onChangeText={(t) => {
              setName(t);
              setNameMsg(null);
            }}
            maxLength={40}
            autoCapitalize="words"
            accessibilityLabel="Görünen adın"
            testID="profile-name-input"
            style={[typography.body, styles.input, { color: colors.text, backgroundColor: colors.surfaceAlt, borderRadius: radius.md, paddingHorizontal: spacing.md }]}
          />
          {nameMsg ? (
            <Text variant="label" color={nameMsg.ok ? 'live' : 'danger'} accessibilityLiveRegion="polite">
              {nameMsg.text}
            </Text>
          ) : null}
          <Button title="Adı kaydet" variant="secondary" onPress={() => void saveName()} loading={nameBusy} disabled={!nameChanged} />
        </View>

        {/* --- Cinsiyet --- */}
        <View style={card}>
          <Text variant="heading">Cinsiyet</Text>
          <Text variant="label" color="textSecondary">
            Fotoğraf çerçeven buna göre renklenir: kadın pembe, erkek mavi.
            {profile.gender ? ` Şu an: ${GENDER_TEXT[profile.gender]}.` : ''}
          </Text>
          <GenderPicker value={profile.gender} onChange={(g) => void saveGender(g)} disabled={genderBusy} />
          {genderError ? (
            <Text variant="label" color="danger" accessibilityLiveRegion="polite">
              {genderError}
            </Text>
          ) : null}
        </View>

        {/* --- Favoriler --- */}
        <View style={card} testID="profile-favorites-card">
          <View style={[styles.row, { gap: spacing.xs }]}>
            <Text variant="heading" style={styles.flex}>{`Favoriler (${favoriteIds.length}/4)`}</Text>
            {favSaving ? <ActivityIndicator size="small" color={colors.primary} /> : null}
          </View>
          <Text variant="label" color="textSecondary">
            Widget’ta bu sırayla görünürler. İlk kişi tek tuşla paylaşımın varsayılanıdır.
          </Text>
          {favoriteIds.length === 0 ? (
            <Button title="Arkadaşlarda yıldızla seç" variant="secondary" onPress={() => router.push('/friends')} />
          ) : (
            favoriteIds.map((uid, i) => {
              const fname = byId[uid]?.displayName ?? 'Arkadaş';
              return (
                <View key={uid} style={[styles.row, { gap: spacing.sm, minHeight: MIN_TOUCH }]} testID={`profile-fav-${uid}`}>
                  <Text variant="label" color="textSecondary" style={{ width: 16 }}>
                    {i + 1}
                  </Text>
                  <FriendAvatar uid={uid} fallbackName={fname} size={32} />
                  <Text variant="body" style={styles.flex} numberOfLines={1}>
                    {fname}
                  </Text>
                  <IconButton icon="chevronUp" size={36} accessibilityLabel={`${fname} yukarı taşı`} disabled={i === 0} onPress={() => void favoritesStore.getState().move(uid, -1)} />
                  <IconButton
                    icon="chevronDown"
                    size={36}
                    accessibilityLabel={`${fname} aşağı taşı`}
                    disabled={i === favoriteIds.length - 1}
                    onPress={() => void favoritesStore.getState().move(uid, 1)}
                  />
                  <IconButton icon="close" size={36} accessibilityLabel={`${fname} favorilerden çıkar`} onPress={() => void favoritesStore.getState().toggle(uid)} />
                </View>
              );
            })
          )}
          {favError ? (
            <Text variant="label" color="danger" accessibilityLiveRegion="polite">
              {favError}
            </Text>
          ) : null}
        </View>

        {/* --- Widget --- */}
        <View style={card} testID="profile-widget-card">
          <Text variant="heading">Ana ekran ve kilit ekranı widget’ı</Text>
          <View style={[styles.row, { gap: spacing.sm, minHeight: MIN_TOUCH }]}>
            <View style={styles.flex}>
              <Text variant="body">Kilit ekranında ayrıntı göster</Text>
              <Text variant="label" color="textSecondary">
                Kapalıyken kilit ekranında yalnızca ad, durum ve zaman görünür; yer ve pil gizlenir.
              </Text>
            </View>
            <Switch
              value={lockDetails}
              onValueChange={(v) => widgetStore.getState().setLockScreenDetails(v)}
              accessibilityLabel="Kilit ekranında ayrıntı göster"
              testID="profile-lock-details"
            />
          </View>
          {!caps.available ? (
            <Text variant="label" color="textSecondary">
              Bu sürümde widget kullanılamıyor. Ayarların kaydedilir ve widget eklenince uygulanır.
            </Text>
          ) : (
            <View style={{ gap: 2 }}>
              <StatusLine
                ok={favoriteIds.length > 0}
                text={favoriteIds.length > 0 ? `${favoriteIds.length} favori widget’ta` : 'Favori yok: widget boş görünür'}
              />
              <StatusLine
                ok={quickReady}
                text={quickReady ? 'Tek tuşla paylaşım hazır' : 'Tek tuşla paylaşım uygulamayı açar (bağlantı bekleniyor)'}
              />
              <StatusLine ok={bgOk} text={bgOk ? 'Arka plan konumu açık' : '“Her zaman” konum izni yok: widget paylaşımı uygulamayı açar'} />
              {caps.platform === 'ios' && !caps.interactive ? <StatusLine ok={false} text="iOS 17 öncesi: widget düğmesi uygulamayı açar" /> : null}
              <Text variant="label" color="textSecondary">
                {lastWriteAt ? `Son güncelleme: ${formatAgo(lastWriteAt, Math.max(now, serverNow()))}` : 'Henüz güncellenmedi'}
              </Text>
              {tokenError ? (
                <Text variant="label" color="warning">
                  {tokenError}
                </Text>
              ) : null}
            </View>
          )}
          {lastQuick && lastQuickName ? (
            <Text variant="label" color={lastQuick.status === 'error' ? 'danger' : 'textSecondary'} testID="profile-last-quick">
              {lastQuick.status === 'error'
                ? `Son hızlı paylaşım (${SOURCE_TEXT[lastQuick.source]}): ${lastQuickName} · ${quickShareErrorText(toQuickShareError(lastQuick.error))}`
                : `Son hızlı paylaşım (${SOURCE_TEXT[lastQuick.source]}): ${lastQuickName} ile ${LAST_STATUS_TEXT[lastQuick.status] ?? 'tamam'} · ${formatAgo(lastQuick.at, Math.max(now, lastQuick.at))}`}
            </Text>
          ) : null}
        </View>

        <Button title="Çıkış yap" variant="ghost" onPress={() => void signOut()} />
      </ScrollView>
    </View>
  );
}

function StatusLine({ ok, text }: { ok: boolean; text: string }) {
  const { colors, spacing } = useTheme();
  return (
    <View style={[styles.row, { gap: spacing.xs }]}>
      <View style={[styles.dot, { backgroundColor: ok ? colors.live : colors.stale }]} />
      <Text variant="label" color={ok ? 'text' : 'textSecondary'} style={styles.flex}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  input: { minHeight: MIN_TOUCH + 4 },
  row: { flexDirection: 'row', alignItems: 'center' },
  center: { alignItems: 'center', justifyContent: 'center' },
  textCenter: { textAlign: 'center' },
  flex: { flex: 1 },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
