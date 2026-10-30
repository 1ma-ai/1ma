# Home Dashboard

Компактная доска задач под композером на домашнем экране bb. Три полосы:
Needs you, Running, Done. Логика раскладки по полосам — в `grouping.ts`,
тесты — в `grouping.test.ts`. Требует включённый плагин Focus Board на том же
сервере bb (отметки «сделано» берутся из его RPC `done_list`).

## Разработка

```sh
pnpm install            # из корня репозитория
pnpm --filter bb-home-dashboard run test
pnpm --filter bb-home-dashboard run typecheck
pnpm --filter bb-home-dashboard run build    # bb plugin build → dist/
```

Установка на сервер bb из этого каталога: `bb plugin install .`; после правок
`bb plugin reload bb-home-dashboard`.

## История

Плагин написан владельцем 1ma для своей работы в bb (октябрь 2026) и перенесён
в монорепо 1ma без изменений поведения. Id плагина сохранён
(`bb-home-dashboard`), чтобы не ломать установленные копии.
