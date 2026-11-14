# 1ma Superagent

Серверный плагин 1ma: запись работ по чатам и PR на двух серверах 1ma и
действия Главного бота. Устройство и причины — в
[ADR-0006](../../docs/adr/0006-superagent.md), проект этапа 1 — в
[docs/plan/2026-11-14-superagent-stage-1.md](../../docs/plan/2026-11-14-superagent-stage-1.md).

## Как работает

- Роль `control` (сервер Mac): проход раз в минуту (`* * * * *`), сразу после
  загрузки плагина и после событий местных чатов (`thread.idle`,
  `thread.failed`, `thread.created`, `thread.archived`, `thread.unarchived`,
  `thread.deleted`, `interaction.pending`). Поводы, пришедшие во время
  прохода, объединяются в один следующий проход с сохранением области.
- Каждый исполнитель (свой сервер, другой сервер по HTTP) отдаёт снимок с
  полнотой: `complete`, `partial` или `failed`. Чат, пропавший из полного
  списка, получает состояние `closed`; из неполного — остаётся как был.
- Работа — верхнеуровневый видимый чат владельца, созданный не плагином и не
  являющийся чатом Главного бота.
- Роль `executor` (сервер Linux): проходов нет.

## RPC на чтение

- `work.v1.list({ limit?, offset?, includeClosed? })` — работы, новые первыми,
  и состояние серверов.
- `work.v1.get({ workId })` — одна работа и её сервер; неизвестный id —
  отказ `not_found`.
- `work.v1.waiting(null)` — работы, которые ждут владельца.

## Разработка

```sh
pnpm --filter bb-plugin-1ma-superagent test
pnpm --filter bb-plugin-1ma-superagent typecheck
pnpm --filter bb-plugin-1ma-superagent build
```
