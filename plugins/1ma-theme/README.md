# 1ma Theme

Тема 1ma для bb: `themes/1ma.css` задаёт якоря палитры, акцент, уровни текста,
семантические цвета, радиус, шрифты и палитру терминала для светлого и
тёмного режимов. Сейчас значения совпадают с темой bb по умолчанию
(см. `UPSTREAM.md`), дальше здесь появляются правки дизайна 1ma.

## Включить

```sh
bb plugin install ./plugins/1ma-theme     # из корня репозитория, или через маркетплейс 1ma
bb theme set plugin:1ma-theme:1ma
```

Или Settings → Appearance → палитра «1ma».

## Разработка

```sh
pnpm --filter bb-plugin-1ma-theme run test       # проверяет полноту токенов
pnpm --filter bb-plugin-1ma-theme run build      # bb plugin build
bb plugin reload 1ma-theme                        # после правок CSS
```
