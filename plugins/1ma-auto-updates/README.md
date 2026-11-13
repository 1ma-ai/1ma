# 1ma Auto Updates

Серверный плагин 1ma: ставит обновления CLI провайдеров (Codex, Claude Code и
других, которыми управляет bb) и обновления плагинов, только когда ни один тред
не работает. Заменяет автоматизации со скриптом `bb updates apply` на каждой
машине.

## Как работает

- Раз в 15 минут (`*/15 * * * *`) проверяет, что 15 минут не было ни хода, ни
  его завершения или сбоя (события `thread.active`, `thread.idle`,
  `thread.failed`), и что сейчас ни один тред не стартует и не работает, нет
  фоновых агентов и workflow. Список тредов, который не удалось прочитать,
  считается занятым. Фоновые команды (dev-серверы и подобное) не мешают: они
  не зависят от файлов CLI провайдера.
- Собирает работу: для каждой подключённой постоянной машины — провайдеры, у
  которых bb предлагает действие `update` (новые CLI не ставит), и плагины с
  `updateState.outcome === "update-available"` по последней проверке bb.
- Открывает окно обслуживания: хук `message.dispatch` отвечает `wait` всем
  новым сообщениям (с `sendAt` через 30 секунд). Через 5 секунд ещё раз
  проверяет треды; если что-то успело стартовать — закрывает окно и уходит.
- Ставит обновления по одному через `bb.sdk.hosts.installProviderCli` и
  `bb.sdk.plugins.applyUpdate` (себя — последним), сбой одного не мешает
  остальным. Закрывает окно и сразу просит core отправить придержанные
  сообщения (`experimental_hooks.recheck`).

## Настройки

- **Update provider CLIs** — по умолчанию включено.
- **Update plugins** — по умолчанию включено. На Linux-сервере владельца
  выключено: плагины туда выкладывает `scripts/release-linux.mjs`, а установка
  из git собирает их вне лимита heavy.

## Разработка

```sh
pnpm install            # из корня репозитория
pnpm --filter bb-plugin-1ma-auto-updates run typecheck
pnpm --filter bb-plugin-1ma-auto-updates run test
pnpm --filter bb-plugin-1ma-auto-updates run build   # bb plugin build → dist/
```

Логика (`auto-updates.ts`) проверяется с поддельными зависимостями, связка с
bb (`server.ts`) — на `createFakePluginHost` из `@get-bb/plugin-sdk/testing`.
