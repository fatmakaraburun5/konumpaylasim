/**
 * Faz 1 için asgari arkadaş yönetimi: kendi davet kodum (paylaş), kodla arkadaş ekle,
 * bekleyen istekleri kabul/ret, arkadaş listesi (görünür "Çıkar" düğmesi; ekran okuyucu eylemi de var).
 * Başarısız işlemler satırın altında Türkçe hata metniyle gösterilir.
 *
 * Faz 4: "Acil durum kişileri" kartı (EmergencyContactsSheet ile düzenlenir; SOS bu kişilere gider) ve her arkadaş
 * satırında tek dokunuşla "📍 Buradayım / 🚶 Yoldayım" (konum paylaşımı olmasa da gönderilebilir).
 * Faz 5: "Bölgelerim" kartı (varış / ayrılış kuralları ekranına giriş).
 * Faz 6: profil kartı (fotoğraf + ad → Profil ve widget ekranı), "Favoriler" kartı (widget sırası, her birinde
 * tek dokunuşla "⏱ 1 sa" paylaşım) ve her arkadaş satırında yıldız (en çok 4; sınırda kısa uyarı). Satırlarda
 * fotoğraf + cinsiyet çerçevesi.
 * Faz 8: en üstte "İzin istekleri" kartı (PermissionRequestsCard); her arkadaş satırında yön durumu ("Karşılıklı
 * kapalı", "O seni görebilir", …) ve satıra dokununca Kişi izinleri (`/friend/[id]`). Arkadaş kabulünden sonra
 * "Arkadaş olmanız konumunuzu açmaz." Favori yalnızca konum izni verdiğim kişi olabilir.
 */
import { ACCESS_TEXT, FAVORITES_LIMIT, formatInviteCode, PAIR_ACCESS_TEXT, SOS_LIMITS, type UserId } from '@konum/core';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, Share, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuthStore } from '../../state/authStore';
import { favoritesStore, useFavoriteIds, useFavoritesStore } from '../../state/favoritesStore';
import {
  friendAvatarProps,
  friendsStore,
  useFriendNames,
  useFriendRequests,
  useFriends,
  useFriendsById,
  useOutgoingRequests,
  type FriendOpResult,
} from '../../state/friendsStore';
import { selectAccessSummary, useGrantsStore } from '../../state/grantsStore';
import { useSosStore } from '../../state/sosStore';
import { Avatar, Button, cardShadow, Icon, IconButton, MIN_TOUCH, Text, useTheme } from '../../ui';
import { PingButtons } from '../ping/PingButtons';
import { FriendAvatar } from '../profile/FriendAvatar';
import { QuickShareButton } from '../quickShare/QuickShareButton';
import { EmergencyContactsSheet, type EmergencyContactsSheetHandle } from '../sos/EmergencyContactsSheet';
import { pickerRowAccess } from '../access/accessModel';
import { PermissionRequestsCard } from '../access/PermissionRequestsCard';
import { IncomingLocationRequests } from '../locationRequest/IncomingLocationRequests';
import { RequestLocationButton } from '../locationRequest/RequestLocationButton';
import { useCanFn } from '../access/useAccess';

export function FriendsScreen() {
  const { colors, radius, spacing, typography } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const profile = useAuthStore((s) => s.profile);
  const friends = useFriends();
  const requests = useFriendRequests();
  const outgoing = useOutgoingRequests();
  const names = useFriendNames();
  const emergencyContacts = useSosStore((s) => s.emergencyContacts);
  const favoriteIds = useFavoriteIds();
  const favError = useFavoritesStore((s) => s.error);
  const byId = useFriendsById();
  const contactsSheet = useRef<EmergencyContactsSheetHandle>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  /** Satır bazında süren işlem ve hata metni (friendshipId → …). */
  const [pending, setPending] = useState<Record<string, true>>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});
  /** Faz 8: az önce kabul edilen arkadaş (kısa not: arkadaşlık konumu açmaz). */
  const [acceptedName, setAcceptedName] = useState<string | null>(null);
  const given = useGrantsStore((s) => s.given);
  const received = useGrantsStore((s) => s.received);

  const runRow = async (id: string, op: () => Promise<FriendOpResult>) => {
    setPending((p) => ({ ...p, [id]: true }));
    setRowError(({ [id]: _old, ...rest }) => rest);
    const r = await op();
    setPending(({ [id]: _done, ...rest }) => rest);
    if (!r.ok) setRowError((e) => ({ ...e, [id]: r.message }));
  };

  const confirmRemove = (friendshipId: string, displayName: string) =>
    Alert.alert('Arkadaşlıktan çıkar', `${displayName} arkadaş listenden çıkarılacak ve aranızdaki tüm konum paylaşımları duracak.`, [
      { text: 'Vazgeç', style: 'cancel' },
      { text: 'Çıkar', style: 'destructive', onPress: () => void runRow(friendshipId, () => friendsStore.getState().remove(friendshipId)) },
    ]);

  const add = async () => {
    setBusy(true);
    setMsg(null);
    const r = await friendsStore.getState().addByInviteCode(code);
    setBusy(false);
    if (r.ok) {
      setCode('');
      setMsg({ ok: true, text: 'İstek gönderildi. Kabul edince listende görünecek.' });
    } else setMsg({ ok: false, text: r.message });
  };

  const card = [cardShadow, { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.md, gap: spacing.sm }];

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.xs, paddingHorizontal: spacing.xs }]}>
        <IconButton icon="chevronLeft" accessibilityLabel="Geri" onPress={() => router.back()} />
        <Text variant="title" accessibilityRole="header">
          Arkadaşlar
        </Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: spacing.md, gap: spacing.md, paddingBottom: insets.bottom + spacing.xl }} keyboardShouldPersistTaps="handled">
        {/* --- Faz 8: İzin istekleri --- */}
        <PermissionRequestsCard />
        {/* Konum İste: gelen istekler */}
        <IncomingLocationRequests />

        {profile ? (
          <Pressable
            onPress={() => router.push('/profile')}
            accessibilityRole="button"
            accessibilityLabel="Profil ve widget ayarları"
            testID="friends-profile-card"
            style={({ pressed }) => [...card, styles.row, { opacity: pressed ? 0.85 : 1 }]}
          >
            <FriendAvatar uid={profile.user_id} fallbackName={profile.display_name} size={44} />
            <View style={styles.flex}>
              <Text variant="heading" numberOfLines={1}>
                {profile.display_name}
              </Text>
              <Text variant="label" color="textSecondary" numberOfLines={1}>
                {profile.avatar_url ? 'Fotoğraf, ad ve widget ayarları' : 'Fotoğraf ekle · ad ve widget ayarları'}
              </Text>
            </View>
            <Text variant="label" color="primary">
              Profil
            </Text>
          </Pressable>
        ) : null}

        <View style={card} testID="favorites-card">
          <Text variant="heading">{`Favoriler (${favoriteIds.length}/${FAVORITES_LIMIT})`}</Text>
          {favoriteIds.length === 0 ? (
            <Text variant="label" color="textSecondary">
              Arkadaş listende ☆ simgesine dokunarak en çok {FAVORITES_LIMIT} favori seç. Favoriler ana ekran widget’ında görünür; tek dokunuşla 1 saat konum paylaşabilirsin.
            </Text>
          ) : (
            favoriteIds.map((uid) => {
              const fname = byId[uid]?.displayName ?? 'Arkadaş';
              return (
                <View key={uid} style={[styles.row, { gap: spacing.sm, minHeight: MIN_TOUCH }]} testID={`favorite-row-${uid}`}>
                  <FriendAvatar uid={uid} fallbackName={fname} size={36} />
                  <Text variant="body" style={styles.flex} numberOfLines={1}>
                    {fname}
                  </Text>
                  <QuickShareButton uid={uid} name={fname} />
                </View>
              );
            })
          )}
          {favError ? (
            <Text variant="label" color="danger" accessibilityLiveRegion="polite" testID="favorites-error">
              {favError}
            </Text>
          ) : null}
        </View>

        {profile?.invite_code ? (
          <View style={card}>
            <Text variant="label" color="textSecondary">
              Davet kodun
            </Text>
            <Text variant="title" color="primary" style={{ letterSpacing: 1 }}>
              {formatInviteCode(profile.invite_code)}
            </Text>
            <Button title="Kodu paylaş" variant="secondary" onPress={() => void Share.share({ message: `Konum'da beni ekle: ${profile.invite_code}` })} />
          </View>
        ) : null}

        <View style={card} testID="emergency-contacts-card">
          <Text variant="heading">Acil durum kişileri</Text>
          <Text variant="label" color="textSecondary">
            {emergencyContacts.length > 0
              ? emergencyContacts.map((u) => names[u] ?? 'Arkadaş').join(', ')
              : `SOS uyarın tam konumunla bu kişilere gider. En çok ${SOS_LIMITS.maxContacts} arkadaş seçebilirsin.`}
          </Text>
          <Button
            title={emergencyContacts.length > 0 ? 'Acil kişileri düzenle' : 'Acil kişi seç'}
            variant="secondary"
            onPress={() => contactsSheet.current?.present(false)}
            disabled={friends.length === 0}
          />
        </View>

        <View style={card} testID="zones-card">
          <Text variant="heading">Bölgelerim</Text>
          <Text variant="label" color="textSecondary">
            Eve vardığında ya da işten çıktığında seçtiğin arkadaşlarına haber ver veya paylaşımı kendiliğinden başlat.
          </Text>
          <Button title="Bölgelerimi aç" variant="secondary" onPress={() => router.push('/zones')} />
        </View>

        <View style={card}>
          <Text variant="heading">Kodla arkadaş ekle</Text>
          <TextInput
            value={code}
            onChangeText={setCode}
            placeholder="LOC-XXXXXX"
            placeholderTextColor={colors.textSecondary}
            autoCapitalize="characters"
            autoCorrect={false}
            accessibilityLabel="Arkadaşın davet kodu"
            maxLength={16}
            style={[typography.heading, styles.input, { color: colors.text, backgroundColor: colors.surfaceAlt, borderRadius: radius.md, paddingHorizontal: spacing.md }]}
          />
          {msg ? (
            <Text variant="label" color={msg.ok ? 'live' : 'danger'} accessibilityLiveRegion="polite">
              {msg.text}
            </Text>
          ) : null}
          <Button title="İstek gönder" onPress={add} loading={busy} disabled={!code.trim()} />
        </View>

        {requests.length > 0 ? (
          <View style={card}>
            <Text variant="heading">Bekleyen istekler</Text>
            {requests.map((r) => (
              <View key={r.friendshipId} style={{ gap: spacing.xs }}>
                <View style={[styles.row, { gap: spacing.sm }]}>
                  <Avatar name={r.displayName} size={36} />
                  <Text variant="body" style={styles.flex} numberOfLines={1}>
                    {r.displayName}
                  </Text>
                  <Button
                    title="Reddet"
                    variant="ghost"
                    block={false}
                    disabled={!!pending[r.friendshipId]}
                    onPress={() => void runRow(r.friendshipId, () => friendsStore.getState().respond(r.friendshipId, false))}
                  />
                  <Button
                    title="Kabul et"
                    block={false}
                    loading={!!pending[r.friendshipId]}
                    onPress={() =>
                      void runRow(r.friendshipId, async () => {
                        const res = await friendsStore.getState().respond(r.friendshipId, true);
                        if (res.ok) setAcceptedName(r.displayName);
                        return res;
                      })
                    }
                  />
                </View>
                {rowError[r.friendshipId] ? (
                  <Text variant="label" color="danger" accessibilityLiveRegion="polite">
                    {rowError[r.friendshipId]}
                  </Text>
                ) : null}
              </View>
            ))}
          </View>
        ) : null}

        {outgoing.length > 0 ? (
          <View style={card}>
            <Text variant="heading">Gönderdiğin istekler</Text>
            {outgoing.map((o) => (
              <View key={o.id} style={{ gap: spacing.xs }}>
                <View style={[styles.row, { gap: spacing.sm }]}>
                  <Text variant="body" style={styles.flex} numberOfLines={1}>
                    {o.label}
                  </Text>
                  <Text variant="label" color="textSecondary">
                    Yanıt bekleniyor
                  </Text>
                  <Button
                    title="İptal"
                    variant="ghost"
                    block={false}
                    loading={!!pending[o.id]}
                    onPress={() => void runRow(o.id, () => friendsStore.getState().cancel(o.id))}
                  />
                </View>
                {rowError[o.id] ? (
                  <Text variant="label" color="danger" accessibilityLiveRegion="polite">
                    {rowError[o.id]}
                  </Text>
                ) : null}
              </View>
            ))}
          </View>
        ) : null}

        <View style={card}>
          <Text variant="heading">{`Arkadaşların (${friends.length})`}</Text>
          {acceptedName ? (
            <View style={[styles.row, { gap: spacing.xs, backgroundColor: colors.primarySoft, borderRadius: radius.md, padding: spacing.sm }]} testID="friend-accepted-hint">
              <Text variant="label" style={styles.flex} accessibilityLiveRegion="polite">
                {`${acceptedName} ile artık arkadaşsınız. ${ACCESS_TEXT.friendAcceptedHint}`}
              </Text>
              <IconButton icon="close" size={32} accessibilityLabel="Notu kapat" onPress={() => setAcceptedName(null)} />
            </View>
          ) : null}
          {friends.length === 0 ? (
            <Text variant="body" color="textSecondary">
              Henüz arkadaşın yok. Davet kodunu paylaşarak başla.
            </Text>
          ) : (
            friends.map((f) => {
              const access = PAIR_ACCESS_TEXT[selectAccessSummary({ given, received }, f.uid)];
              return (
              <View key={f.uid} style={{ gap: spacing.xs }}>
                <View style={[styles.row, { gap: spacing.sm, minHeight: MIN_TOUCH }]}>
                  <Pressable
                    testID={`friend-row-${f.uid}`}
                    onPress={() => router.push(`/friend/${f.uid}`)}
                    accessibilityRole="button"
                    accessibilityLabel={`${f.displayName}, ${access}`}
                    accessibilityHint="Kişi izinlerini açar"
                    accessibilityActions={[{ name: 'remove', label: 'Arkadaşlıktan çıkar' }]}
                    onAccessibilityAction={(e) => {
                      if (e.nativeEvent.actionName === 'remove') confirmRemove(f.friendshipId, f.displayName);
                    }}
                    style={({ pressed }) => [styles.row, styles.flex, { gap: spacing.sm, minHeight: MIN_TOUCH, opacity: pressed ? 0.7 : 1 }]}
                  >
                    <Avatar {...friendAvatarProps(f)} size={36} />
                    <View style={styles.flex}>
                      <Text variant="body" numberOfLines={1}>
                        {f.displayName}
                      </Text>
                      <Text variant="caption" color="textSecondary" numberOfLines={1} testID={`friend-access-${f.uid}`}>
                        {`${access} · İzinler ›`}
                      </Text>
                    </View>
                  </Pressable>
                  <FavoriteStar uid={f.uid} name={f.displayName} on={favoriteIds.includes(f.uid)} />
                  <Button
                    title="Çıkar"
                    variant="ghost"
                    block={false}
                    loading={!!pending[f.friendshipId]}
                    accessibilityLabel={`${f.displayName} kişisini arkadaşlıktan çıkar`}
                    onPress={() => confirmRemove(f.friendshipId, f.displayName)}
                  />
                </View>
                <View style={{ paddingLeft: 36 + spacing.sm }}>
                  <PingButtons to={f.uid} name={f.displayName} compact />
                  <RequestLocationButton to={f.uid} name={f.displayName} compact />
                </View>
                {rowError[f.friendshipId] ? (
                  <Text variant="label" color="danger" accessibilityLiveRegion="polite">
                    {rowError[f.friendshipId]}
                  </Text>
                ) : null}
              </View>
              );
            })
          )}
        </View>
      </ScrollView>
      <EmergencyContactsSheet ref={contactsSheet} />
    </View>
  );
}

/** Favori yıldızı: dokunuş iyimser; sınır doluysa favoriler kartında kısa uyarı (favoritesStore.error). */
function FavoriteStar({ uid, name, on }: { uid: UserId; name: string; on: boolean }) {
  const { colors } = useTheme();
  const router = useRouter();
  // Faz 8: favori (widget hızlı paylaşımı) yalnızca konum izni verdiğim kişi olabilir; çıkarmak her zaman serbest.
  const noGrant = pickerRowAccess('favorite', uid, useCanFn());
  const press = () => {
    if (!on && noGrant) {
      Alert.alert(name, `${noGrant.disabledReason ?? ''} Favori yapmak için önce Kişi izinlerinden konum izni ver.`.trim(), [
        { text: 'Vazgeç', style: 'cancel' },
        { text: 'Kişi izinleri', onPress: () => router.push(`/friend/${uid}`) },
      ]);
      return;
    }
    void favoritesStore.getState().toggle(uid);
  };
  return (
    <Pressable
      testID={`favorite-toggle-${uid}`}
      onPress={press}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      accessibilityLabel={on ? `${name} favorilerden çıkar` : `${name} favorilere ekle`}
      accessibilityHint={!on && noGrant ? (noGrant.disabledReason ?? undefined) : undefined}
      hitSlop={6}
      style={({ pressed }) => [styles.star, { backgroundColor: pressed ? colors.surfaceAlt : 'transparent', opacity: !on && noGrant ? 0.45 : 1 }]}
    >
      <Icon name={on ? 'starFilled' : 'star'} color={on ? colors.warning : colors.textSecondary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  star: { width: MIN_TOUCH, height: MIN_TOUCH, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  input: { minHeight: MIN_TOUCH + 4, letterSpacing: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
});
