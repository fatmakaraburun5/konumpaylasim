import type { UserId } from '@konum/core';
import { BottomSheetTextInput } from '@gorhom/bottom-sheet';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { friendAvatarProps, type Friend } from '../../state/friendsStore';
import { Avatar, Button, Icon, MIN_TOUCH, Text, useTheme } from '../../ui';

export interface RecipientPickerProps {
  friends: Friend[];
  selected: ReadonlySet<UserId>;
  onToggle: (uid: UserId) => void;
  onAddFriend: () => void;
}

/** Türkçe duyarlı arama: "İ/ı" ve aksanlar normalize edilir. */
const norm = (s: string) => s.toLocaleLowerCase('tr-TR').normalize('NFD').replace(/\p{Diacritic}/gu, '');

export function RecipientPicker({ friends, selected, onToggle, onAddFriend }: RecipientPickerProps) {
  const { colors, spacing, radius, typography } = useTheme();
  const [q, setQ] = useState('');
  const filtered = useMemo(() => {
    const n = norm(q.trim());
    return n ? friends.filter((f) => norm(f.displayName).includes(n)) : friends;
  }, [friends, q]);

  if (friends.length === 0) {
    return (
      <View style={{ paddingHorizontal: spacing.md, gap: spacing.sm }}>
        <Text variant="body" color="textSecondary">
          Konumunu paylaşabilmen için önce arkadaş eklemelisin. Davet kodunu paylaş ya da bir arkadaşının kodunu gir.
        </Text>
        <Button title="Arkadaş ekle" variant="secondary" onPress={onAddFriend} />
      </View>
    );
  }

  return (
    <View style={{ gap: spacing.xs }}>
      <View style={[styles.search, { marginHorizontal: spacing.md, backgroundColor: colors.surfaceAlt, borderRadius: radius.md, paddingHorizontal: spacing.sm }]}>
        <Icon name="search" color={colors.textSecondary} size={18} />
        <BottomSheetTextInput
          value={q}
          onChangeText={setQ}
          placeholder="Arkadaş ara"
          placeholderTextColor={colors.textSecondary}
          accessibilityLabel="Arkadaş ara"
          autoCorrect={false}
          style={[typography.body, styles.input, { color: colors.text }]}
        />
      </View>
      {filtered.map((f) => {
        const on = selected.has(f.uid);
        return (
          <Pressable
            key={f.uid}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: on }}
            accessibilityLabel={f.displayName}
            onPress={() => onToggle(f.uid)}
            style={({ pressed }) => [styles.row, { paddingHorizontal: spacing.md, minHeight: MIN_TOUCH + 12, backgroundColor: pressed ? colors.surfaceAlt : 'transparent' }]}
          >
            <Avatar {...friendAvatarProps(f)} size={36} />
            <Text variant="body" style={styles.name} numberOfLines={1}>
              {f.displayName}
            </Text>
            <View
              style={[
                styles.check,
                { borderRadius: radius.sm, borderColor: on ? colors.primary : colors.border, backgroundColor: on ? colors.primary : 'transparent' },
              ]}
            >
              {on ? <Icon name="check" color={colors.onPrimary} size={16} strokeWidth={2.5} /> : null}
            </View>
          </Pressable>
        );
      })}
      {filtered.length === 0 ? (
        <Text variant="label" color="textSecondary" style={{ paddingHorizontal: spacing.md }}>
          "{q}" ile eşleşen arkadaş yok
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  search: { flexDirection: 'row', alignItems: 'center', minHeight: MIN_TOUCH, gap: 8 },
  input: { flex: 1, paddingVertical: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  name: { flex: 1 },
  check: { width: 24, height: 24, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
});
