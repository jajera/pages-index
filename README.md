# pages-index

Index of public GitHub Pages sites, modules, and tools across my accounts.

**Live:** https://pages.johna.kiwi/

Patina UI (shared with [guides.johna.kiwi](https://guides.johna.kiwi/) / [johna.kiwi](https://johna.kiwi/)). Discovery runs on a schedule and writes static JSON; the site never calls the GitHub API in the browser.

## Stack

- [Astro](https://astro.build/) (static)
- Prebuilt `data/repositories.json`
- Search, category filters, pagination
- GitHub Pages + Actions

## Quick start

```bash
npm install
npm run dev
```

Refresh index data (token recommended):

```bash
GITHUB_TOKEN=ghp_xxx npm run update
```

Production build:

```bash
npm run build
npm run preview
```

## Configuration

[`config.json`](config.json) controls:

- `sources.users` / `sources.organizations` to scan
- include/exclude patterns
- categorization rules for web apps, Terraform, Actions, DevContainer features

[`scripts/update-repositories.mjs`](scripts/update-repositories.mjs) writes [`data/repositories.json`](data/repositories.json).

## Deploy

Push to `main`. [Deploy to GitHub Pages](.github/workflows/deploy.yml) builds and publishes `dist/`.

[Update repository index](.github/workflows/update-repositories.yml) runs every 6 hours, on `workflow_dispatch`, and when `config.json` or the update script changes.

Enable once: repo **Settings → Pages → Source: GitHub Actions**. Custom domain: `pages.johna.kiwi` (Route 53 CNAME from johna-kiwi-infra `sites.yaml`).
