import { Text as RNText, type TextProps as RNTextProps, type TextStyle } from 'react-native';
import { useTheme } from './theme';
import type { ColorTokens, TypeVariant } from './tokens';

export interface TextProps extends RNTextProps {
  variant?: TypeVariant;
  /** Belirteç adı (varsayılan `text`). */
  color?: keyof ColorTokens;
  align?: TextStyle['textAlign'];
}

/** Tipografi ölçeği: title 22/28 700, heading 17/22 600, body 15/20 400, label 13/18 500, caption 12/16 500. */
export function Text({ variant = 'body', color = 'text', align, style, ...rest }: TextProps) {
  const theme = useTheme();
  return (
    <RNText
      maxFontSizeMultiplier={1.4}
      {...rest}
      style={[theme.typography[variant], { color: theme.colors[color], textAlign: align }, style]}
    />
  );
}
