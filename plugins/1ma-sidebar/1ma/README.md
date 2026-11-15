# Код 1ma в копии штатного списка чатов

Свой код 1ma лежит здесь; файлы bb в копии меняются только в точках
подключения ниже. При переносе нового выпуска bb (см. `../UPSTREAM.md`)
эти точки возвращаются отдельным коммитом.

## Что делает

- `BotsBlock.tsx` — блок «Bots» над проектами: заголовок группы bb
  (`TopLevelSidebarSection`), строка бота с лицом, ролью, значком
  состояния bb (`experimental_ThreadStatusGlyph`), числом чатов; дерево
  чатов бота строками bb (`ProjectThreadTree`); «Done: N»; «+» открывает
  штатный композер нового чата и создаёт чат через `bots.v1.startThread`
  плагина `1ma-bots`.
- `use-bots.ts` — одно решение для блока и для фильтра проектов: блок и
  вынос чатов бота включены, только если установлен `1ma-bots` (есть его
  пункт навигации), настройка «Show bots» включена и список ботов прочитан.
  Иначе список ровно штатный.
- `bot-threads.ts` — какие чаты уходят из проектов: чаты видимых ботов с
  потомками; чаты скрытого бота остаются в проектах.
- `server.ts` — настройка «Show bots» и однократный перенос настроек
  штатного списка (`thread-list` → `listPreferences`): при загрузке до
  переноса старых `sidebar.*`, иначе при первом чтении; уже сохранённые
  ключи не перезаписываются.
- `bots-rpc.ts` — часть контракта `bots.v1` плагина `1ma-bots`, которую
  читает панель.

## Точки подключения в файлах bb

| Файл                                                         | Правка                                                                                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `package.json`                                               | имя `bb-plugin-1ma-sidebar`, описание, `engines`                                                                               |
| `app.tsx`                                                    | заголовок слота «1ma Sidebar»                                                                                                  |
| `server.ts`                                                  | `register1maSidebar(bb, { write, stored })`; `copyBuiltInPreferences()` перед `migrateFromUiPreferences` и в `listPreferences` |
| `app/model/use-sidebar-data.ts`                              | `useWithoutBotThreads(...)` вокруг `experimental_useSidebarThreads`                                                            |
| `app/list/ProjectList.tsx`                                   | `<BotsBlock … />` после `<SidebarDraftPresenceSync />`                                                                         |
| `shared/preferences.ts`, `app/rows/ThreadRow.tsx` и их тесты | ключи `1ma-sidebar/move`, `1ma-sidebar/customizeRowActions`                                                                    |
| `skills/1ma-sidebar/SKILL.md`                                | имя навыка `1ma-sidebar`, команда `bb 1ma-sidebar`                                                                             |
| `vitest.config.ts`                                           | `maxWorkers: 2`, имя проекта                                                                                                   |
| `tsconfig.json`                                              | `1ma/**` в `include`                                                                                                           |
| `PLUGIN_OVERVIEW.md`                                         | описание плагина 1ma                                                                                                           |
