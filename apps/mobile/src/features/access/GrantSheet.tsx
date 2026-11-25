/**
 * Faz 8: "İzin ver…" sayfası (docs/PHASE8.md §5.4). Bana gelen bir izin isteğini yanıtlar:
 *
 *   istenen kapsamlar (işaretli, tek tek kaldırılabilir; kaldırılan reddedilir)
 *   `location_view` işaretliyse "Şimdi paylaş": 15 dk · 1 saat (varsayılan) · 8 saat · Gün sonu ·
 *     "Yalnızca izin ver, şimdi paylaşma" (görünmezken paylaşım başlamaz)
 *   "Sen de onun konumunu görmek istersen ayrıca izin iste" + düğme (ters yön kendiliğinden açılmaz)
 *   → `permission_request_respond` (izin + aynı işlemde paylaşım)
 */
import { ACCESS_SCOPE_TEXT, ACCESS_TEXT, type IncomingPermissionRequest } from '@konum/core';
import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { grantsStore, useCan, useGrantsStore } from '../../state/grantsStore';
import { useIsInvisible } from '../../state/invisibleStore';
import { Button, cardShadow, CheckRow, Chip, Overlay, SheetHeader, Text, useTheme } from '../../ui';
import { grantButtonTitle, initialGrantSheet, respondPlan, SHARE_NOW_OPTIONS, toggleGrantScope, type GrantSheetState } from './accessModel';
import { RequestPermissionButton } from './RequestPermissionButton';

export interface GrantSheetProps {
  request: IncomingPermissionRequest | null;
  name: string;
  onClose: () => void;
  /** Yanıt gitti: kısa sonuç metni (kart altında gösterilir). */
  onDone: (text: string) => void;
}

export function GrantSheet({ request, name, onClose, onDone }: GrantSheetProps) {
  if (!request) return null;
  return <GrantSheetBody key={`${request.requester_id}:${request.requested_at}`} request={request} name={name} onClose={onClose} onDone={onDone} />;
}

function GrantSheetBody({ request, name, onClose, onDone }: GrantSheetProps & { request: IncomingPermissionRequest }) {
  const { colors, radius, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const invisible = useIsInvisible();
  const busy = useGrantsStore((s) => !!s.busy[`respond:${request.requester_id}`]);
  const iSeeThem = useCan('location_view', request.requester_id, 'received');
  const [state, setState] = useState<GrantSheetState>(() => initialGrantSheet(request.scopes));
  const [error, setError] = useState<string | null>(null);
  const plan = respondPlan(state, { invisible });
  const locationOn = state.scopes.includes('location_view');

  const submit = async () => {
    setError(null);
    const r = await grantsStore.getState().respond(request.requester_id, plan.grantScopes, plan.share);
    if (!r.ok) {
      setError(r.message);
      return;
    }
    const granted = r.grantedScopes.length;
    let text = granted > 0 ? `${name} için izin verildi.` : 'İstek reddedildi.';
    if (r.shareStarted) text = `${name} için izin verildi, paylaşım başladı.`;
    else if (plan.share && r.shareSkipped === 'invisible') text = `${name} için izin verildi. Görünmez olduğun için paylaşım başlamadı.`;
    onDone(text);
  };

  return (
    <Overlay visible onRequestClose={onClose} testID="grant-sheet">
      <View style={[styles.backdrop, { paddingBottom: insets.bottom + spacing.md, paddingHorizontal: spacing.md }]}>
        <View style={[cardShadow, styles.card, { backgroundColor: colors.surface, borderRadius: radius.lg, paddingVertical: spacing.md, gap: spacing.sm }]}>
          <SheetHeader title="İzin ver" subtitle={`${name} şunları istiyor. İstemediğinin işaretini kaldır.`} onClose={onClose} />
          <ScrollView style={styles.scroll} contentContainerStyle={{ paddingHorizontal: spacing.md, gap: spacing.sm }}>
            <View>
              {request.scopes.map((s) => (
                <CheckRow
                  key={s}
                  testID={`grant-scope-${s}`}
                  checked={state.scopes.includes(s)}
                  onPress={() => setState((prev) => toggleGrantScope(prev, s, request.scopes))}
                  title={ACCESS_SCOPE_TEXT[s].given.title}
                  subtitle={ACCESS_SCOPE_TEXT[s].given.description}
                  disabled={busy}
                />
              ))}
            </View>

            {locationOn ? (
              <View style={{ gap: spacing.xs }}>
                <Text variant="heading">{ACCESS_TEXT.shareNowTitle}</Text>
                {invisible ? (
                  <Text variant="label" color="textSecondary">
                    Görünmezken paylaşım başlamaz; yalnızca izin verilir.
                  </Text>
                ) : (
                  <>
                    <View style={[styles.wrap, { gap: spacing.xs }]} accessibilityRole="radiogroup" accessibilityLabel={ACCESS_TEXT.shareNowTitle}>
                      {SHARE_NOW_OPTIONS.map((o) => (
                        <Chip key={o.id} label={o.label} selected={state.shareNow === o.id} onPress={() => setState((prev) => ({ ...prev, shareNow: o.id }))} disabled={busy} />
                      ))}
                    </View>
                    <Chip
                      label={ACCESS_TEXT.grantOnlyOption}
                      selected={state.shareNow === 'none'}
                      onPress={() => setState((prev) => ({ ...prev, shareNow: 'none' }))}
                      disabled={busy}
                      style={styles.start}
                    />
                  </>
                )}
              </View>
            ) : null}

            {!iSeeThem ? (
              <View style={[{ backgroundColor: colors.surfaceAlt, borderRadius: radius.md, padding: spacing.sm, gap: spacing.xs }]}>
                <Text variant="label" color="textSecondary">
                  {ACCESS_TEXT.reverseHint}
                </Text>
                <RequestPermissionButton to={request.requester_id} name={name} scopes={['location_view']} label="Konumunu görmek için izin iste" compact testID="grant-reverse-request" />
              </View>
            ) : null}
          </ScrollView>
          <View style={{ paddingHorizontal: spacing.md, gap: spacing.xs }}>
            {error ? (
              <Text variant="label" color="danger" accessibilityLiveRegion="assertive">
                {error}
              </Text>
            ) : null}
            <Button title={grantButtonTitle(plan)} testID="grant-submit" onPress={() => void submit()} loading={busy} disabled={plan.grantScopes.length === 0} />
          </View>
        </View>
      </View>
    </Overlay>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(15, 23, 42, 0.45)' },
  card: { maxHeight: '90%', width: '100%', maxWidth: 560, alignSelf: 'center' },
  scroll: { flexGrow: 0 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
  start: { alignSelf: 'flex-start' },
});
