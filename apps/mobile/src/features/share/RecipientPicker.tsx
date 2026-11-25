import type { UserId } from '@konum/core';
import { BottomSheetTextInput } from '@gorhom/bottom-sheet';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { friendAvatarProps, type Friend } from '../../state/friendsStore';
import { Avatar, Button, Icon, MIN_TOUCH, Text, useTheme } from '../../ui';
import { pickerRowPressable, type PickerRowAccess } from '../access/accessModel';

export interface RecipientPickerProps {
  friends: Friend[];
  selected: ReadonlySet<UserId>;
  onToggle: (uid: UserId) => void;
  onAddFriend: () => void;
  /**
   * Faz 8: satırın izin durumu (accessModel `pickerRowAccess`). Etiket ("izin yok") gösterilir; neden verilmişse satır
   * pasiftir (seçiliyse yalnızca çıkarılabilir).
   */
  access?: (uid: UserId) => PickerRowAccess | null;
}

/** Türkçe duyarlı arama: "İ/ı" ve aksanlar normalize edilir. */
const norm = (s: string) => s.toLocaleLowerCase('tr-TR').normalize('NFD').replace(/\p{Diacritic}/gu, '');

export function RecipientPicker({ friends, selected, onToggle, onAddFriend, access }: RecipientPickerProps) {
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
        const a = access?.(f.uid) ?? null;
        const pressable = pickerRowPressable(a, on);
        const muted = !!a?.disabledReason && !on;
        return (
          <Pressable
            key={f.uid}
            testID={`recipient-${f.uid}`}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: on, disabled: !pressable }}
            accessibilityLabel={a ? `${f.displayName}, ${a.tag}` : f.displayName}
            accessibilityHint={a?.disabledReason ?? undefined}
            onPress={() => onToggle(f.uid)}
            disabled={!pressable}
            style={({ pressed }) => [styles.row, { paddingHorizontal: spacing.md, minHeight: MIN_TOUCH + 12, backgroundColor: pressed ? colors.surfaceAlt : 'transparent' }]}
          >
            <View style={{ opacity: muted ? 0.5 : 1 }}>
              <Avatar {...friendAvatarProps(f)} size={36} />
            </View>
            <View style={styles.name}>
              <View style={[styles.nameRow, { gap: spacing.xs }]}>
                <Text variant="body" style={[styles.shrink, { opacity: muted ? 0.6 : 1 }]} numberOfLines={1}>
                  {f.displayName}
                </Text>
                {a ? (
                  <View style={[styles.tag, { backgroundColor: colors.warningSoft, borderRadius: radius.pill, paddingHorizontal: spacing.xs }]}>
                    <Text variant="caption" style={{ color: colors.warning }} numberOfLines={1}>
                      {a.tag}
                    </Text>
                  </View>
                ) : null}
              </View>
              {a?.disabledReason ? (
                <Text variant="caption" color="textSecondary" numberOfLines={1}>
                  {a.disabledReason}
                </Text>
              ) : null}
            </View>
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
  nameRow: { flexDirection: 'row', alignItems: 'center' },
  shrink: { flexShrink: 1 },
  tag: { minHeight: 20, justifyContent: 'center' },
  check: { width: 24, height: 24, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
});
