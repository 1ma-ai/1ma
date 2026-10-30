# 1ma

**1ma** («one man army») — операционная система бизнеса на ИИ: один сотрудник
с роем агентов делает работу десятерых. Строится поверх
[bb](https://github.com/get-bb/bb) (MIT) как набор плагинов, а не как форк:
ядро bb остаётся без изменений, всё своё живёт в `plugins/`.

Статус: этап 0, фундамент. Первая цель — полностью заменить bb в ежедневной
работе владельца, затем брендированное приложение и функции «Company OS».
Дорожная карта: [docs/plan/2026-10-30-roadmap.md](docs/plan/2026-10-30-roadmap.md).
Решения: [docs/adr/](docs/adr/). Исследование рынка и опенсорса:
[docs/research/](docs/research/).

## Установка плагинов в bb

```sh
bb marketplace add https://raw.githubusercontent.com/1ma-ai/1ma/main/marketplace/marketplace.json
bb plugin search 1ma
bb plugin install <id>@1ma
```

Или напрямую из репозитория:

```sh
bb plugin install git:https://github.com/1ma-ai/1ma.git@main --plugin home-dashboard
```

## Разработка

Нужны Node 24 и pnpm (через corepack). Сборка плагинов идёт только через
`bb plugin build`, как требует bb.

```sh
corepack enable
pnpm install
pnpm run check          # marketplace + lint + format + typecheck + test
pnpm run build          # bb plugin build в каждом плагине
```

Правила для людей и агентов: [AGENTS.md](AGENTS.md), [CONTRIBUTING.md](CONTRIBUTING.md).

## Структура

```
plugins/<id>/              плагины bb, каждый самодостаточен
.bb/plugins.json           индекс плагинов репозитория (bb collection manifest)
marketplace/marketplace.json  витрина 1ma для bb marketplace
docs/adr, docs/plan, docs/research
scripts/                   служебные проверки
```
