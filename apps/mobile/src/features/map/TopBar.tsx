import { avatarViewOf, formatInviteCode, type UserProfile } from '@konum/core';
import { Alert, Pressable, Share, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { avatarRecyclingKey } from '../../state/friendsStore';
import { INVISIBLE_TEXT } from '../../state/invisibleStore';
import { Avatar, cardShadow, Icon, IconButton, MIN_TOUCH, Text, useTheme } from '../../ui';

export interface TopBarProps {
  profile: UserProfile | null;
  onFriends: () => void;
  /** Faz 5: "Bölgelerim" ekranı. */
  onZones?: () => void;
  /** Faz 6: profil (fotoğraf, ad, cinsiyet, favoriler, widget). */
  onProfile?: () => void;
  onSignOut: () => void;
  /** Faz 8: görünmez mod → avatarda göz-kapalı rozeti. */
  invisible?: boolean;
}

export function TopBar({ profile, onFriends, onZones, onProfile, onSignOut, invisible = false }: TopBarProps) {
  const { colors, spacing, radius } = useTheme();
  const insets = useSafeAreaInsets();
  const code = profile?.invite_code ? formatInviteCode(profile.invite_code) : null;

  const shareCode = () => {
    if (!profile?.invite_code) return;
    void Share.share({ message: `Konum'da beni ekle: ${profile.invite_code}` });
  };

  const openMenu = () =>
    Alert.alert(profile?.display_name ?? 'Hesap', undefined, [
      ...(onProfile ? [{ text: 'Profili düzenle', onPress: onProfile }] : []),
      { text: 'Arkadaşlar', onPress: onFriends },
      ...(onZones ? [{ text: 'Bölgelerim', onPress: onZones }] : []),
      { text: 'Çıkış yap', style: 'destructive', onPress: onSignOut },
      { text: 'Vazgeç', style: 'cancel' },
    ]);

  return (
    <View style={[styles.wrap, { paddingTop: insets.top + spacing.xs, paddingHorizontal: spacing.md }]} pointerEvents="box-none">
      <View style={[styles.bar, cardShadow, { backgroundColor: colors.surface, borderRadius: radius.lg, paddingHorizontal: spacing.xs, gap: spacing.xs }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={invisible ? `Hesap menüsü · ${INVISIBLE_TEXT.avatarBadgeLabel}` : 'Hesap menüsü'}
          onPress={openMenu}
          hitSlop={4}
          style={styles.touch}
          testID="topbar-avatar"
        >
          <View>
            {profile ? <Avatar {...myAvatar(profile)} size={28} /> : <Avatar name="?" size={28} />}
            {invisible ? (
              <View
                testID="topbar-invisible-badge"
                style={[styles.badge, { backgroundColor: colors.primary, borderColor: colors.surface }]}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
              >
                <Icon name="eyeOff" size={10} color={colors.onPrimary} strokeWidth={2.5} />
              </View>
            ) : null}
          </View>
        </Pressable>
        <Text variant="heading" style={styles.title}>
          Konum
        </Text>
        {code ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Davet kodun ${code}. Paylaşmak için dokun.`}
            onPress={shareCode}
            style={({ pressed }) => [
              styles.chip,
              { backgroundColor: pressed ? colors.primarySoft : colors.surfaceAlt, borderRadius: radius.pill, paddingHorizontal: spacing.sm },
            ]}
          >
            <Text variant="label" color="primary" style={styles.mono}>
              {code}
            </Text>
          </Pressable>
        ) : null}
        <IconButton icon="users" accessibilityLabel="Arkadaşlar" onPress={onFriends} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', top: 0, left: 0, right: 0 },
  bar: { flexDirection: 'row', alignItems: 'center', minHeight: 56 },
  touch: { minWidth: MIN_TOUCH, minHeight: MIN_TOUCH, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1 },
  // Dokunma hedefi en az 44 (tasarım kuralı); çubuk 56 yüksekliğinde, sığar.
  chip: { minHeight: MIN_TOUCH, justifyContent: 'center' },
  mono: { fontVariant: ['tabular-nums'], letterSpacing: 0.5 },
  badge: { position: 'absolute', right: -4, bottom: -4, width: 16, height: 16, borderRadius: 8, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
});

/** Kendi avatarım: küçük boy fotoğraf + cinsiyet çerçevesi. */
function myAvatar(p: UserProfile) {
  const v = avatarViewOf(p, 'thumb');
  return { name: v.name || '?', photoUrl: v.photo_url, gender: v.gender, recyclingKey: avatarRecyclingKey(v.photo_url) };
}
