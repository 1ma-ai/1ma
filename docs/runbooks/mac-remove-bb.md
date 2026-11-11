# Удаление bb с Mac (инструкция для Codex)

Mac владельца работает на 1ma с 08.11.2026, bb больше не нужен. 1ma сам ничего
не берёт из `~/.bb` (запрос к базе 1ma, 09.11.2026), но там остались
собственные службы владельца. Инструкцию выполняет Codex владельца на Mac;
Claude на Linux к Mac не подключается и подробностей окружения Mac не
получает.

```text
Задача: удалить с этого Mac приложение bb и его данные. Владелец полностью перешёл на 1ma (данные 1ma в ~/.1ma, приложение /Applications/1ma.app). Перед удалением перенести из папки bb (~/.bb) то, что ещё работает оттуда: почту Mail0, файлы службы туннеля, а мост выкладок переключить на командную строку 1ma. Удалять мягко: сначала всё переименовать и несколько дней проверять, удалять насовсем только по слову владельца (шаг 8).

Правила:
- Команды выполнять вне песочницы Codex.
- Не трогать ~/.1ma, /Applications/1ma.app, ~/Library/Application Support/1ma и всё с ai.1ma.desktop в названии.
- Перед изменением любого файла сохранить его копию в ~/remove-bb-backup (mkdir -p ~/remove-bb-backup), не рядом с файлом: копия .plist в ~/Library/LaunchAgents может запуститься как служба.
- Ничего не удалять до шага 8. Не использовать kill -9.
- Не менять адреса, порты, ключи и другие сетевые настройки туннеля и не включать их в отчёт.
- bb не запускать. Если что-то не совпадает с описанием — остановиться и сообщить владельцу.

Шаг 0. Исходное состояние:
pgrep -lf "/bb.app/"                       → пусто (bb не работает)
~/.1ma/bin/bb thread list                  → работает
Записать для сравнения в конце: открывается ли почта Mail0 (http://localhost:14030/mail/unified?group=main), открывается ли Linux-сервер в 1ma (меню Server), и последние запуски автоматизаций в 1ma (Automations).

Шаг 1. Найти всё, что ещё смотрит в ~/.bb (только чтение):
grep -rlF "/.bb" ~/Library/LaunchAgents 2>/dev/null
grep -rIlF --exclude-dir=node_modules --exclude-dir=.git -e "$HOME/.bb" -e "~/.bb" ~/.1ma/plugins/automations/scripts ~/.codex ~/.config ~/.local 2>/dev/null
grep -n -E "\.bb/|bb\.app" ~/.zshrc ~/.zprofile ~/.bash_profile ~/.profile 2>/dev/null
Ожидается: ai.msg8.bb-mail.plist (Mail0), app.remote-claude.bb-tunnel.plist (туннель) и конфиг моста выкладок «GitHub → ответы Claude» (mac.json, рядом с папкой state-mac). Если найдётся что-то ещё — сообщить владельцу и не продолжать.

Шаг 2. Мост выкладок. Владелец разрешил этот шаг, поручив удалить bb. Найти конфиг: find ~ -name mac.json -path "*handoff*" -not -path "*/node_modules/*" 2>/dev/null. В нём посмотреть bb_binary. Если путь ведёт в ~/.bb (обычно ~/.bb/bin/bb), заменить его на тот же путь в ~/.1ma (~/.1ma/bin/bb), больше ничего не меняя; копию — в ~/remove-bb-backup. Дождаться следующего запуска автоматизации моста в 1ma (раз в 5 минут) и проверить: ~/.1ma/bin/bb automation runs <id> --project <id проекта> --limit 1 → succeeded или skipped.

Шаг 3. Служба туннеля app.remote-claude.bb-tunnel. Посмотреть в её plist, что она берёт из ~/.bb:
- журнал или скрипт — перенести файл в ~/Library/Application Support/remote-claude (журнал — в ~/Library/Logs/remote-claude) и поправить путь в plist;
- команду bb (~/.bb/bin/bb) — заменить на ~/.1ma/bin/bb.
Сетевые настройки, адреса, порты и ключи не менять. Перезапустить службу:
launchctl bootout gui/$(id -u)/app.remote-claude.bb-tunnel
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/app.remote-claude.bb-tunnel.plist
Проверить, что то, для чего служит туннель, работает как в шаге 0.

Шаг 4. Почта Mail0 переезжает из ~/.bb/mail0 в ~/mail0.
4.1. Только чтение. ~/mail0 не должно существовать. Найти ссылки на старый путь вне данных почты:
grep -rIlF --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=postgres -e "$HOME/.bb/mail0" -e ".bb/mail0" ~/.bb/mail0 ~/Library/LaunchAgents 2>/dev/null
find ~/.bb/mail0 -maxdepth 5 -name pyvenv.cfg -not -path "*/node_modules/*"
ls -A ~/.bb/mail0/mail0-local/runtime/postgres/pg_tblspc
grep -n -E "^(data_directory|hba_file|ident_file|external_pid_file)" ~/.bb/mail0/mail0-local/runtime/postgres/postgresql.conf
Последние три команды должны ничего не вывести. Если нашлось виртуальное окружение Python, табличное пространство или абсолютный путь в postgresql.conf — остановиться и сообщить владельцу.
4.2. Остановить службу и дождаться полной остановки:
launchctl bootout gui/$(id -u)/ai.msg8.bb-mail
ps -A -ww -o pid,command | grep -F ".bb/mail0" | grep -v grep      → пусто (подождать до минуты)
/opt/homebrew/opt/postgresql@14/bin/pg_ctl -D ~/.bb/mail0/mail0-local/runtime/postgres status   → no server running
4.3. Перенести (переименование на том же диске, данные не копируются):
mv ~/.bb/mail0 ~/mail0
4.4. В каждом файле из 4.1 (после переноса файлы из ~/.bb/mail0 лежат в ~/mail0) заменить /Users/<имя>/.bb/mail0 на /Users/<имя>/mail0 (копии — в ~/remove-bb-backup). Файлы с секретами (.env и подобные) на экран не выводить.
4.5. Запустить и проверить:
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.msg8.bb-mail.plist
ps -A -ww -o pid,command | grep -F "/mail0/" | grep -v grep          → postgres работает с ~/mail0/mail0-local/runtime/postgres
В браузере http://localhost:14030/mail/unified?group=main — прежние аккаунты и письма.
Откат шага 4: остановить службу, mv ~/mail0 ~/.bb/mail0, вернуть файлы из ~/remove-bb-backup, запустить службу.

Шаг 5. Повторить поиск шага 1. Ожидается: ничего (копии в ~/remove-bb-backup не считаются).

Шаг 6. Мягкое удаление bb:
- если bb есть в Системных настройках → Основные → Объекты входа, убрать его; 1ma можно добавить туда, чтобы он запускался вместе с Mac;
- mv ~/.bb ~/.bb.parked-$(date +%Y%m%d)
- приложение bb переместить в Корзину (Finder → «Переместить в Корзину»), Корзину не очищать;
- если существуют, перенести в ~/remove-bb-backup/library: ~/Library/Application Support/bb, ~/Library/Caches/dev.bb.desktop, ~/Library/Caches/bb-updater, ~/Library/Preferences/dev.bb.desktop.plist, ~/Library/Saved Application State/dev.bb.desktop.savedState, ~/Library/HTTPStorages/dev.bb.desktop.

Шаг 7. Проверить сразу: 1ma на This Mac работает (треды открываются, новый тред отвечает), Linux-сервер в меню Server открывается, почта Mail0 открывается, туннель работает, в 1ma → Automations новые запуски моста выкладок и ежедневных обновлений успешные. Если что-то сломалось — вернуть: mv ~/.bb.parked-<дата> ~/.bb, приложение bb из Корзины в /Applications, папки из ~/remove-bb-backup/library на место — и сообщить владельцу.

Отчёт владельцу (без адресов, ключей и сетевых настроек): что нашлось в шаге 1, что изменено в шагах 2–4, результаты шагов 5 и 7.

Шаг 8. Только когда владелец скажет, что за несколько дней всё работало: удалить ~/.bb.parked-<дата> и ~/remove-bb-backup, очистить приложение bb из Корзины. По желанию: в «Связке ключей» удалить запись «bb Safe Storage» (не «1ma Safe Storage»).
```

Пути PostgreSQL взяты из отчёта Codex о переезде (Homebrew `postgresql@14`,
данные в `mail0-local/runtime/postgres`); если на Mac они другие, Codex
останавливается на шаге 4.1.
