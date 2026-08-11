# create-kide-app

Scaffold a new [Kide CMS](https://github.com/mhernesniemi/kide-cms) project.

## Usage

```bash
pnpm create kide-app my-project
```

The CLI asks for:

1. **Project name** — directory to create
2. **Deploy target** — Local/Node.js or Cloudflare
3. **Seed demo content** — local target only

## What it does

- Clones the latest Kide CMS from GitHub.
- Applies target-specific configuration (Node.js adapter, or Cloudflare D1/R2/Workers).
- Installs dependencies with pnpm.
- Optionally creates a GitHub repo (if the `gh` CLI is installed and authenticated).
- Generates the CMS schema.
- For **local**: optionally seeds demo content, then starts the dev server.
- For **Cloudflare**: logs into wrangler (if needed), creates a D1 database and R2 bucket, applies migrations, builds and deploys, and prints the live URL + admin URL.

## Requirements

- Node.js >= 22.12.0
- `pnpm` installed
- `git` on PATH
- Optional: [`gh` CLI](https://cli.github.com) authenticated (`gh auth login`) for GitHub repo creation
- For Cloudflare: a Cloudflare account (the CLI runs `wrangler login` for you)
