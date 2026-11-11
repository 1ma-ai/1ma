# Удаление bb с Mac (инструкция для Codex)

Mac владельца работает на 1ma с 08.11.2026, bb больше не нужен. 1ma сам ничего
не берёт из `~/.bb` (запрос к базе 1ma, 09.11.2026), но там остались
собственные службы владельца. Инструкцию выполняет Codex владельца на Mac;
Claude на Linux к Mac не подключается и подробностей окружения Mac не
получает. Инструкция прошла независимую проверку 11.11.2026.

```text
Задача: удалить с этого Mac приложение bb и его данные. Владелец полностью перешёл на 1ma (данные 1ma в ~/.1ma, приложение /Applications/1ma.app). Перед удалением перенести из папки bb (~/.bb) то, что ещё работает оттуда: почту Mail0, файлы службы туннеля, а мост выкладок переключить на командную строку 1ma. Удалять мягко: сначала всё отложить и несколько дней проверять, удалять насовсем только по слову владельца (шаг 8).

Правила:
- Команды выполнять вне песочницы Codex, в Терминале вошедшего пользователя (команды launchctl gui/… работают только в его сеансе).
- Не трогать ~/.1ma, /Applications/1ma.app, ~/Library/Application Support/1ma и всё с ai.1ma.desktop в названии.
- Резервные копии — только в ~/remove-bb-backup (mkdir -p ~/remove-bb-backup && chmod 700 ~/remove-bb-backup: там будут файлы с секретами). Копию файла сохранять с полным путём: ditto <файл> ~/remove-bb-backup/files<полный путь файла>. Не рядом с файлом: копия .plist в ~/Library/LaunchAgents может запуститься как служба.
- Ничего не удалять до шага 8. Не использовать kill и kill -9: службы останавливать только их штатными командами.
- Не менять адреса, порты, ключи и другие сетевые настройки туннеля. В отчёт не включать их, содержимое plist и вывод launchctl print, кроме строк state, pid и last exit code.
- bb не запускать. Если что-то не совпадает с описанием — остановиться и сообщить владельцу.

Шаг 0. Исходное состояние:
pgrep -lf "[/]bb.app/"                     → пусто (bb не работает)
~/.1ma/bin/bb thread list                  → работает
Записать для сравнения в конце:
- открывается ли почта Mail0 (http://localhost:14030/mail/unified?group=main) и видны ли прежние аккаунты и письма;
- открывается ли Linux-сервер в 1ma (меню Server);
- launchctl print gui/$(id -u)/app.remote-claude.bb-tunnel | grep -E "state =|pid =|last exit code" (и для чего служит туннель, если это видно владельцу);
- последние запуски автоматизаций в 1ma → Automations (мост выкладок «GitHub → ответы Claude» и ежедневные обновления).

Шаг 1. Найти всё, что ещё смотрит в bb (только чтение):
grep -rlF -e "/.bb" -e "bb.app" -e "dev.bb.desktop" ~/Library/LaunchAgents /Library/LaunchAgents /Library/LaunchDaemons 2>/dev/null
crontab -l 2>/dev/null | grep -nF ".bb"
grep -n -E "\.bb/|bb\.app" ~/.zshrc ~/.zprofile ~/.zshenv ~/.bash_profile ~/.profile 2>/dev/null
command -v bb; ls -l /usr/local/bin/bb /opt/homebrew/bin/bb 2>/dev/null
launchctl list | grep -i bb
grep -rIlF --exclude-dir=node_modules --exclude-dir=.git -e "$HOME/.bb" -e "~/.bb" ~/.1ma/plugins/automations/scripts ~/.codex/config.toml ~/.codex/prompts ~/.codex/skills ~/.config ~/.local 2>/dev/null | grep -v -E "/(logs?|history|sessions|[Cc]ache|tmp)/|\.log$"
Ожидается: ai.msg8.bb-mail.plist (Mail0), app.remote-claude.bb-tunnel.plist (туннель) и конфиг моста выкладок (mac.json, рядом с папкой state-mac). Строки launchctl list с этими двумя метками — тоже ожидаемы. Всё остальное — сообщить владельцу и не продолжать.

Шаг 2. Мост выкладок. Владелец разрешил этот шаг, поручив удалить bb. Найти конфиг: find ~ -name mac.json -path "*handoff*" -not -path "*/node_modules/*" 2>/dev/null. В нём посмотреть bb_binary. Если путь ведёт в ~/.bb (обычно ~/.bb/bin/bb), сохранить копию и заменить его на тот же путь в ~/.1ma (~/.1ma/bin/bb), больше ничего не меняя. Дождаться следующего запуска автоматизации моста в 1ma (раз в 5 минут): ~/.1ma/bin/bb automation runs <id> --project <id проекта> --limit 1 → succeeded или skipped, не failed.

Шаг 3. Служба туннеля app.remote-claude.bb-tunnel.
3.1. Посмотреть, что она берёт из ~/.bb: plutil -p ~/Library/LaunchAgents/app.remote-claude.bb-tunnel.plist | grep -n "\.bb" (вывод в отчёт не включать).
3.2. Сохранить копию plist и остановить службу: launchctl bootout gui/$(id -u)/app.remote-claude.bb-tunnel
3.3. Журнал или скрипт из ~/.bb — перенести файл в ~/Library/Application Support/remote-claude (журнал — в ~/Library/Logs/remote-claude) и поправить путь в plist; команду bb (~/.bb/bin/bb) — заменить на ~/.1ma/bin/bb. Если plist двоичный (file <plist> пишет «Apple binary property list»), сначала plutil -convert xml1 <plist>. Сетевые настройки, адреса, порты и ключи не менять.
3.4. Запустить: launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/app.remote-claude.bb-tunnel.plist. Проверить state, pid и last exit code и то, для чего служит туннель, — как в шаге 0.

Шаг 4. Почта Mail0 переезжает из ~/.bb/mail0 в ~/mail0. Дальше P = ~/.bb/mail0/mail0-local/runtime/postgres (после переноса — ~/mail0/mail0-local/runtime/postgres), PGCTL = /opt/homebrew/opt/postgresql@14/bin/pg_ctl.
4.1. Только чтение; любое отклонение — остановиться и сообщить владельцу:
test ! -e ~/mail0 && echo free                                          → free
[ "$(stat -f %d ~/.bb/mail0)" = "$(stat -f %d ~)" ] && echo same-volume  → same-volume
ls -ld ~/.bb ~/.bb/mail0                                                → обычные папки, не ссылки
test -x $PGCTL && cat $P/PG_VERSION                                     → 14
ls -A $P/pg_tblspc; find $P -maxdepth 1 -type l                         → пусто
grep -nF ".bb" $P/postgresql.conf $P/postgresql.auto.conf $P/pg_hba.conf $P/pg_ident.conf 2>/dev/null   → пусто
find ~/.bb/mail0 -maxdepth 5 -name pyvenv.cfg -not -path "*/node_modules/*"   → пусто
Файлы со ссылками на старый путь (вне данных почты и кэшей сборки):
grep -rlF --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=postgres --exclude-dir=.next --exclude-dir=.turbo -e ".bb/" ~/.bb/mail0 2>/dev/null
find ~/.bb/mail0 \( -path "*/node_modules/.bin/*" -o -name .modules.yaml \) -type f -exec grep -lF ".bb/" {} + 2>/dev/null
plutil -p ~/Library/LaunchAgents/ai.msg8.bb-mail.plist | grep -n "\.bb"
В каждом найденном файле все упоминания .bb/ должны быть путём к ~/.bb/mail0 (grep -oF ".bb/" и grep -oF ".bb/mail0" дают одинаковое число строк); если файл ссылается на что-то ещё в ~/.bb (например ~/.bb/bin) — остановиться. Ссылки на старое место:
find ~/.bb/mail0 -type l -lname "*/.bb/*" 2>/dev/null
Их запомнить: после переноса перенаправить на то же место в ~/mail0.
4.2. Остановить службу и дождаться полной остановки:
launchctl bootout gui/$(id -u)/ai.msg8.bb-mail
pgrep -f "[.]bb/mail0" >/dev/null && echo running                       → ничего (подождать до минуты)
$PGCTL -D $P status                                                     → no server running
Если PostgreSQL ещё работает: $PGCTL -D $P stop -m fast -w. Затем test ! -e $P/postmaster.pid && echo stopped → stopped. Если что-то из Mail0 всё равно работает — не убивать, сообщить владельцу.
4.3. Резервная копия всей папки (клон APFS, мгновенный): cp -cR ~/.bb/mail0 ~/remove-bb-backup/mail0-before-move
4.4. Перенос (переименование на том же диске): test ! -e ~/mail0 && mv ~/.bb/mail0 ~/mail0
4.5. В каждом файле из 4.1 (теперь он в ~/mail0) и в plist службы сохранить копию и заменить старый путь новым в том же виде; для каждой пары OLD → NEW:
OLD="/Users/<имя>/.bb/mail0" NEW="/Users/<имя>/mail0" perl -pi -e 's{\Q$ENV{OLD}\E}{$ENV{NEW}}g' <файл>
и так же для ~/.bb/mail0 → ~/mail0, $HOME/.bb/mail0 → $HOME/mail0, ${HOME}/.bb/mail0 → ${HOME}/mail0 (эти значения OLD и NEW — в одинарных кавычках, чтобы ~ и $HOME остались буквами). Двоичный plist сначала plutil -convert xml1. Кэши сборки (.next, .turbo, .wrangler/tmp, dist) не править: они пересобираются. Ссылки из 4.1 перенаправить: ln -sfn <новая цель в ~/mail0> <ссылка>. Файлы с секретами (.env и подобные) на экран не выводить.
4.6. Запустить и проверить:
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.msg8.bb-mail.plist
launchctl print gui/$(id -u)/ai.msg8.bb-mail | grep -E "state =|pid ="  → running
pgrep -f "[/]mail0/mail0-local/runtime/postgres" >/dev/null && echo postgres-running   → postgres-running
В журнале PostgreSQL (папка log или файл журнала в каталоге данных) последние строки: «database system is ready to accept connections», без «was not properly shut down».
В браузере http://localhost:14030/mail/unified?group=main — те же аккаунты и письма, что в шаге 0.
Откат шага 4: launchctl bootout gui/$(id -u)/ai.msg8.bb-mail, при необходимости $PGCTL -D ~/mail0/mail0-local/runtime/postgres stop -m fast -w, mv ~/mail0 ~/.bb/mail0, вернуть изменённые файлы из ~/remove-bb-backup/files, launchctl bootstrap … . Если пострадали данные — сообщить владельцу: полная копия лежит в ~/remove-bb-backup/mail0-before-move.

Шаг 5. Проверить, что ссылок не осталось:
повторить шаг 1                                                          → только ожидаемое из шага 1 минус то, что уже исправлено
grep -rlF --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=postgres --exclude-dir=.next --exclude-dir=.turbo ".bb/" ~/mail0 ~/Library/LaunchAgents 2>/dev/null   → пусто
find ~/mail0 -type l -lname "*/.bb/*" 2>/dev/null                       → пусто

Шаг 6. Отложить bb.
6.1. Опись ~/.bb, в отчёт владельцу: du -sh ~/.bb/* 2>/dev/null | sort -h | tail -15. Найти репозитории и рабочие деревья: find ~/.bb -maxdepth 7 -name .git -not -path "*/node_modules/*" 2>/dev/null; для каждого: git -C <папка> status --short | head и git -C <папка> log --branches --not --remotes --oneline | head. Если есть незакоммиченная или неотправленная работа — перечислить владельцу и ждать его решения.
6.2. pgrep -lf "[.]bb/" → пусто. Если bb есть в Системных настройках → Основные → Объекты входа, убрать его; 1ma можно добавить туда, чтобы он запускался вместе с Mac.
6.3. D=$(date +%Y%m%d); test ! -e ~/.bb.parked-$D && mv ~/.bb ~/.bb.parked-$D
6.4. mv /Applications/bb.app ~/remove-bb-backup/ (не в Корзину: её может очистить автоматика)
6.5. Если существуют, перенести в ~/remove-bb-backup/library: ~/Library/Application Support/bb, ~/Library/Caches/dev.bb.desktop, ~/Library/Caches/bb-updater, ~/Library/Preferences/dev.bb.desktop.plist, ~/Library/Saved Application State/dev.bb.desktop.savedState, ~/Library/HTTPStorages/dev.bb.desktop.

Шаг 7. Проверить сразу: 1ma на This Mac работает (треды открываются, новый тред отвечает), Linux-сервер в меню Server открывается, почта Mail0 открывается с прежними письмами, туннель — как в шаге 0, в 1ma → Automations новый запуск моста выкладок succeeded или skipped, test ! -e ~/.bb && echo ok → ok. Если что-то сломалось — вернуть: mv ~/.bb.parked-<дата> ~/.bb, mv ~/remove-bb-backup/bb.app /Applications/, папки из ~/remove-bb-backup/library на место — и сообщить владельцу.
Отложенная проверка, перед шагом 8 (через день, после перезагрузки Mac или нового входа): ежедневное обновление в 1ma → Automations прошло (succeeded или skipped), почта Mail0 открывается, туннель работает, ~/.bb не появилась снова.

Отчёт владельцу: что нашлось в шагах 1, 4.1 и 6.1, что изменено в шагах 2–4, результаты шагов 5 и 7 — без адресов, ключей, сетевых настроек и содержимого plist.

Шаг 8. Только когда владелец скажет, что за несколько дней всё работало: удалить ~/.bb.parked-<дата> и ~/remove-bb-backup (в ней приложение bb, копии файлов и копия почты). По желанию: в «Связке ключей» удалить запись «bb Safe Storage» (не «1ma Safe Storage»).
```

Пути PostgreSQL взяты из отчёта Codex о переезде (Homebrew `postgresql@14`,
данные в `mail0-local/runtime/postgres`); если на Mac они другие, Codex
останавливается на шаге 4.1.
