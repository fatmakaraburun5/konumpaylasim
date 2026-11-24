/**
 * Faz 5: bölge düzenleyici (app/(main)/zone-edit.tsx, `?id=` yoksa yeni bölge).
 *
 *   üstte harita (native MapView / web önizleme haritası): merkez = harita ortası artı işareti, yarıçap dairesi,
 *     "Şu anki konumum" düğmesi
 *   tür çipleri Ev / İş / Okul / Özel nokta (ad boşsa ya da varsayılansa türle birlikte değişir), ad
 *   yarıçap çipleri 100 m – 2 km + ± 50 m
 *   kurallar (özet satırları; dokun → ZoneRuleSheet), "Kural ekle" (en çok 6)
 *   bölge açık / kapalı · Kaydet · Bölgeyi sil
 * Kayıtta sunucu arkadaş olmayan alıcıları sessizce düşürür: düşenler uyarıyla gösterilir.
 */
import { ZONE_KIND_EMOJI, ZONE_KIND_TEXT, ZONE_KINDS, ZONE_LIMITS, formatZoneRadius, type LatLng, type ZoneKind, type ZoneRule } from '@konum/core';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFriendNames } from '../../state/friendsStore';
import { locationStore, useLocationStore } from '../../state/locationStore';
import { NEW_ZONE_KEY, useZonesStore, zonesStore } from '../../state/zonesStore';
import { Button, cardShadow, Chip, IconButton, MIN_TOUCH, Text, useTheme } from '../../ui';
import { ZoneEditorMap, type ZoneEditorMapHandle } from './ZoneEditorMap';
import { ZoneRuleSheet, type ZoneRuleSheetHandle } from './ZoneRuleSheet';
import { clampZoneRadius, DEFAULT_ZONE_CENTER, droppedRecipientsText, nameOnKindChange, ruleSummary, stepZoneRadius, ZONE_RADIUS_CHIPS } from './zoneModel';

export function ZoneEditScreen({ zoneId }: { zoneId: string | null }) {
  const { colors, radius, spacing, typography } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const names = useFriendNames();
  const zone = useZonesStore((s) => (zoneId ? s.zones[zoneId] : undefined));
  const pending = useZonesStore((s) => s.pending[zoneId ?? NEW_ZONE_KEY]);
  const hasMyPosition = useLocationStore((s) => s.myPosition !== null);
  const map = useRef<ZoneEditorMapHandle>(null);
  const ruleSheet = useRef<ZoneRuleSheetHandle>(null);

  const [initialCenter] = useState<LatLng>(() => {
    if (zone) return zone.center;
    const p = locationStore.getState().myPosition;
    return p ? { lat: p.lat, lng: p.lng } : DEFAULT_ZONE_CENTER;
  });
  const center = useRef<LatLng>(initialCenter);
  const [kind, setKind] = useState<ZoneKind>(zone?.kind ?? 'home');
  const [name, setName] = useState(zone?.name ?? ZONE_KIND_TEXT.home);
  const [radiusM, setRadiusM] = useState(zone?.radius_m ?? ZONE_LIMITS.defaultRadiusM);
  const [rules, setRules] = useState<ZoneRule[]>(zone?.rules ?? []);
  const [enabled, setEnabled] = useState(zone?.enabled ?? true);
  const [error, setError] = useState<string | null>(null);

  if (zoneId && !zone) {
    return (
      <View style={[styles.root, { backgroundColor: colors.bg, paddingTop: insets.top + spacing.md, paddingHorizontal: spacing.md, gap: spacing.md }]}>
        <Text variant="title">Bölge bulunamadı</Text>
        <Text variant="body" color="textSecondary">
          Bu bölge silinmiş olabilir.
        </Text>
        <Button title="Geri dön" variant="secondary" onPress={() => router.back()} />
      </View>
    );
  }

  const emoji = zone && zone.kind === kind && zone.emoji ? zone.emoji : ZONE_KIND_EMOJI[kind];
  const busy = pending !== undefined;

  const goToMyLocation = () => {
    const p = locationStore.getState().myPosition;
    if (p) map.current?.centerOn({ lat: p.lat, lng: p.lng });
  };

  const upsertRule = (r: ZoneRule) => setRules((prev) => (prev.some((x) => x.rule_id === r.rule_id) ? prev.map((x) => (x.rule_id === r.rule_id ? r : x)) : [...prev, r]));
  const deleteRule = (id: string) => setRules((prev) => prev.filter((x) => x.rule_id !== id));
  const toggleRule = (id: string) => setRules((prev) => prev.map((x) => (x.rule_id === id ? { ...x, enabled: !x.enabled } : x)));

  const save = async () => {
    if (!name.trim()) {
      setError('Bölgeye bir ad ver.');
      return;
    }
    setError(null);
    const r = await zonesStore.getState().upsert({
      zone_id: zoneId,
      kind,
      name,
      emoji: zone && zone.kind === kind ? zone.emoji : null,
      center: center.current,
      radius_m: radiusM,
      rules,
      enabled,
    });
    if (!r.ok) {
      setError(r.error.message);
      return;
    }
    const dropped = droppedRecipientsText(r.dropped_recipient_ids, names);
    if (dropped) Alert.alert('Bölge kaydedildi', dropped, [{ text: 'Tamam', onPress: () => router.back() }]);
    else router.back();
  };

  const remove = () => {
    if (!zoneId) return;
    Alert.alert('Bölgeyi sil', `${name || 'Bölge'} ve kuralları silinecek; bu bölge için bildirim gitmeyecek.`, [
      { text: 'Vazgeç', style: 'cancel' },
      {
        text: 'Sil',
        style: 'destructive',
        onPress: async () => {
          const ok = await zonesStore.getState().remove(zoneId);
          if (ok) router.back();
          else setError('Bölge silinemedi. Bağlantını kontrol edip tekrar dene.');
        },
      },
    ]);
  };

  const card = [cardShadow, { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.md, gap: spacing.sm }];

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <View style={styles.mapBox}>
        <ZoneEditorMap ref={map} initialCenter={initialCenter} radiusM={radiusM} emoji={emoji} onCenterChange={(c) => (center.current = c)} />
        <View style={[styles.mapTop, { paddingTop: insets.top + spacing.xs, paddingHorizontal: spacing.xs }]} pointerEvents="box-none">
          <IconButton icon="chevronLeft" variant="floating" accessibilityLabel="Geri" onPress={() => router.back()} />
          <View style={[styles.titlePill, cardShadow, { backgroundColor: colors.surface, borderRadius: radius.pill, paddingHorizontal: spacing.md }]}>
            <Text variant="heading" accessibilityRole="header" numberOfLines={1}>
              {zoneId ? 'Bölgeyi düzenle' : 'Yeni bölge'}
            </Text>
          </View>
        </View>
        <View style={[styles.mapBottom, { padding: spacing.sm }]} pointerEvents="box-none">
          <Text variant="caption" style={[styles.hint, { backgroundColor: colors.surface, borderRadius: radius.sm, color: colors.textSecondary }]}>
            Merkez için haritayı kaydır
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Şu anki konumum"
            onPress={goToMyLocation}
            disabled={!hasMyPosition}
            style={({ pressed }) => [
              styles.myLoc,
              cardShadow,
              { backgroundColor: pressed ? colors.surfaceAlt : colors.surface, borderRadius: radius.pill, paddingHorizontal: spacing.md, opacity: hasMyPosition ? 1 : 0.5 },
            ]}
          >
            <Text variant="label" color="primary">
              ◎ Şu anki konumum
            </Text>
          </Pressable>
        </View>
      </View>

      <ScrollView contentContainerStyle={{ padding: spacing.md, gap: spacing.md, paddingBottom: insets.bottom + spacing.xl }} keyboardShouldPersistTaps="handled">
        <View style={card}>
          <View style={[styles.wrap, { gap: spacing.xs }]} accessibilityRole="radiogroup" accessibilityLabel="Bölge türü">
            {ZONE_KINDS.map((k) => (
              <Chip
                key={k}
                label={`${ZONE_KIND_EMOJI[k]} ${ZONE_KIND_TEXT[k]}`}
                selected={k === kind}
                onPress={() => {
                  setName((n) => nameOnKindChange(kind, k, n));
                  setKind(k);
                }}
              />
            ))}
          </View>
          <TextInput
            value={name}
            onChangeText={(v) => {
              setName(v);
              setError(null);
            }}
            placeholder="Bölge adı"
            placeholderTextColor={colors.textSecondary}
            accessibilityLabel="Bölge adı"
            maxLength={ZONE_LIMITS.nameMaxChars}
            style={[typography.heading, styles.input, { color: colors.text, backgroundColor: colors.surfaceAlt, borderRadius: radius.md, paddingHorizontal: spacing.md }]}
          />
        </View>

        <View style={card}>
          <View style={[styles.row, { gap: spacing.xs }]}>
            <Text variant="heading" style={styles.flex}>
              {`Yarıçap · ${formatZoneRadius(radiusM)}`}
            </Text>
            <IconButton icon="minus" variant="soft" size={36} accessibilityLabel="Yarıçapı küçült" onPress={() => setRadiusM((m) => stepZoneRadius(m, -1))} disabled={radiusM <= ZONE_LIMITS.minRadiusM} />
            <IconButton icon="plus" variant="soft" size={36} accessibilityLabel="Yarıçapı büyüt" onPress={() => setRadiusM((m) => stepZoneRadius(m, 1))} disabled={radiusM >= ZONE_LIMITS.maxRadiusM} />
          </View>
          <View style={[styles.wrap, { gap: spacing.xs }]} accessibilityRole="radiogroup" accessibilityLabel="Yarıçap">
            {ZONE_RADIUS_CHIPS.map((m) => (
              <Chip key={m} label={formatZoneRadius(m)} selected={clampZoneRadius(radiusM) === m} onPress={() => setRadiusM(m)} />
            ))}
          </View>
          <Text variant="caption" color="textSecondary">
            Küçük yarıçapta GPS sapması daha çok hissedilir; varış/ayrılış birkaç dakika doğrulanır.
          </Text>
        </View>

        <View style={card}>
          <Text variant="heading">{`Kurallar${rules.length > 0 ? ` (${rules.length})` : ''}`}</Text>
          {rules.length === 0 ? (
            <Text variant="label" color="textSecondary">
              Henüz kural yok. Örneğin "Vardığımda bildir" ya da "Çıkınca paylaşımı başlat".
            </Text>
          ) : null}
          {rules.map((r) => (
            <View key={r.rule_id} style={[styles.row, { gap: spacing.sm }]}>
              <Pressable
                accessibilityRole="button"
                accessibilityHint="Kuralı düzenle"
                onPress={() => ruleSheet.current?.present(r, name)}
                style={({ pressed }) => [styles.flex, { minHeight: MIN_TOUCH, justifyContent: 'center', opacity: pressed ? 0.7 : r.enabled ? 1 : 0.55 }]}
              >
                <Text variant="body">{ruleSummary(r, name.trim() || 'Bölge', names)}</Text>
              </Pressable>
              <Switch value={r.enabled} onValueChange={() => toggleRule(r.rule_id)} accessibilityLabel="Kural açık" />
            </View>
          ))}
          <Button
            title="Kural ekle"
            variant="secondary"
            onPress={() => ruleSheet.current?.present(null, name)}
            disabled={rules.length >= ZONE_LIMITS.maxRulesPerZone}
          />
        </View>

        <View style={[card, styles.row]}>
          <View style={styles.flex}>
            <Text variant="heading">Bölge açık</Text>
            <Text variant="caption" color="textSecondary">
              Kapalı bölgede varış / ayrılış algılanmaz.
            </Text>
          </View>
          <Switch value={enabled} onValueChange={setEnabled} accessibilityLabel="Bölge açık" />
        </View>

        {error ? (
          <Text variant="label" color="danger" accessibilityLiveRegion="assertive">
            {error}
          </Text>
        ) : null}
        <Button title="Kaydet" size="lg" onPress={() => void save()} loading={pending === 'saving'} disabled={busy} />
        {zoneId ? <Button title="Bölgeyi sil" variant="danger" onPress={remove} loading={pending === 'deleting'} disabled={busy} /> : null}
      </ScrollView>

      <ZoneRuleSheet ref={ruleSheet} onSave={upsertRule} onDelete={deleteRule} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  mapBox: { height: '42%', minHeight: 260, overflow: 'hidden' },
  mapTop: { position: 'absolute', top: 0, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', gap: 8 },
  titlePill: { minHeight: MIN_TOUCH, justifyContent: 'center' },
  // Alt sol köşede harita logosu / "Önizleme haritası" etiketi var: düğmeler biraz yukarıda.
  mapBottom: { position: 'absolute', left: 0, right: 0, bottom: 22, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  hint: { paddingHorizontal: 8, paddingVertical: 3, opacity: 0.9 },
  myLoc: { minHeight: MIN_TOUCH, justifyContent: 'center' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  input: { minHeight: MIN_TOUCH + 4 },
});
