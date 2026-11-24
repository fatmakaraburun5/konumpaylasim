/**
 * YALNIZCA web demo: react-native-web'de `Alert.alert` hiçbir şey yapmaz (çıkış onayı, "Görmeyi bırak",
 * "Arkadaşlıktan çıkar" gibi iletişim kutuları görünmez). Bu modül yüklenince `Alert.alert`, telefon
 * çerçevesinin içinde açılan uygulama içi bir iletişim kutusuna yönlendirilir. `window.confirm` kullanılmaz:
 * korumalı iframe'de (allow-modals yok) engellenir.
 * Native paket bu dosyayı hiç görmez (yalnızca DemoShell.web.tsx içe aktarır).
 */
import { useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, View, type AlertButton } from 'react-native';
import { cardShadow, Text, useTheme } from '../../ui';

interface AlertRequest {
  id: number;
  title: string;
  message?: string;
  buttons: AlertButton[];
}

let seq = 0;
let queue: AlertRequest[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

Alert.alert = (title: string, message?: string, buttons?: AlertButton[]) => {
  queue = [...queue, { id: ++seq, title, message, buttons: buttons && buttons.length > 0 ? buttons : [{ text: 'Tamam' }] }];
  emit();
};

export function AlertHost() {
  const { colors, radius, spacing } = useTheme();
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);

  const current = queue[0];
  if (!current) return null;

  const close = (b?: AlertButton) => {
    queue = queue.slice(1);
    emit();
    b?.onPress?.();
  };
  const cancel = current.buttons.find((b) => b.style === 'cancel');

  return (
    <View style={[StyleSheet.absoluteFill, styles.root]} accessibilityViewIsModal>
      <Pressable style={[StyleSheet.absoluteFill, styles.backdrop]} onPress={() => (cancel ? close(cancel) : undefined)} accessibilityLabel="İletişim kutusunu kapat" />
      <View accessibilityRole="alert" style={[cardShadow, styles.card, { backgroundColor: colors.surface, borderRadius: radius.xl, padding: spacing.lg, gap: spacing.sm }]}>
        <Text variant="heading">{current.title}</Text>
        {current.message ? (
          <Text variant="body" color="textSecondary">
            {current.message}
          </Text>
        ) : null}
        <View style={[styles.buttons, { gap: spacing.xs, marginTop: spacing.xs }]}>
          {current.buttons.map((b, i) => {
            const destructive = b.style === 'destructive';
            const isCancel = b.style === 'cancel';
            return (
              <Pressable
                key={`${current.id}-${i}`}
                accessibilityRole="button"
                onPress={() => close(b)}
                style={({ pressed }) => [
                  styles.btn,
                  {
                    borderRadius: radius.md,
                    backgroundColor: isCancel ? colors.surfaceAlt : destructive ? colors.danger : colors.primary,
                    opacity: pressed ? 0.8 : 1,
                  },
                ]}
              >
                <Text variant="label" style={{ color: isCancel ? colors.text : '#FFFFFF', fontWeight: '600' }}>
                  {b.text ?? 'Tamam'}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { zIndex: 80, alignItems: 'center', justifyContent: 'center', padding: 24 },
  backdrop: { backgroundColor: 'rgba(15, 23, 42, 0.45)' },
  card: { width: '100%', maxWidth: 340 },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end' },
  btn: { minHeight: 44, minWidth: 96, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center', flexGrow: 1 },
});
