# 1ma Brand

Плагин заменяет бренд bb на 1ma внутри окна: заголовок, favicon, PWA-манифест,
apple-touch-icon и логотип. Решение и границы описаны в
`docs/adr/0003-branding-as-plugin.md`.

## Файлы

- `brand.ts` — константы бренда, DOM-признаки bb, на которые опирается плагин,
  и чистые функции (заголовок, распознавание логотипа, манифест).
- `rebrand.ts` — content script: наблюдатели и замены в документе.
- `server.ts` — HTTP-маршруты с ассетами и манифестом.
- `assets/` — знак, слово, иконки. Исходники от владельца лежат в `brand/`
  в корне репозитория; PNG-варианты получены из них скриптом без потерь
  (инверсия для тёмной темы, уменьшение усреднением).

## Разработка

```sh
pnpm --filter bb-plugin-1ma-brand run test
pnpm --filter bb-plugin-1ma-brand run build
bb plugin install ./plugins/1ma-brand
```
