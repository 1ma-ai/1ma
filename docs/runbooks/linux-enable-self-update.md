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
