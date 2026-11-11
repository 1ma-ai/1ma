# Расход Claude на Linux-сервере 1ma (инструкция для Codex)

С `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` Claude Code работает в режиме
«только необходимый трафик» и не запрашивает у Anthropic расход подписки, а
отдаёт то, что лежит в кэше `~/.claude.json`, если там что-то есть. 1ma
читает расход у Claude Code, поэтому цифры устаревали, а после сброса
пятичасового окна пропадали совсем. Переменные `DISABLE_TELEMETRY`,
`DISABLE_ERROR_REPORTING`, `DISABLE_AUTOUPDATER` и `DISABLE_BUG_COMMAND`
выключают то же, что и она (телеметрию, отчёты об ошибках, автообновление,
`/bug`), но расход читать не мешают. В `~/.claude/settings.json` Claude
заменил переменную 11.11.2026 (копия:
`~/.claude/settings.json.bak-20261111-nonessential`); осталось убрать её из
команды запуска сервера: процессы Claude Code получают окружение сервера.

```text
Задача: на Linux-машине владельца («Linux — Warsaw») убрать из команды запуска сервера 1ma переменную CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 и поставить вместо неё DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1 DISABLE_AUTOUPDATER=1 DISABLE_BUG_COMMAND=1. Механизм запуска на хосте тот же, что ты настраивал 10.11 и 11.11.2026.

Как сервер запускается сейчас (внутри контейнера, пользователем dev):
runuser -u dev -- /usr/bin/env PATH=/home/dev/.local/opt/node24/bin:/home/dev/.local/bin:/home/dev/.local/opt/claude-cli/node_modules/.bin:/usr/local/bin:/usr/bin:/bin BB_TELEMETRY=false CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 BB_CLAUDE_CODE_EXECUTABLE=/home/dev/.local/bin/claude ONEMA_UPDATE_COMMAND_PREFIX=/home/dev/.local/bin/1ma-update-heavy /home/dev/.local/opt/1ma-server/node_modules/.bin/bb-app --server-bind-host 0.0.0.0 --server-port 38886

Правила:
- Ничего не удалять. Не трогать /home/dev/.1ma, ~/.claude, сетевые настройки хоста, проброс портов, VPN, SSH и файрвол.
- Если что-то не совпадает с описанием — остановиться и прислать вывод владельцу.

Дальше BB = env -i HOME=/home/dev PATH=/home/dev/.local/opt/node24/bin:/usr/bin:/bin /home/dev/.1ma/bin/bb (в контейнере, пользователем dev).

Шаг 1. $BB thread list → ни одного треда в состоянии running, в том числе тред владельца с Claude: перезапуск его прервёт, потом он продолжится. Если есть — дождаться или спросить владельца.

Шаг 2. Остановить сервер механизмом запуска. Проверить в контейнере:
curl -s -m 3 http://127.0.0.1:38886/ >/dev/null && echo "still answering"
Команда ничего не выводит.

Шаг 3. В механизме запуска заменить команду на эту (вместо CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 четыре переменные DISABLE_*, остальное как было):
runuser -u dev -- /usr/bin/env PATH=/home/dev/.local/opt/node24/bin:/home/dev/.local/bin:/home/dev/.local/opt/claude-cli/node_modules/.bin:/usr/local/bin:/usr/bin:/bin BB_TELEMETRY=false DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1 DISABLE_AUTOUPDATER=1 DISABLE_BUG_COMMAND=1 BB_CLAUDE_CODE_EXECUTABLE=/home/dev/.local/bin/claude ONEMA_UPDATE_COMMAND_PREFIX=/home/dev/.local/bin/1ma-update-heavy /home/dev/.local/opt/1ma-server/node_modules/.bin/bb-app --server-bind-host 0.0.0.0 --server-port 38886
Сделать так, чтобы хост запускал именно её и после перезагрузки. Запустить сервер.

Шаг 4. Проверить в контейнере:
curl -s http://127.0.0.1:38886/ | grep -o '<title>[^<]*'          → <title>1ma
cat /home/dev/.1ma/bb-app-runtime.json                             → version 0.49.1-1ma.42991224835.1 или новее
pid=$(pgrep -f "bb-app/server/dist/index.js" | head -1); tr '\0' '\n' < /proc/$pid/environ | grep -E '^(CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC|DISABLE_TELEMETRY)='
                                                                   → только DISABLE_TELEMETRY=1
$BB settings usage --refresh --json | grep -m1 '"status"'          → "status": "ok"
$BB updates app auto                                               → «Automatic updates are on: …»
$BB plugin list, $BB automation list --project proj_personal и --project proj_niq2bmwd4w → как до перезапуска, ни одного плагина в error

Шаг 5. Отчёт владельцу: что изменено в механизме запуска, вывод шага 4.

Откат: остановить сервер, вернуть прежнюю команду (CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 вместо четырёх DISABLE_*) и запустить.
```
