# Самообновление сервера 1ma на Linux (инструкция для Codex)

Выполнено 11.11.2026. Команда запуска с тех пор меняется по
`linux-claude-usage.md`: без `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, иначе
1ma не видит расход подписки Claude.

Сервер 1ma на Linux-машине владельца с 10.11.2026 запускается с
`--no-in-app-updates`: встроенное обновление сборки 0.49.0 ставило бы bb из
npm. Начиная с 0.49.1-1ma.* сервер обновляется из выпусков 1ma (правка 0009),
поэтому флаг убирается. Установку обновления (`npm install`) сервер запускает
через `/home/dev/.local/bin/1ma-update-heavy`, то есть в очереди тяжёлых
задач машины. Новую сборку Claude уже поставил в `/home/dev/.local/opt/1ma-server`;
Codex меняет команду запуска на хосте, как при переходе на 1ma. Значения
подставлены для выпуска desktop/v0.49.1-1ma.42981429168.1.

```text
Задача: на Linux-машине владельца («Linux — Warsaw») включить самообновление сервера 1ma: запускать его из новой сборки /home/dev/.local/opt/1ma-server без флага --no-in-app-updates и с переменной ONEMA_UPDATE_COMMAND_PREFIX. Механизм запуска на хосте тот же, что ты настроил при переходе на 1ma 10.11.2026.

Как сервер запускается сейчас (внутри контейнера, пользователем dev):
runuser -u dev -- /usr/bin/env PATH=/home/dev/.local/opt/node24/bin:/home/dev/.local/bin:/home/dev/.local/opt/claude-cli/node_modules/.bin:/usr/local/bin:/usr/bin:/bin BB_TELEMETRY=false CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 BB_CLAUDE_CODE_EXECUTABLE=/home/dev/.local/bin/claude /home/dev/.local/opt/1ma-linux/node_modules/.bin/bb-app --server-bind-host 0.0.0.0 --server-port 38886 --no-in-app-updates

Правила:
- Ничего не удалять: /home/dev/.local/opt/1ma-linux остаётся для отката.
- Не трогать /home/dev/.1ma и сетевые настройки хоста, проброс портов, VPN, SSH и файрвол.
- Если что-то не совпадает с описанием — остановиться и прислать вывод владельцу.

Шаг 1. В контейнере пользователем dev:
env -i HOME=/home/dev PATH=/home/dev/.local/opt/node24/bin:/usr/bin:/bin /home/dev/.1ma/bin/bb thread list
Ни одного треда в состоянии running, в том числе тред владельца с Claude: перезапуск его прервёт, потом он продолжится. Если есть — дождаться или спросить владельца.

Шаг 2. Проверить новую сборку и обёртку:
cat /home/dev/.local/opt/1ma-server/1ma-server.sha256
sha256sum /home/dev/.local/opt/1ma-server/1ma-server-0.49.1-1ma.42981429168.1.tgz
grep '"version"' /home/dev/.local/opt/1ma-server/node_modules/bb-app/package.json
cat /home/dev/.local/bin/1ma-update-heavy
Суммы совпадают и равны 5e9aed1ec7a82a4fe28ed081d5e3271fbcfcdca8114868304bf7a5be74e207f1, версия 0.49.1-1ma.42981429168.1; обёртка запускает /home/dev/.claude/bin/heavy --wait 300 "$@".

Шаг 3. Остановить сервер механизмом запуска. Проверить в контейнере:
curl -s -m 3 http://127.0.0.1:38886/ >/dev/null && echo "still answering"
Команда ничего не выводит.

Шаг 4. В механизме запуска заменить команду на эту (другой путь, без --no-in-app-updates, с ONEMA_UPDATE_COMMAND_PREFIX; остальное как было):
runuser -u dev -- /usr/bin/env PATH=/home/dev/.local/opt/node24/bin:/home/dev/.local/bin:/home/dev/.local/opt/claude-cli/node_modules/.bin:/usr/local/bin:/usr/bin:/bin BB_TELEMETRY=false CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 BB_CLAUDE_CODE_EXECUTABLE=/home/dev/.local/bin/claude ONEMA_UPDATE_COMMAND_PREFIX=/home/dev/.local/bin/1ma-update-heavy /home/dev/.local/opt/1ma-server/node_modules/.bin/bb-app --server-bind-host 0.0.0.0 --server-port 38886
Сделать так, чтобы хост запускал именно её и после перезагрузки. Запустить сервер.

Шаг 5. Проверить в контейнере (дальше BB = env -i HOME=/home/dev PATH=/home/dev/.local/opt/node24/bin:/usr/bin:/bin /home/dev/.1ma/bin/bb):
curl -s http://127.0.0.1:38886/ | grep -o '<title>[^<]*'        → <title>1ma
cat /home/dev/.1ma/bb-app-runtime.json                           → version 0.49.1-1ma.42981429168.1, entryPath в /home/dev/.local/opt/1ma-server
$BB updates app status                                           → версия 0.49.1-1ma.42981429168.1, нет строки «In-app updates are off»
$BB thread list, $BB plugin list, $BB automation list --project proj_personal и --project proj_niq2bmwd4w → как до перезапуска, ни одного плагина в error
Включить автоматическую установку обновлений:
$BB settings experiment updateWhenIdle true
$BB updates app auto on                                          → «Automatic updates are on: …»

Шаг 6. Отчёт владельцу: что изменено в механизме запуска, вывод шагов 2 и 5.

Откат: остановить сервер, вернуть прежнюю команду (путь /home/dev/.local/opt/1ma-linux/node_modules/.bin/bb-app и флаг --no-in-app-updates, без ONEMA_UPDATE_COMMAND_PREFIX) и запустить.
```

Дальше сервер раз в час смотрит `server-version.json` в выпуске
`desktop-latest` и, когда 15 минут не работал ни один тред, ставит новую
сборку в `/home/dev/.1ma/app-versions` и перезапускается в неё; прежняя
остаётся на диске.

## Откат на версию до встроенных плагинов 1ma

Начиная с версии с правками 14–15 плагины 1ma встроены в приложение. Версия
до правки 14 при запуске стирает их строки вместе с настройками, сборщик
мусора bb через неделю удаляет прежние клоны из git, а папка выкладки на Linux
уходит на следующие коммиты. Поэтому перед первой записью встроенного плагина
1ma один раз сохраняет состояние всех четырёх плагинов 1ma в
`~/.1ma/backups/before-1ma-builtins/` (на Linux — `/home/dev/.1ma/backups/…`):
какие стояли и как (записи, копии клонов и папок выкладки с контрольными
суммами), каких не было, и на крайний случай копию всей базы `bb.db`. Папка не
перезаписывается; после успешного отката она переименовывается в
`before-1ma-builtins.restored-<время>`, и следующий переход сохранит новое
состояние. Срока у отката нет.

Откат — в таком порядке, пока старая версия ни разу не запускалась на этих
данных:

1. Остановить 1ma (на Mac Cmd+Q; на Linux службу) и убедиться, что процессов
   `bb-app` не осталось.
2. Командой новой версии вернуть плагины 1ma к прежней установке. Остальное
   (треды, проекты, настройки) не меняется, настройки и секреты плагинов
   тоже остаются.
   - Mac (до установки старой версии):
     `ELECTRON_RUN_AS_NODE=1 /Applications/1ma.app/Contents/MacOS/1ma /Applications/1ma.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/server/dist/one-ma-rollback.js --data-dir ~/.1ma`
   - Linux: `node <папка новой версии>/node_modules/bb-app/server/dist/one-ma-rollback.js --data-dir /home/dev/.1ma`
     (папка — та, из которой запущен сервер, например в
     `/home/dev/.1ma/app-versions/`).
     Команда отказывается, пока 1ma запущен, и ничего не меняет, если
     сохранённые файлы повреждены. Она печатает, какие плагины вернулись, и
     «done». Плагин, которого до перехода не было (например, Server Switcher),
     убирается, его настройки и данные остаются. Плагин из папки выкладки
     возвращается из сохранённой копии в `~/.1ma/plugins/1ma-rollback/<id>`;
     на Linux следующая выкладка старой версии снова поставит его из папки
     выкладки.
3. Поставить прежнюю версию и запустить.

Если старая версия уже успела запуститься до шага 2, команда откажется и
назовёт копию базы: тогда (1ma остановлен) переложить текущий `bb.db` и файлы
`bb.db-wal`, `bb.db-shm` в сторону и положить на место `bb.db` копию из
`before-1ma-builtins/`. Изменения после первого запуска новой версии (треды,
сообщения, настройки) при этом пропадают — только на крайний случай, решение
владельца.

Порядок «новая → старая → новая» с удалением клонов проверяет
`desktop/scripts/check-rollback.mjs` в каждой сборке Desktop.
