# Home Dashboard

Компактная доска задач под композером на домашнем экране bb. Три полосы:
Needs you, Running, Done. Логика раскладки по полосам — в `grouping.ts`,
тесты — в `grouping.test.ts`. Требует включённый плагин Focus Board на том же
сервере bb (отметки «сделано» берутся из его RPC `done_list`).

## Разработка

```sh
pnpm install            # из корня репозитория
pnpm --filter 1ma-home-dashboard run test
pnpm --filter 1ma-home-dashboard run typecheck
pnpm --filter 1ma-home-dashboard run build    # bb plugin build → dist/
```

Установка на сервер bb из этого каталога: `bb plugin install .`; после правок
`bb plugin reload 1ma-home-dashboard`.

## История

Плагин написан владельцем 1ma для своей работы в bb (октябрь 2026) и перенесён
в монорепо 1ma без изменений поведения. Переименован в `1ma-home-dashboard` при ребрендинге 30.10.2026.
