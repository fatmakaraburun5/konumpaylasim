/**
 * Faz 8: görünür olma sayfası (docs/PHASE8.md §1.5, §5.2). Profil anahtarı, harita şeridi ve paylaş düğmesindeki
 * "Görünür ol" bunu açar; (main) yerleşiminde tek örnek vardır.
 *
 *   önceki paylaşımlar (avatar + çerçeve, ad, "17:30'a kadar · 2 sa kaldı" / süresiz), HİÇBİRİ seçili değil
 *   "Seçilenleri yeniden başlat (n)" · "Kimseyle paylaşma" → `invisible_set(false, restore_receiver_ids)`
 *   sonuç: yeniden başlayanlar ve başlatılamayanlar (neden yalnızca bizim tarafımızdan)
 * Kapatmak (✕) görünmez modu değiştirmez.
 */
import type { UserId } from '@konum/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNow } from '../../lib/useNow';
import { friendsStore, selectFriends, useFriendNames } from '../../state/friendsStore';
import { grantsStore, selectCan } from '../../state/grantsStore';
import { INVISIBLE_TEXT, invisibleStore, useInvisibleStore, useIsInvisible, useRestorableShares } from '../../state/invisibleStore';
import { Button, cardShadow, CheckRow, Overlay, SheetHeader, Text, useTheme } from '../../ui';
import { FriendAvatar } from '../profile/FriendAvatar';
import { closeRestoreFlow, useRestoreFlowOpen } from './invisibleFlow';
import { initialRestoreSelection, restoreOutcome, restoreRequestIds, restoreRows, skipReason, toggleRestore, type RestoreOutcomeView } from './invisibleModel';

export function InvisibleRestoreSheet() {
  const open = useRestoreFlowOpen();
  if (!open) return null;
  return <RestoreSheetBody />;
}

function RestoreSheetBody() {
  const { colors, radius, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const now = useNow(30_000);
  const names = useFriendNames();
  const invisible = useIsInvisible();
  const busy = useInvisibleStore((s) => s.busy);
  const entries = useRestorableShares(now);
  const rows = useMemo(() => restoreRows(entries, names, now), [entries, names, now]);
  const [selected, setSelected] = useState<ReadonlySet<UserId>>(initialRestoreSelection);
  const [outcome, setOutcome] = useState<RestoreOutcomeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);

  // Başka yerden görünür olunduysa (ör. SOS) ve sonuç gösterilmiyorsa sayfa kapanır.
  useEffect(() => {
    if (!invisible && !outcome && busy === null && !submitting.current) closeRestoreFlow();
  }, [busy, invisible, outcome]);

  const submit = async (ids: UserId[]) => {
    setError(null);
    submitting.current = true;
    const r = await invisibleStore.getState().setVisible(ids);
    if (!r.ok) {
      submitting.current = false;
      setError(r.message);
      return;
    }
    const g = grantsStore.getState();
    const friendIds = new Set(selectFriends(friendsStore.getState()).map((f) => f.uid));
    const view = restoreOutcome(r, names, (id) =>
      skipReason(id, { isFriend: (x) => friendIds.has(x), iGrantLocation: (x) => selectCan(g, 'location_view', x, 'given') }),
    );
    if (!view.restored && view.skipped.length === 0) closeRestoreFlow();
    else setOutcome(view);
    submitting.current = false;
  };

  const count = restoreRequestIds(selected, rows).length;

  return (
    <Overlay visible onRequestClose={closeRestoreFlow} testID="invisible-restore-sheet">
      <View style={[styles.backdrop, { paddingBottom: insets.bottom + spacing.md, paddingHorizontal: spacing.md }]}>
        <View style={[cardShadow, styles.card, { backgroundColor: colors.surface, borderRadius: radius.lg, paddingTop: spacing.md, paddingBottom: spacing.md, gap: spacing.sm }]}>
          <SheetHeader title={outcome ? 'Görünürsün' : INVISIBLE_TEXT.restoreTitle} subtitle={outcome ? undefined : INVISIBLE_TEXT.restoreBody} onClose={closeRestoreFlow} />
          {outcome ? (
            <View style={{ paddingHorizontal: spacing.md, gap: spacing.xs }} accessibilityLiveRegion="polite" testID="invisible-restore-outcome">
              {outcome.restored ? (
                <Text variant="body" color="live">
                  {outcome.restored}
                </Text>
              ) : null}
              {outcome.skipped.length ? (
                <>
                  <Text variant="label" color="textSecondary">
                    Yeniden başlatılamadı:
                  </Text>
                  {outcome.skipped.map((s) => (
                    <Text key={s.id} variant="label">
                      {s.text}
                    </Text>
                  ))}
                </>
              ) : null}
              <Button title="Tamam" onPress={closeRestoreFlow} testID="invisible-restore-done" />
            </View>
          ) : (
            <>
              {rows.length === 0 ? (
                <Text variant="body" color="textSecondary" style={{ paddingHorizontal: spacing.md }}>
                  {INVISIBLE_TEXT.restoreEmpty}
                </Text>
              ) : (
                <ScrollView style={styles.list} contentContainerStyle={{ paddingHorizontal: spacing.md }}>
                  {rows.map((r) => (
                    <CheckRow
                      key={r.receiverId}
                      testID={`invisible-restore-${r.receiverId}`}
                      checked={selected.has(r.receiverId)}
                      onPress={() => setSelected((prev) => toggleRestore(prev, r.receiverId))}
                      title={r.name}
                      subtitle={r.label}
                      left={<FriendAvatar uid={r.receiverId} fallbackName={r.name} size={36} />}
                      disabled={busy !== null}
                    />
                  ))}
                </ScrollView>
              )}
              <View style={{ paddingHorizontal: spacing.md, gap: spacing.xs }}>
                {error ? (
                  <Text variant="label" color="danger" accessibilityLiveRegion="assertive">
                    {error}
                  </Text>
                ) : null}
                {rows.length > 0 ? (
                  <Button
                    title={INVISIBLE_TEXT.restoreAction(count)}
                    testID="invisible-restore-selected"
                    disabled={count === 0 || busy !== null}
                    loading={busy === 'off' && count > 0}
                    onPress={() => void submit(restoreRequestIds(selected, rows))}
                  />
                ) : null}
                <Button
                  title={rows.length > 0 ? INVISIBLE_TEXT.restoreNone : INVISIBLE_TEXT.bannerAction}
                  variant={rows.length > 0 ? 'secondary' : 'primary'}
                  testID="invisible-restore-none"
                  disabled={busy !== null}
                  loading={busy === 'off' && (count === 0 || rows.length === 0)}
                  onPress={() => void submit([])}
                />
              </View>
            </>
          )}
        </View>
      </View>
    </Overlay>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(15, 23, 42, 0.45)' },
  card: { maxHeight: '86%', width: '100%', maxWidth: 560, alignSelf: 'center' },
  list: { flexGrow: 0, maxHeight: 320 },
});
