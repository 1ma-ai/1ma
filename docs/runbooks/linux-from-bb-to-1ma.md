# Переключение Linux-сервера с bb на 1ma (инструкция для Codex)

Сервер bb на Linux-машине владельца запускает хост внутри контейнера; изнутри
треда его перезапускать нельзя: тред умрёт вместе с сервером. Поэтому
переключение делает Codex владельца по SSH. Делать после переезда Mac, когда
на Linux-сервере не работает ни один агент. Значения подставлены для
выпуска desktop/v0.49.0-1ma.42358180199.

```text
Задача: на Linux-машине владельца («Linux — Warsaw») заменить сервер bb на сервер 1ma с переносом данных. 1ma — это bb под другим брендом (та же программа, данные в /home/dev/.1ma вместо /home/dev/.bb). Сервер 1ma уже установлен в /home/dev/.local/opt/1ma-linux. bb не удалять: он остаётся запасным вариантом.

Как сейчас запускается bb: внутри контейнера пользователем dev командой
runuser -u dev -- /usr/bin/env PATH=/home/dev/.local/opt/node24/bin:/home/dev/.local/bin:/home/dev/.local/opt/claude-cli/node_modules/.bin:/usr/local/bin:/usr/bin:/bin BB_TELEMETRY=false CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 BB_CLAUDE_CODE_EXECUTABLE=/home/dev/.local/bin/claude /home/dev/.local/opt/bb-linux/node_modules/.bin/bb-app --server-bind-host 0.0.0.0 --server-port 38886 --no-in-app-updates
Этот процесс запускается снаружи контейнера (с хоста), а не из скриптов контейнера.

Правила, которые нельзя нарушать:
- Ничего не удалять. /home/dev/.bb только читать.
- Не держать bb и 1ma запущенными одновременно.
- Файл экспорта содержит секреты и не зашифрован: держать в /home/dev/1ma-migration, никуда не отправлять.
- Не менять сетевые настройки хоста, проброс портов, VPN, SSH и файрвол: 1ma слушает тот же порт 38886 с тем же адресом 0.0.0.0 внутри контейнера, всё остальное остаётся как было.
- Если что-то не совпадает с описанием — остановиться и прислать вывод владельцу.

Шаг 0. Найти на хосте, что запускает эту команду (юнит systemd, таймер, скрипт, конфигурация контейнера: например systemctl list-units --all, grep -rl bb-linux в /etc/systemd и в домашних каталогах, podman/docker inspect). Прислать владельцу, что найдено, и только потом продолжать. Дальше «запуск сервера» — это найденный механизм.

Шаг 1. В контейнере пользователем dev проверить, что агенты не работают:
env -i HOME=/home/dev PATH=/home/dev/.local/opt/node24/bin:/usr/bin:/bin /home/dev/.bb/bin/bb thread list
Ни одного треда в состоянии running. Если есть — дождаться или спросить владельца.

Шаг 2. Проверить установленный сервер 1ma:
cat /home/dev/.local/opt/1ma-linux/1ma-server.sha256
sha256sum /home/dev/.local/opt/1ma-linux/1ma-server-0.49.0-42358180199.tgz
grep '"version"' /home/dev/.local/opt/1ma-linux/node_modules/bb-app/package.json
Суммы совпадают и равны 367b9de09efc60fe1685964c318042e5eb4b779326f92f211dda5881ed520ff6, версия 0.49.0.

Шаг 3. Скрипт переноса из проверенного коммита и экспорт (bb работает):
mkdir -p /home/dev/1ma-migration
git -C /home/dev/Desktop/1ma fetch -q origin main
git -C /home/dev/Desktop/1ma show f4b45aa7b9bae32466e0a341371f6ef51f7c9518:desktop/scripts/migrate-from-bb.mjs > /home/dev/1ma-migration/migrate-from-bb.mjs
sha256sum /home/dev/1ma-migration/migrate-from-bb.mjs        → 1637bca97e35a1c5b76d67c0663c8fb507b16bc1ff01abd97e206d18e0b467fe
env -i HOME=/home/dev PATH=/home/dev/.local/opt/node24/bin:/usr/bin:/bin node /home/dev/1ma-migration/migrate-from-bb.mjs export --out /home/dev/1ma-migration/bb-server.tar
Должно закончиться строкой «exported the bb server to …». Сразу переходить к шагу 4: всё, что сделано в bb после экспорта, в 1ma не попадёт.

Шаг 4. Остановить bb механизмом запуска сервера (и сделать так, чтобы хост не запустил его снова сам). Проверить в контейнере:
curl -s -m 3 http://127.0.0.1:38886/ >/dev/null && echo "still answering"
Команда ничего не выводит. Скрипт переноса сам откажется работать, пока работает сервер bb, его демон или его плагины.

Шаг 5. Перенос, сначала пробный прогон, потом настоящий:
env -i HOME=/home/dev PATH=/home/dev/.local/opt/node24/bin:/usr/bin:/bin node /home/dev/1ma-migration/migrate-from-bb.mjs import --archive /home/dev/1ma-migration/bb-server.tar --cli /home/dev/.local/opt/1ma-linux/node_modules/bb-app/dist/bb.js --move-aside --dry-run
(проверить вывод: bb data /home/dev/.bb, 1ma data /home/dev/.1ma. Папки /home/dev/.1ma сейчас нет: прежний тестовый экземпляр удалён 9 ноября 2026 года. Если она появилась, скрипт отложит её в сторону.)
та же команда без --dry-run. Должно закончиться строками «imported …» и «next: start 1ma». Если скрипт отказывает (запущенные процессы, экспорт старше работы в bb, ошибка импорта) — прислать вывод; при ошибке он сам возвращает отложенную папку на место.

Шаг 6. Запустить 1ma той же командой и тем же механизмом, заменив только путь
/home/dev/.local/opt/bb-linux/node_modules/.bin/bb-app на /home/dev/.local/opt/1ma-linux/node_modules/.bin/bb-app.
Все переменные окружения и флаги оставить как были, в том числе --no-in-app-updates: без него встроенное обновление поставит bb из npm вместо 1ma. Сделать так, чтобы хост запускал именно эту команду и после перезагрузки.

Шаг 7. Проверить в контейнере:
curl -s http://127.0.0.1:38886/ | grep -o '<title>[^<]*'        → <title>1ma
cat /home/dev/.1ma/bb-app-runtime.json                           → version 0.49.0
env -i HOME=/home/dev PATH=/home/dev/.local/opt/node24/bin:/usr/bin:/bin /home/dev/.1ma/bin/bb machine list    → одна машина, server, connected, с тем же id, что в /home/dev/.bb/host-id
env -i HOME=/home/dev PATH=/home/dev/.local/opt/node24/bin:/usr/bin:/bin /home/dev/.1ma/bin/bb thread list     → те же треды
env -i HOME=/home/dev PATH=/home/dev/.local/opt/node24/bin:/usr/bin:/bin /home/dev/.1ma/bin/bb plugin list     → плагины 1ma running, ни одного в error (плагин, установленный из рабочей папки треда, надо поставить заново из его папки)
env -i HOME=/home/dev PATH=/home/dev/.local/opt/node24/bin:/usr/bin:/bin /home/dev/.1ma/bin/bb automation list --project proj_personal     → есть «Daily updates: Claude Code, Codex» (переехала из bb, ежедневно в 04:30 обновляет Claude Code)
И с Mac: в 1ma открыть Linux-сервер (меню Server) — интерфейс 1ma, треды на месте.

Шаг 8. Отчёт владельцу: что нашлось в шаге 0 и что изменено, вывод шагов 2, 3, 5, 7. Экспорт не удалять до подтверждения владельца.

Папку /home/dev/.bb не удалять и после переезда: 1ma продолжает работать в её рабочих папках (рабочие деревья git, проекты, которые bb клонировал).

Откат: остановить 1ma, вернуть в механизме запуска прежний путь /home/dev/.local/opt/bb-linux/node_modules/.bin/bb-app и запустить bb — его база такая, какой была при экспорте.
```
