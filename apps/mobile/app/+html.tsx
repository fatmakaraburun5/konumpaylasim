/**
 * Yalnızca web: statik HTML iskeleti (Expo Router). Native uygulamayı etkilemez.
 * Harici font yok; sistem fontu kullanılır.
 */
import { ScrollViewStyleReset } from 'expo-router/html';
import type { PropsWithChildren } from 'react';

const bodyCss = `
html, body, #root { height: 100%; }
body { margin: 0; background-color: #F6F7F9; color: #0F172A;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  -webkit-font-smoothing: antialiased; overscroll-behavior: none; }
@media (prefers-color-scheme: dark) { body { background-color: #0B1220; color: #E5E7EB; } }
`;

export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="tr">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no, viewport-fit=cover" />
        <meta name="color-scheme" content="light dark" />
        <title>Konum · Web önizleme</title>
        <ScrollViewStyleReset />
        <style dangerouslySetInnerHTML={{ __html: bodyCss }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
