import { StyleSheet, View } from 'react-native';
import { IconButton } from './IconButton';
import { Text } from './Text';
import { useTheme } from './theme';

export interface SheetHeaderProps {
  title: string;
  subtitle?: string;
  onClose?: () => void;
}

export function SheetHeader({ title, subtitle, onClose }: SheetHeaderProps) {
  const { spacing } = useTheme();
  return (
    <View style={[styles.row, { paddingHorizontal: spacing.md, paddingBottom: spacing.xs }]}>
      <View style={styles.titles}>
        <Text variant="title" accessibilityRole="header">
          {title}
        </Text>
        {subtitle ? (
          <Text variant="label" color="textSecondary">
            {subtitle}
          </Text>
        ) : null}
      </View>
      {onClose ? <IconButton icon="close" accessibilityLabel="Kapat" onPress={onClose} variant="soft" size={36} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  titles: { flex: 1 },
});
