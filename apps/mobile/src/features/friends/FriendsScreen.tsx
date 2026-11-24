/**
 * Faz 1 için asgari arkadaş yönetimi: kendi davet kodum (paylaş), kodla arkadaş ekle,
 * bekleyen istekleri kabul/ret, arkadaş listesi (görünür "Çıkar" düğmesi; ekran okuyucu eylemi de var).
 * Başarısız işlemler satırın altında Türkçe hata metniyle gösterilir.
 *
 * Faz 4: "Acil durum kişileri" kartı (EmergencyContactsSheet ile düzenlenir; SOS bu kişilere gider) ve her arkadaş
 * satırında tek dokunuşla "📍 Buradayım / 🚶 Yoldayım" (konum paylaşımı olmasa da gönderilebilir).
 */
import { formatInviteCode, SOS_LIMITS } from '@konum/core';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Alert, ScrollView, Share, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuthStore } from '../../state/authStore';
import { friendsStore, useFriendNames, useFriendRequests, useFriends, useOutgoingRequests, type FriendOpResult } from '../../state/friendsStore';
import { useSosStore } from '../../state/sosStore';
import { Avatar, Button, cardShadow, IconButton, MIN_TOUCH, Text, useTheme } from '../../ui';
import { PingButtons } from '../ping/PingButtons';
import { EmergencyContactsSheet, type EmergencyContactsSheetHandle } from '../sos/EmergencyContactsSheet';

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
  const contactsSheet = useRef<EmergencyContactsSheetHandle>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  /** Satır bazında süren işlem ve hata metni (friendshipId → …). */
  const [pending, setPending] = useState<Record<string, true>>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});

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
                    onPress={() => void runRow(r.friendshipId, () => friendsStore.getState().respond(r.friendshipId, true))}
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
          {friends.length === 0 ? (
            <Text variant="body" color="textSecondary">
              Henüz arkadaşın yok. Davet kodunu paylaşarak başla.
            </Text>
          ) : (
            friends.map((f) => (
              <View key={f.uid} style={{ gap: spacing.xs }}>
                <View
                  style={[styles.row, { gap: spacing.sm, minHeight: MIN_TOUCH }]}
                  accessible
                  accessibilityLabel={f.displayName}
                  accessibilityActions={[{ name: 'remove', label: 'Arkadaşlıktan çıkar' }]}
                  onAccessibilityAction={(e) => {
                    if (e.nativeEvent.actionName === 'remove') confirmRemove(f.friendshipId, f.displayName);
                  }}
                >
                  <Avatar name={f.displayName} size={36} />
                  <Text variant="body" style={styles.flex} numberOfLines={1}>
                    {f.displayName}
                  </Text>
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
                </View>
                {rowError[f.friendshipId] ? (
                  <Text variant="label" color="danger" accessibilityLiveRegion="polite">
                    {rowError[f.friendshipId]}
                  </Text>
                ) : null}
              </View>
            ))
          )}
        </View>
      </ScrollView>
      <EmergencyContactsSheet ref={contactsSheet} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  input: { minHeight: MIN_TOUCH + 4, letterSpacing: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
});
