/**
 * YALNIZCA web demo: ProfileNameScreen.tsx ile aynı ekran (Faz 6: zorunlu cinsiyet çipleri); ad alanı demo adıyla
 * (Deniz Kaya) dolu gelir, cinsiyet seçilmeden "Devam" pasif.
 * Native paket ProfileNameScreen.tsx'i kullanır.
 */
import type { Gender } from '@konum/core';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, TextInput, View } from 'react-native';
import { useAuthStore } from '../../state/authStore';
import { Button, MIN_TOUCH, Text, useTheme } from '../../ui';
import { DEMO_ME_NAME } from '../../demo/server';
import { GenderPicker } from '../profile/GenderPicker';
import { AuthScaffold } from './AuthScaffold';

export function ProfileNameScreen() {
  const { colors, radius, spacing, typography } = useTheme();
  const status = useAuthStore((s) => s.status);
  const busy = useAuthStore((s) => s.busy);
  const error = useAuthStore((s) => s.error);
  const completeProfile = useAuthStore((s) => s.completeProfile);
  const retryBootstrap = useAuthStore((s) => s.retryBootstrap);
  const signOut = useAuthStore((s) => s.signOut);
  const [gender, setGender] = useState<Gender | null>(null);
  const [name, setName] = useState(DEMO_ME_NAME);

  if (status === 'bootstrapping') {
    return (
      <AuthScaffold title="Hesabın hazırlanıyor" subtitle="Bu birkaç saniye sürebilir.">
        <View style={[styles.center, { gap: spacing.md }]}>
          {error ? (
            <>
              <Text variant="label" color="danger">
                {error}
              </Text>
              <Button title="Tekrar dene" onPress={() => void retryBootstrap()} />
              <Button title="Çıkış yap" variant="ghost" onPress={() => void signOut()} />
            </>
          ) : (
            <ActivityIndicator color={colors.primary} />
          )}
        </View>
      </AuthScaffold>
    );
  }

  const trimmed = name.trim();
  return (
    <AuthScaffold
      title="Adın ne?"
      subtitle="Arkadaşların seni bu adla görür. Daha sonra değiştirebilirsin."
      footer={
        <Button
          title="Devam"
          size="lg"
          onPress={() => {
            if (gender) void completeProfile(trimmed, gender);
          }}
          loading={busy}
          disabled={trimmed.length < 1 || gender === null}
          accessibilityHint={gender === null ? 'Devam etmek için cinsiyet seç' : undefined}
        />
      }
    >
      <TextInput
        value={name}
        onChangeText={setName}
        placeholder="Ad Soyad"
        placeholderTextColor={colors.textSecondary}
        textContentType="name"
        autoComplete="name"
        autoCapitalize="words"
        maxLength={40}
        accessibilityLabel="Görünen ad"
        autoFocus
        style={[typography.heading, styles.input, { color: colors.text, backgroundColor: colors.surface, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: spacing.md }]}
      />
      <View style={{ gap: spacing.xs, marginTop: spacing.sm }}>
        <Text variant="heading">Cinsiyet</Text>
        <Text variant="label" color="textSecondary">
          Profil fotoğrafının çerçevesi buna göre renklenir: kadın pembe, erkek mavi.
        </Text>
        <GenderPicker value={gender} onChange={setGender} disabled={busy} />
      </View>
      {error ? (
        <Text variant="label" color="danger">
          {error}
        </Text>
      ) : null}
    </AuthScaffold>
  );
}

const styles = StyleSheet.create({
  input: { borderWidth: 1.5, minHeight: MIN_TOUCH + 12 },
  center: { alignItems: 'stretch', paddingTop: 24 },
});
