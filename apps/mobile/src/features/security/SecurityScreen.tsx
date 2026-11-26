/**
 * Faz 10: Profil → Güvenlik → "Aktif Cihazlar ve Oturumlar" + hesap kurtarma (SMS + e-posta/Gmail).
 *
 *  - Cihaz listesi (bu cihaz, son etkinlik, konum yayını açık/kapalı, nasıl doğrulandı). Diğer etkin cihazda
 *    "Eski Cihazdaki Oturumu ve Konum Yayınını Kapat" (onay sayfası; isteğe bağlı "açık paylaşımlarımı da durdur").
 *  - Taşıma özeti (`?migrated=1`, ikinci aşamadan hemen sonra): arkadaşlar, izinler, favoriler, bölgeler, onaylar
 *    sunucu bildirimiyle karşılaştırılır; cihazda yeniden kurulanlar listelenir.
 *  - Kurtarma kanalları: telefon (giriş numarası, SMS kodu) + e-posta (kod). İkisi doğrulanınca iki aşamalı.
 */
import {
  MIGRATION_DEVICE_LOCAL,
  SECURITY_LIMITS,
  SECURITY_TEXT,
  compareMigration,
  deviceLastSeenText,
  migrationDigest,
  migrationKeys,
  normalizeEmail,
  orderedDigest,
  recoveryStatusText,
  type DeviceSessionDoc,
  type MigrationItemSummary,
  type MigrationKind,
} from '@konum/core';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { authStore, useAuthStore } from '../../state/authStore';
import { useFriends } from '../../state/friendsStore';
import { useGrantsStore } from '../../state/grantsStore';
import { securityStore, useSecurityStore } from '../../state/securityStore';
import { useZonesStore } from '../../state/zonesStore';
import { Button, cardShadow, CheckRow, IconButton, MIN_TOUCH, Overlay, SheetHeader, Text, useTheme } from '../../ui';

const PLATFORM_TEXT: Record<DeviceSessionDoc['platform'], string> = { ios: 'iOS', android: 'Android', web: 'Web' };

function useCard() {
  const { colors, radius, spacing } = useTheme();
  return [cardShadow, { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.md, gap: spacing.sm }];
}

export function SecurityScreen() {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ migrated?: string }>();
  const card = useCard();
  const devices = useSecurityStore((s) => s.devices);
  const myDsid = useSecurityStore((s) => s.myDsid);
  const toast = useSecurityStore((s) => s.toast);
  const error = useSecurityStore((s) => s.error);
  const busy = useSecurityStore((s) => s.busy);
  const [now, setNow] = useState(Date.now());
  const [confirm, setConfirm] = useState<DeviceSessionDoc | 'all' | null>(null);
  const migrated = params.migrated === '1';

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (migrated) {
      authStore.getState().clearMigrated();
      void securityStore.getState().loadManifest();
    }
  }, [migrated]);

  const sorted = useMemo(
    () =>
      [...devices].sort((a, b) => {
        const rank = (d: DeviceSessionDoc) => (d.dsid === myDsid ? 0 : d.status === 'active' ? 1 : d.status === 'pending' ? 2 : 3);
        return rank(a) - rank(b) || b.last_seen_at - a.last_seen_at;
      }),
    [devices, myDsid],
  );
  const others = sorted.filter((d) => d.dsid !== myDsid && d.status === 'active');

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.xs, paddingHorizontal: spacing.xs }]}>
        <IconButton icon="chevronLeft" accessibilityLabel="Geri" onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
        <Text variant="title" accessibilityRole="header" style={styles.flex}>
          Güvenlik
        </Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: spacing.md, gap: spacing.md, paddingBottom: insets.bottom + spacing.xl }} testID="security-screen">
        {migrated ? <MigrationCard /> : null}

        <View style={card} testID="security-devices">
          <Text variant="heading">{SECURITY_TEXT.screenTitle}</Text>
          {sorted.length === 0 ? (
            <Text variant="label" color="textSecondary">
              Yükleniyor…
            </Text>
          ) : null}
          {sorted.map((d) => {
            const isMe = d.dsid === myDsid;
            const active = d.status === 'active';
            return (
              <View key={d.dsid} style={[styles.device, { borderColor: colors.border, paddingVertical: spacing.sm, gap: 4 }]} testID={isMe ? 'device-current' : `device-${d.dsid}`}>
                <View style={[styles.row, { gap: spacing.xs }]}>
                  <Text variant="label" style={styles.flex} numberOfLines={1}>
                    {`${d.model} · ${PLATFORM_TEXT[d.platform]}${d.os_version ? ` ${d.os_version}` : ''}`}
                  </Text>
                  {isMe ? (
                    <Text variant="caption" color="primary">
                      {SECURITY_TEXT.thisDevice}
                    </Text>
                  ) : null}
                </View>
                <Text variant="caption" color="textSecondary">
                  {d.status === 'pending' ? 'Doğrulama bekliyor (e-posta kodu)' : deviceLastSeenText(d, now, isMe)}
                </Text>
                {d.status === 'active' ? (
                  <Text variant="caption" style={{ color: d.publishing ? colors.live : colors.textSecondary }}>
                    {d.publishing ? `● ${SECURITY_TEXT.publishingOn}` : SECURITY_TEXT.publishingOff}
                  </Text>
                ) : null}
                {d.verified_by.length ? (
                  <Text variant="caption" color="textSecondary">
                    {d.verified_by.includes('email') ? 'Doğrulama: SMS + e-posta' : 'Doğrulama: SMS'}
                  </Text>
                ) : null}
                {!isMe && active ? (
                  <Button title={SECURITY_TEXT.revokeOld} variant="danger" block onPress={() => setConfirm(d)} testID="device-revoke-open" />
                ) : null}
              </View>
            );
          })}
          {others.length > 1 ? <Button title={SECURITY_TEXT.revokeAll} variant="ghost" onPress={() => setConfirm('all')} /> : null}
          {toast ? (
            <Text variant="label" color="primary" accessibilityLiveRegion="polite" testID="security-toast">
              {toast}
            </Text>
          ) : null}
          {error && !busy ? (
            <Text variant="label" color="danger">
              {error}
            </Text>
          ) : null}
        </View>

        <RecoveryCard />
      </ScrollView>
      {confirm ? <RevokeSheet target={confirm} onClose={() => setConfirm(null)} /> : null}
    </View>
  );
}

function RevokeSheet({ target, onClose }: { target: DeviceSessionDoc | 'all'; onClose: () => void }) {
  const { colors, radius, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const [stopShares, setStopShares] = useState(false);
  const busy = useSecurityStore((s) => s.busy !== null);
  const model = target === 'all' ? 'Diğer tüm cihazlar' : target.model;
  return (
    <Overlay visible onRequestClose={onClose} testID="device-revoke-sheet">
      <View style={[styles.backdrop, { paddingBottom: insets.bottom + spacing.md, paddingHorizontal: spacing.md }]}>
        <View style={[cardShadow, styles.sheet, { backgroundColor: colors.surface, borderRadius: radius.lg, paddingVertical: spacing.md, gap: spacing.sm }]}>
          <SheetHeader title={SECURITY_TEXT.revokeConfirmTitle(model)} onClose={onClose} />
          <View style={{ paddingHorizontal: spacing.md, gap: spacing.sm }}>
            <Text variant="body">{SECURITY_TEXT.revokeConfirmBody}</Text>
            <CheckRow
              checked={stopShares}
              onPress={() => setStopShares((v) => !v)}
              title={SECURITY_TEXT.stopSharesToggle}
              subtitle="Kapalıysa paylaşımların bu telefondan sürer."
              testID="device-revoke-stop-shares"
            />
            <Button
              title={target === 'all' ? SECURITY_TEXT.revokeAll : SECURITY_TEXT.revokeOld}
              variant="danger"
              block
              loading={busy}
              testID="device-revoke-confirm"
              onPress={async () => {
                const ok = target === 'all' ? await securityStore.getState().revokeAllOthers(stopShares) : await securityStore.getState().revoke(target.dsid, stopShares);
                if (ok) onClose();
              }}
            />
            <Button title="Vazgeç" variant="ghost" block onPress={onClose} />
          </View>
        </View>
      </View>
    </Overlay>
  );
}

function RecoveryCard() {
  const { colors, radius, spacing, typography } = useTheme();
  const card = useCard();
  const recovery = useSecurityStore((s) => s.recovery);
  const pending = useSecurityStore((s) => s.pending);
  const busy = useSecurityStore((s) => s.busy);
  const phone = useAuthStore((s) => s.phoneE164);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const status = recoveryStatusText(recovery);
  const emailOk = normalizeEmail(email) !== null;
  const input = [typography.body, styles.input, { color: colors.text, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: spacing.sm }];
  const s = securityStore.getState();
  const verify = (c: string) => void s.verifyCode(c).then((ok) => ok && setCode(''));

  return (
    <View style={card} testID="security-recovery">
      <Text variant="heading">{SECURITY_TEXT.recoveryTitle}</Text>
      <Text variant="label" style={{ color: status.tone === 'ok' ? colors.live : colors.warning }} testID="recovery-status">
        {status.title}
      </Text>
      <Text variant="caption" color="textSecondary">
        Yeni telefona geçtiğinde önce SMS ile numaran, sonra e-postana giden kodla hesabın doğrulanır; arkadaşların, izinlerin, favorilerin, bölgelerin ve onayların taşınır.
      </Text>

      <View style={{ gap: 4 }}>
        <Text variant="label">{SECURITY_TEXT.smsLabel}</Text>
        <Text variant="caption" color="textSecondary">
          {recovery.sms ? `${recovery.sms.masked} · ${recovery.sms.verified_at ? 'doğrulandı ✓' : 'doğrulanmadı'}` : phone ? `${phone} · doğrulanmadı` : 'Giriş numaran'}
        </Text>
        {!recovery.sms?.verified_at && !pending ? (
          <Button title="SMS kodu ile doğrula" variant="secondary" loading={busy === 'sms'} onPress={() => void s.startSms()} testID="recovery-sms" />
        ) : null}
      </View>

      <View style={{ gap: 4 }}>
        <Text variant="label">{SECURITY_TEXT.emailLabel}</Text>
        {recovery.email ? (
          <>
            <Text variant="caption" color="textSecondary" testID="recovery-email">
              {`${recovery.email.masked}${recovery.email.gmail ? ' (Gmail)' : ''} · ${recovery.email.verified_at ? 'doğrulandı ✓' : 'doğrulanmadı'}`}
            </Text>
            <Button title="E-postayı kaldır" variant="ghost" loading={busy === 'remove_email'} onPress={() => void s.removeEmail()} />
          </>
        ) : null}
        {!pending ? (
          <>
            <TextInput
              value={email}
              onChangeText={setEmail}
              placeholder="ornek@gmail.com"
              placeholderTextColor={colors.textSecondary}
              keyboardType="email-address"
              autoCapitalize="none"
              autoComplete="email"
              maxLength={SECURITY_LIMITS.emailMaxChars}
              accessibilityLabel={SECURITY_TEXT.emailLabel}
              testID="recovery-email-input"
              style={input}
            />
            <Button
              title={recovery.email ? 'Yeni e-posta için kod gönder' : SECURITY_TEXT.sendCode}
              variant="secondary"
              disabled={!emailOk}
              loading={busy === 'email'}
              onPress={() => void s.startEmail(email)}
              testID="recovery-email-send"
            />
          </>
        ) : null}
      </View>

      {pending ? (
        <View style={{ gap: spacing.xs }} testID="recovery-code">
          <Text variant="label">{`${pending.challenge.to_masked} adresine giden 6 haneli kod`}</Text>
          <TextInput
            value={code}
            onChangeText={(v) => {
              const d = v.replace(/\D/g, '').slice(0, SECURITY_LIMITS.otpDigits);
              setCode(d);
              if (d.length === SECURITY_LIMITS.otpDigits) verify(d);
            }}
            keyboardType="number-pad"
            textContentType="oneTimeCode"
            maxLength={SECURITY_LIMITS.otpDigits}
            accessibilityLabel="Doğrulama kodu"
            testID="recovery-code-input"
            style={[input, styles.code]}
          />
          {pending.challenge.dev_code ? <Text variant="caption" color="primary">{`Demo: giden kod ${pending.challenge.dev_code}`}</Text> : null}
          <View style={[styles.row, { gap: spacing.xs }]}>
            <Button title={SECURITY_TEXT.verify} loading={busy === 'verify'} disabled={code.length !== SECURITY_LIMITS.otpDigits} onPress={() => verify(code)} />
            <Button title="Vazgeç" variant="ghost" onPress={() => s.cancelCode()} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

function MigrationCard() {
  const { colors, spacing } = useTheme();
  const card = useCard();
  const manifest = useSecurityStore((s) => s.manifest);
  const me = useAuthStore((s) => s.uid);
  const profile = useAuthStore((s) => s.profile);
  const friends = useFriends();
  const given = useGrantsStore((s) => s.given);
  const received = useGrantsStore((s) => s.received);
  const zones = useZonesStore((s) => s.zones);
  const local = useMemo(() => {
    const out: Partial<Record<MigrationKind, MigrationItemSummary>> = {};
    if (!me) return out;
    const scopesOf = (g: { scopes?: Record<string, unknown> }) =>
      Object.entries(g.scopes ?? {})
        .filter(([, v]) => v != null)
        .map(([k]) => k);
    const grants = [...Object.values(given), ...Object.values(received)].map((g) => migrationKeys.grant(g.granter_id, g.grantee_id, scopesOf(g))).filter((k) => !k.endsWith(':'));
    out.friendships = migrationDigest(friends.map((f) => migrationKeys.friendship(f.uid)));
    out.permission_grants = migrationDigest(grants);
    out.favorites = orderedDigest(profile?.favorite_ids ?? []);
    out.zones = migrationDigest(Object.keys(zones).map(migrationKeys.zone));
    out.consents = migrationDigest(profile?.consent ? [migrationKeys.consent(profile.consent.version, profile.consent.accepted_at ?? null)] : []);
    return out;
  }, [me, friends, given, received, zones, profile]);
  const rows = manifest ? compareMigration(manifest, local) : null;
  return (
    <View style={card} testID="security-migration">
      <Text variant="heading">{SECURITY_TEXT.migrationTitle}</Text>
      {!rows ? (
        <Text variant="label" color="textSecondary">
          Sunucuyla karşılaştırılıyor…
        </Text>
      ) : (
        rows.map((r) => (
          <View key={r.kind} style={[styles.row, { gap: spacing.xs }]}>
            <Text variant="label" style={{ color: r.ok ? colors.live : colors.warning, width: 18 }}>
              {r.ok ? '✓' : '…'}
            </Text>
            <Text variant="label" style={styles.flex}>
              {r.title}
            </Text>
            <Text variant="caption" color="textSecondary">
              {r.ok ? `${r.server.count}` : r.detail}
            </Text>
          </View>
        ))
      )}
      <Text variant="caption" color="textSecondary">
        Bu telefonda yeniden kurulanlar:
      </Text>
      {MIGRATION_DEVICE_LOCAL.map((t) => (
        <Text key={t} variant="caption" color="textSecondary">{`• ${t}`}</Text>
      ))}
      <Text variant="label" color="primary">
        Şimdi aşağıdan eski telefonundaki oturumu ve konum yayınını kapat.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  device: { borderTopWidth: StyleSheet.hairlineWidth },
  input: { borderWidth: 1, minHeight: MIN_TOUCH },
  code: { letterSpacing: 6, textAlign: 'center' },
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(15, 23, 42, 0.45)' },
  sheet: { maxHeight: '90%', width: '100%', maxWidth: 560, alignSelf: 'center' },
});
