# 1ma Brand

Плагин заменяет бренд bb на 1ma внутри окна: заголовок, favicon, иконку
приложения в PWA-манифесте и apple-touch-icon, логотип. Решение и границы описаны в
`docs/adr/0003-branding-as-plugin.md`.

## Файлы

- `brand.ts` — константы бренда, DOM-признаки bb, на которые опирается плагин,
  и чистые функции (заголовок, распознавание логотипа, манифест).
- `rebrand.ts` — content script: наблюдатели и замены в документе.
- `server.ts` — HTTP-маршруты с ассетами и манифестом.
- `assets/` — человечек в векторе, логотип «1ma», favicon, иконки приложения. Все файлы собирает
  `scripts/brand/make-icons.py` из оригиналов в `brand/source/`; руками их
  не правят (см. `brand/README.md`).

## Разработка

```sh
pnpm --filter bb-plugin-1ma-brand run test
pnpm --filter bb-plugin-1ma-brand run build
bb plugin install ./plugins/1ma-brand
```

## История

0.3.1 (01.11.2026): заголовок окна отслеживается только в `<head>`, а не на всей
странице, где каждый токен ответа агента запускал проверку.
