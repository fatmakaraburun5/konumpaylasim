/**
 * Faz 5: kural düzenleyici alt sayfası (@gorhom/bottom-sheet, NoteSheet deseni).
 *
 *   şablon çipleri (core `ZONE_RULE_TEMPLATES`: "Vardığımda bildir", "Çıkınca paylaşımı başlat" …)
 *   kişiler (kabul edilmiş arkadaşlar, en çok 10; sunucu arkadaş olmayanları sessizce düşürür)
 *   paylaşım süresi (yalnızca start_share; core `ZONE_SHARE_DURATIONS`)
 *   günler (core `WEEKDAY_SHORT_TR`, hazır: Her gün / Hafta içi / Hafta sonu)
 *   isteğe bağlı saat aralığı (30 dk adım; gece yarısını aşabilir: 22:00–06:00)
 *   özet satırı (core `describeZoneRule`) · Kaydet / Kuralı sil
 */
import { uuidV4, WEEKDAY_SHORT_TR, ZONE_RULE_TEMPLATES, ZONE_SHARE_DURATIONS, type UserId, type ZoneRule } from '@konum/core';
import { BottomSheetBackdrop, BottomSheetModal, BottomSheetScrollView, type BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { useRouter } from 'expo-router';
import { useCallback, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from 'react';
import { StyleSheet, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFriendNames, useFriends } from '../../state/friendsStore';
import { Button, Chip, IconButton, SheetHeader, Text, useTheme } from '../../ui';
import { RecipientPicker } from '../share/RecipientPicker';
import {
  applyTemplate,
  DAY_PRESETS,
  DEFAULT_WINDOW,
  formatMinuteOfDay,
  isDayOn,
  ruleFromTemplate,
  ruleSummary,
  ruleTemplateId,
  sameDuration,
  shareDurationLabel,
  stepMinuteOfDay,
  toggleDay,
  toggleRecipient,
  validateRule,
} from './zoneModel';

export interface ZoneRuleSheetHandle {
  /** `rule` null = yeni kural (varsayılan şablon "Vardığımda bildir"). */
  present: (rule: ZoneRule | null, zoneName: string) => void;
  dismiss: () => void;
}

export interface ZoneRuleSheetProps {
  onSave: (rule: ZoneRule) => void;
  onDelete: (ruleId: string) => void;
  ref?: Ref<ZoneRuleSheetHandle>;
}

export function ZoneRuleSheet({ onSave, onDelete, ref }: ZoneRuleSheetProps) {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const sheet = useRef<BottomSheetModal>(null);
  const friends = useFriends();
  const names = useFriendNames();
  const [rule, setRule] = useState<ZoneRule>(() => ruleFromTemplate('arrive_notify', ''));
  const [isNew, setIsNew] = useState(true);
  const [zoneName, setZoneName] = useState('');
  const [error, setError] = useState<string | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      present: (r, zn) => {
        setRule(r ? { ...r, recipient_ids: [...r.recipient_ids] } : ruleFromTemplate('arrive_notify', uuidV4()));
        setIsNew(r === null);
        setZoneName(zn.trim() || 'Bölge');
        setError(null);
        sheet.current?.present();
      },
      dismiss: () => sheet.current?.dismiss(),
    }),
    [],
  );

  const templateId = ruleTemplateId(rule);
  const selected = new Set<UserId>(rule.recipient_ids);
  const toggle = (uid: UserId) => {
    const r = toggleRecipient(rule.recipient_ids, uid);
    setError(r.error);
    setRule((prev) => ({ ...prev, recipient_ids: r.next }));
  };

  const save = () => {
    const err = validateRule(rule);
    if (err) {
      setError(err);
      return;
    }
    onSave(rule);
    sheet.current?.dismiss();
  };

  const renderBackdrop = useCallback(
    (p: BottomSheetBackdropProps) => <BottomSheetBackdrop {...p} appearsOnIndex={0} disappearsOnIndex={-1} pressBehavior="close" />,
    [],
  );

  const w = rule.window;
  return (
    <BottomSheetModal
      ref={sheet}
      snapPoints={['92%']}
      enableDynamicSizing={false}
      backdropComponent={renderBackdrop}
      backgroundStyle={{ backgroundColor: colors.surface }}
      handleIndicatorStyle={{ backgroundColor: colors.border }}
      keyboardBehavior="interactive"
      android_keyboardInputMode="adjustResize"
    >
      <BottomSheetScrollView contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xl, gap: spacing.md }} keyboardShouldPersistTaps="handled">
        <SheetHeader title={isNew ? 'Kural ekle' : 'Kuralı düzenle'} subtitle={ruleSummary(rule, zoneName, names)} onClose={() => sheet.current?.dismiss()} />

        <Section title="Ne zaman, ne olsun?">
          <View style={[styles.wrap, { gap: spacing.xs }]} accessibilityRole="radiogroup" accessibilityLabel="Kural şablonu">
            {ZONE_RULE_TEMPLATES.map((t) => (
              <Chip key={t.id} label={t.label} selected={t.id === templateId} onPress={() => setRule((prev) => applyTemplate(prev, t.id))} />
            ))}
          </View>
        </Section>

        {rule.action === 'start_share' ? (
          <Section title="Paylaşım süresi">
            <View style={[styles.wrap, { gap: spacing.xs }]} accessibilityRole="radiogroup" accessibilityLabel="Paylaşım süresi">
              {ZONE_SHARE_DURATIONS.map((d) => (
                <Chip key={shareDurationLabel(d)} label={shareDurationLabel(d)} selected={sameDuration(d, rule.share_duration)} onPress={() => setRule((prev) => ({ ...prev, share_duration: d }))} />
              ))}
            </View>
          </Section>
        ) : null}

        <View style={{ gap: spacing.xs }}>
          <Text variant="heading" style={{ paddingHorizontal: spacing.md }}>
            {`${rule.action === 'notify' ? 'Kime bildirilsin' : 'Kiminle paylaşılsın'}${rule.recipient_ids.length > 0 ? ` (${rule.recipient_ids.length})` : ''}`}
          </Text>
          <RecipientPicker
            friends={friends}
            selected={selected}
            onToggle={toggle}
            onAddFriend={() => {
              sheet.current?.dismiss();
              router.push('/friends');
            }}
          />
        </View>

        <Section title="Günler">
          <View style={[styles.wrap, { gap: spacing.xs }]}>
            {DAY_PRESETS.map((p) => (
              <Chip key={p.id} label={p.label} selected={rule.days_mask === p.mask} onPress={() => setRule((prev) => ({ ...prev, days_mask: p.mask }))} />
            ))}
          </View>
          <View style={[styles.wrap, { gap: spacing.xxs }]} accessibilityLabel="Haftanın günleri">
            {WEEKDAY_SHORT_TR.map((d, i) => (
              <Chip key={d} label={d} selected={isDayOn(rule.days_mask, i)} onPress={() => setRule((prev) => ({ ...prev, days_mask: toggleDay(prev.days_mask, i) }))} style={styles.day} />
            ))}
          </View>
        </Section>

        <Section title="Saat aralığı">
          <View style={[styles.row, { gap: spacing.sm }]}>
            <Text variant="body" style={styles.flex}>
              Yalnızca belirli saatlerde
            </Text>
            <Switch
              value={w !== null}
              onValueChange={(on) => setRule((prev) => ({ ...prev, window: on ? DEFAULT_WINDOW : null }))}
              accessibilityLabel="Yalnızca belirli saatlerde"
            />
          </View>
          {w ? (
            <View style={{ gap: spacing.xs }}>
              <TimeStepper label="Başlangıç" minute={w.from_min} onChange={(m) => setRule((prev) => ({ ...prev, window: { from_min: m, to_min: prev.window?.to_min ?? DEFAULT_WINDOW.to_min } }))} />
              <TimeStepper label="Bitiş" minute={w.to_min} onChange={(m) => setRule((prev) => ({ ...prev, window: { from_min: prev.window?.from_min ?? DEFAULT_WINDOW.from_min, to_min: m } }))} />
              {w.from_min > w.to_min ? (
                <Text variant="caption" color="textSecondary">
                  Aralık gece yarısını aşıyor.
                </Text>
              ) : null}
            </View>
          ) : (
            <Text variant="caption" color="textSecondary">
              Gün boyu çalışır.
            </Text>
          )}
        </Section>

        <View style={{ paddingHorizontal: spacing.md, gap: spacing.xs }}>
          {error ? (
            <Text variant="label" color="danger" accessibilityLiveRegion="assertive">
              {error}
            </Text>
          ) : null}
          <Button title={isNew ? 'Kuralı ekle' : 'Kuralı kaydet'} size="lg" onPress={save} />
          {!isNew ? (
            <Button
              title="Kuralı sil"
              variant="danger"
              onPress={() => {
                onDelete(rule.rule_id);
                sheet.current?.dismiss();
              }}
            />
          ) : null}
        </View>
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const { spacing } = useTheme();
  return (
    <View style={{ gap: spacing.xs, paddingHorizontal: spacing.md }}>
      <Text variant="heading">{title}</Text>
      {children}
    </View>
  );
}

function TimeStepper({ label, minute, onChange }: { label: string; minute: number; onChange: (m: number) => void }) {
  const { spacing } = useTheme();
  return (
    <View style={[styles.row, { gap: spacing.xs }]}>
      <Text variant="body" style={styles.flex}>
        {label}
      </Text>
      <IconButton icon="minus" variant="soft" size={36} accessibilityLabel={`${label} saatini 30 dakika geri al`} onPress={() => onChange(stepMinuteOfDay(minute, -1))} />
      <Text variant="heading" style={styles.clock} accessibilityLiveRegion="polite">
        {formatMinuteOfDay(minute)}
      </Text>
      <IconButton icon="plus" variant="soft" size={36} accessibilityLabel={`${label} saatini 30 dakika ileri al`} onPress={() => onChange(stepMinuteOfDay(minute, 1))} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  day: { paddingHorizontal: 10, minWidth: 48 },
  clock: { minWidth: 56, textAlign: 'center', fontVariant: ['tabular-nums'] },
});
