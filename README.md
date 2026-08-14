# create-kide-app

Scaffold a new [Kide CMS](https://github.com/mhernesniemi/kide-cms) project.

## Usage

```bash
pnpm create kide-app my-project
```

The CLI asks for:

1. **Project name** — directory to create
2. **Starter template** — Blank (default: one `pages` collection, no demo content) or a starter shipped with the template release, e.g. Marketing site (pages with blocks, blog, menu, contact form). Starters can seed example content into the local database.
3. **Distribution mode** — Package (recommended: thin project + `@kidecms/core` npm dependency; `pnpm exec kide eject` converts to embedded later, one-way) or Embedded (full CMS source in `src/cms/`, yours to modify)
4. **Deploy target** — Local/Node.js or Cloudflare

## Non-interactive use

Every prompt can be answered with a flag; supplied answers skip their prompts.

```bash
pnpm create kide-app my-app --starter=marketing --seed --mode=embedded --target=local --no-github --no-dev
```

| Flag | Values |
| ---- | ------ |
| `--starter=` | `blank` or a starter name from the template release |
| `--seed` / `--no-seed` | Seed example content (local target only) |
| `--mode=` | `package` or `embedded` |
| `--target=` | `local` or `cloudflare` |
| `--no-github` | Skip the GitHub repo prompt |
| `--no-dev` | Skip the dev-server prompt |
| `--no-cloudflare-setup` | Skip Cloudflare resource provisioning |

The template repo can be overridden with the `KIDE_TEMPLATE_REPO` env var (forks, local testing).

## What it does

- Clones the latest Kide CMS release from GitHub (package mode then swaps the embedded runtime for the published `@kidecms/core` at the same version).
- Applies target-specific configuration (Node.js adapter, or Cloudflare D1/R2/Workers).
- Installs dependencies with pnpm.
- Optionally creates a GitHub repo (if the `gh` CLI is installed and authenticated).
- Generates the CMS schema.
- For **local**: starts the dev server.
- For **Cloudflare**: logs into wrangler (if needed), creates a D1 database and R2 bucket, applies migrations, builds and deploys, and prints the live URL + admin URL.

## Requirements

- Node.js >= 22.12.0
- `pnpm` installed
- `git` on PATH
- Optional: [`gh` CLI](https://cli.github.com) authenticated (`gh auth login`) for GitHub repo creation
- For Cloudflare: a Cloudflare account (the CLI runs `wrangler login` for you)
