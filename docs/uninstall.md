# Uninstall 1ma

Remove the app, then delete 1ma's data folder if you don't want to keep your
threads and settings. Your project folders are not touched.

1. **Quit 1ma.**
2. **Remove the app.**
   - Mac: drag **1ma** from Applications to the Trash.
   - Linux server: stop the 1ma service, then delete the folder it was
     installed in (the folder with `node_modules/bb-app`).
3. **Remove the command line tool** (only if you installed it from Settings).
   Before removing the app, open Settings → General and choose **Remove** next
   to the command line tool. If the app is already gone, delete the `bb` link
   1ma created: it is in `~/.local/bin`, `/opt/homebrew/bin`,
   `/usr/local/bin` or `~/bin` and points into `~/.1ma/bin`. The command is
   still called `bb`; it gets its own name in a later version of 1ma.
4. **Delete your data (optional).** Delete `~/.1ma`. It holds your threads,
   settings, plugins and the worktrees 1ma created, so push any work you want
   to keep first.

## Удалить 1ma

Удалите приложение, затем папку данных 1ma, если не хотите сохранить треды и
настройки. Папки ваших проектов не затрагиваются.

1. **Выйдите из 1ma.**
2. **Удалите приложение.**
   - Mac: перетащите **1ma** из «Программ» в Корзину.
   - Linux-сервер: остановите службу 1ma и удалите папку, в которую он был
     установлен (папка с `node_modules/bb-app`).
3. **Удалите инструмент командной строки** (только если ставили его из
   настроек). До удаления приложения откройте Settings → General и нажмите
   **Remove** рядом с инструментом командной строки. Если приложения уже нет,
   удалите ссылку `bb`, которую создал 1ma: она лежит в `~/.local/bin`,
   `/opt/homebrew/bin`, `/usr/local/bin` или `~/bin` и указывает в
   `~/.1ma/bin`. Команда пока называется `bb`, своё имя она получит в одной из
   следующих версий 1ma.
4. **Удалите данные (по желанию).** Удалите `~/.1ma`. Там треды, настройки,
   плагины и рабочие копии, созданные 1ma, поэтому сначала отправьте нужные
   изменения в свои репозитории.
