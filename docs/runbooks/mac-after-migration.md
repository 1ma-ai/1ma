# Mac после переезда на 1ma (инструкция для Codex)

Инструкцию выполняет Codex владельца на его Mac после того, как владелец
подтвердил, что 1ma работает. Приложение bb и папка `~/.bb` остаются.

```text
Задача: после переезда этого Mac на 1ma убрать временные файлы переезда, включить в 1ma ежедневные автообновления Claude Code, Codex и плагинов и проверить, что ещё держит 1ma на папке bb. Приложение bb и папку ~/.bb не удалять: владелец пока оставляет bb.

Правила:
- Не трогать ~/.bb, /Applications/bb.app, ~/.1ma и службы Mail0 (LaunchAgent ai.msg8.bb-mail).
- Перед каждым удалением показать содержимое и удалять только то, что названо ниже.
- Команды выполнять вне песочницы Codex.
- Если что-то не совпадает с описанием — остановиться и сообщить владельцу.

Шаг 1. Временные файлы переезда (владелец подтвердил, что 1ma работает).
ls -la ~/1ma-migration
Там экспорт bb-server.tar, извлечённая база exported-bb.db, журналы, DMG и скрипт переезда; экспорт и база содержат секреты. Удалить:
rm -rf ~/1ma-migration
ls -d ~/.1ma.before-migration-*
Должна быть одна папка ~/.1ma.before-migration-2026-11-08T14-50-22.172Z (прежняя пробная 1ma). Удалить:
rm -rf ~/.1ma.before-migration-2026-11-08T14-50-22.172Z

Шаг 2. Ежедневные обновления (1ma запущен, выбран This Mac). Создать автоматизацию в Personal:
~/.1ma/bin/bb automation create --project proj_personal --name "Daily updates: Claude Code, Codex, plugins" --cron "0 13 * * *" --timezone Europe/Warsaw --interpreter sh --timeout 15m --working-directory automation-storage --script 'out=$(bb updates apply 2>&1)
status=$?
case "$out" in
  "Everything is up to date.") ;;
  *) printf "%s\n" "$out" ;;
esac
plugins=$(bb plugin update --all --yes 2>&1)
pstatus=$?
printf "%s\n" "$plugins" | grep -v -e ": current (" -e " pinned" || true
[ "$status" -eq 0 ] && [ "$pstatus" -eq 0 ]'
Запомнить ID из вывода (auto_…). Один раз запустить и посмотреть результат:
~/.1ma/bin/bb automation run <ID> --project proj_personal
~/.1ma/bin/bb automation runs <ID> --project proj_personal --limit 1
Статус succeeded или skipped (skipped — обновлять было нечего). Затем вывести ~/.1ma/bin/bb updates status.

Шаг 3. Что ещё держит 1ma на ~/.bb (только чтение, ничего не менять):
sqlite3 -readonly ~/.1ma/bb.db "select 'environment', status, coalesce(path, claim_path) from environments where status <> 'destroyed' and (path like '%/.bb/%' or claim_path like '%/.bb/%') union all select 'project source', '', path from project_sources where path like '%/.bb/%' union all select 'plugin', source_kind, coalesce(source_path, root_dir) from plugins where source_path like '%/.bb/%' or (source_kind = 'path' and root_dir like '%/.bb/%');"
Каждая строка — рабочая папка треда, папка проекта или плагин внутри ~/.bb.
grep -rl "/.bb/" ~/Library/LaunchAgents 2>/dev/null
grep -n -E "\.bb/|bb\.app" ~/.zshrc ~/.zprofile ~/.bash_profile ~/.profile 2>/dev/null
command -v bb; ls -l "$(command -v bb)" 2>/dev/null

Шаг 4. Отчёт владельцу: что удалено, ID автоматизации и результат её первого запуска, вывод bb updates status и вывод шага 3.
```

Строки шага 3 — то, что надо перенести из `~/.bb`, прежде чем удалять bb
совсем: рабочие папки тредов и проектов (переносом с правкой путей в базе),
Mail0 владельца и команду `bb`, если она указывает на bb.
