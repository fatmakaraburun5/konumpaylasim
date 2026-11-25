/**
 * Faz 6: cinsiyeti olmayan eski (Faz 1–5) hesap için engelleyici seçim ekranı. Kayıtta zorunlu olan alan sonradan
 * eklendiği için bu hesaplar girişten sonra bir kez seçer; seçim `user_bootstrap { gender }` ile kaydedilir ve
 * arkadaşların gördüğü kopyaya (harita pini / widget çerçevesi) yayılır. Oturum servisleri bu sırada çalışır
 * (süren paylaşımlar kesilmez). Çıkış yapılabilir.
 */
import type { Gender } from '@konum/core';
import { useState } from 'react';
import { View } from 'react-native';
import { useAuthStore } from '../../state/authStore';
import { Button, Text, useTheme } from '../../ui';
import { AuthScaffold } from '../auth/AuthScaffold';
import { GenderPicker } from './GenderPicker';

export function GenderGate() {
  const { spacing } = useTheme();
  const name = useAuthStore((s) => s.profile?.display_name ?? '');
  const updateProfile = useAuthStore((s) => s.updateProfile);
  const signOut = useAuthStore((s) => s.signOut);
  const [gender, setGender] = useState<Gender | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!gender) return;
    setBusy(true);
    setError(null);
    const r = await updateProfile({ gender });
    setBusy(false);
    // Başarıda profil dinleyicisi `gender`'ı getirir ve kapı kendiliğinden kalkar.
    if (!r.ok) setError(r.message);
  };

  return (
    <AuthScaffold
      title={name ? `Merhaba ${name.split(' ')[0]}` : 'Bir adım kaldı'}
      subtitle="Profilin artık bir cinsiyet bilgisi içeriyor. Fotoğrafının çerçevesi buna göre renklenir: kadın pembe, erkek mavi. Arkadaşların bunu haritada ve widget’ta görür."
      footer={
        <>
          <Button title="Kaydet ve devam et" size="lg" onPress={() => void save()} loading={busy} disabled={gender === null} />
          <Button title="Çıkış yap" variant="ghost" onPress={() => void signOut()} disabled={busy} />
        </>
      }
    >
      <View style={{ gap: spacing.sm }} testID="gender-gate">
        <Text variant="heading">Cinsiyet</Text>
        <GenderPicker value={gender} onChange={setGender} disabled={busy} />
        {error ? (
          <Text variant="label" color="danger" accessibilityLiveRegion="polite">
            {error}
          </Text>
        ) : null}
      </View>
    </AuthScaffold>
  );
}
