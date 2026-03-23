#!/usr/bin/env node

import * as p from "@clack/prompts";
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(__dirname, "templates");

// --- Package manager detection ---

const pm = { name: "pnpm", exec: "pnpm dlx", run: "pnpm", install: "pnpm install" };

// --- Template repo URL ---
const REPO_URL = "https://github.com/mhernesniemi/kide-cms/archive/refs/heads/main.tar.gz";

// --- Main ---

async function main() {
  p.intro("Create Kide CMS Project");

  // 1. Project name
  const projectName =
    process.argv[2] ||
    (await p.text({
      message: "Project name",
      placeholder: "my-cms-app",
      validate: (value) => {
        if (!value) return "Project name is required";
      },
    }));

  if (p.isCancel(projectName)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const projectDir = path.resolve(process.cwd(), projectName);
  if (existsSync(projectDir)) {
    p.cancel(`Directory "${projectName}" already exists.`);
    process.exit(1);
  }

  // 2. Deploy target
  const target = await p.select({
    message: "Where will you deploy?",
    options: [
      { label: "Local / Node.js", value: "local" },
      { label: "Cloudflare", value: "cloudflare" },
    ],
  });

  if (p.isCancel(target)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  // 3. Demo content (local only — Cloudflare uses remote D1)
  let seedDemo = false;
  if (target === "local") {
    const seed = await p.confirm({
      message: "Seed database with demo content?",
      initialValue: false,
    });

    if (p.isCancel(seed)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }
    seedDemo = seed;
  }

  const s = p.spinner();

  // --- Scaffold ---

  s.start(`Scaffolding project (using ${pm.name})`);

  mkdirSync(projectDir, { recursive: true });
  const tmpArchive = path.join(projectDir, "_template.tar.gz");

  try {
    execSync(`curl -sL "${REPO_URL}" -o "${tmpArchive}"`, { stdio: "pipe" });
    execSync(`tar -xzf "${tmpArchive}" -C "${projectDir}" --strip-components=1`, { stdio: "pipe" });
    rmSync(tmpArchive, { force: true });
  } catch {
    s.message("Archive download failed, trying git clone...");
    rmSync(projectDir, { recursive: true, force: true });
    try {
      execSync(`git clone --depth 1 https://github.com/mhernesniemi/kide-cms.git "${projectDir}"`, {
        stdio: "pipe",
      });
      rmSync(path.join(projectDir, ".git"), { recursive: true, force: true });
    } catch {
      s.stop("Failed to download template.");
      p.cancel("Check your network connection.");
      process.exit(1);
    }
  }

  // Remove files that shouldn't be in the scaffold
  for (const remove of ["docs", "packages", "CLAUDE.md", ".claude", "data", ".cms-data", "dist", ".astro", ".env"]) {
    const fp = path.join(projectDir, remove);
    if (existsSync(fp)) rmSync(fp, { recursive: true, force: true });
  }

  s.stop("Project scaffolded");

  // --- Apply target-specific files ---

  s.start(`Applying ${target} configuration`);

  const targetDir = path.join(TEMPLATES_DIR, target);

  cpSync(path.join(targetDir, "astro.config.mjs"), path.join(projectDir, "astro.config.mjs"));
  cpSync(path.join(targetDir, "db.ts"), path.join(projectDir, "src/cms/core/db.ts"));
  cpSync(path.join(targetDir, "drizzle.config.ts"), path.join(projectDir, "drizzle.config.ts"));

  if (target === "cloudflare") {
    cpSync(path.join(targetDir, "storage.ts"), path.join(projectDir, "src/cms/core/storage.ts"));
    const uploadsRouteDir = path.join(projectDir, "src/pages/uploads");
    mkdirSync(uploadsRouteDir, { recursive: true });
    cpSync(path.join(targetDir, "uploads-route.ts"), path.join(uploadsRouteDir, "[...path].ts"));
  }

  const pkgPath = path.join(projectDir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

  pkg.name = projectName;

  if (target === "cloudflare") {
    delete pkg.dependencies["@astrojs/node"];
    pkg.dependencies["@astrojs/cloudflare"] = "^13.0.0";

    // Move better-sqlite3 to devDependencies — drizzle-kit needs it to push schema to local D1
    if (pkg.dependencies["better-sqlite3"]) {
      if (!pkg.devDependencies) pkg.devDependencies = {};
      pkg.devDependencies["better-sqlite3"] = pkg.dependencies["better-sqlite3"];
      delete pkg.dependencies["better-sqlite3"];
    }
    delete pkg.dependencies["sharp"];

    let wranglerContent = readFileSync(path.join(targetDir, "wrangler.toml"), "utf-8");
    wranglerContent = wranglerContent.replaceAll("{{PROJECT_NAME}}", projectName);
    writeFileSync(path.join(projectDir, "wrangler.toml"), wranglerContent);

    pkg.devDependencies.wrangler = "^4.0.0";

    pkg.scripts.dev = "astro dev";
    pkg.scripts.build = "astro build";
    pkg.scripts.preview = "astro build && wrangler dev --config dist/server/wrangler.json";
    pkg.scripts.deploy = "astro build && wrangler deploy --config dist/server/wrangler.json";
  }

  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  if (target === "cloudflare") {
    const gitignorePath = path.join(projectDir, ".gitignore");
    let gitignore = readFileSync(gitignorePath, "utf-8");
    gitignore += "\n# Cloudflare\n.wrangler/\n";
    writeFileSync(gitignorePath, gitignore);
  }

  s.stop("Configuration applied");

  // --- Install dependencies ---

  s.start("Installing dependencies");
  try {
    execSync(pm.install, { cwd: projectDir, stdio: "pipe" });
    s.stop("Dependencies installed");
  } catch {
    s.stop(`${pm.install} failed — run it manually`);
  }

  // --- Generate schema ---

  s.start("Generating CMS schema");
  try {
    execSync(`${pm.run} cms:generate`, { cwd: projectDir, stdio: "pipe" });
    s.stop("Schema generated");
  } catch {
    s.stop("Schema generation failed — run `cms:generate` manually");
  }

  // --- Seed demo content ---

  if (seedDemo && target === "local") {
    s.start("Pushing schema to database");
    try {
      execSync(`${pm.exec} drizzle-kit push --force`, { cwd: projectDir, stdio: "pipe" });
      s.stop("Schema pushed");
    } catch {
      s.stop("Schema will be set up on first dev start");
    }
    s.start("Seeding demo content");
    try {
      execSync(`${pm.run} cms:seed`, { cwd: projectDir, stdio: "pipe" });
      s.stop("Demo content seeded");
    } catch {
      s.stop("Seeding failed — run `pnpm cms:seed` manually");
    }
  } else if (seedDemo && target === "cloudflare") {
    p.note(
      [
        "Seeding for Cloudflare requires a D1 database.",
        "",
        `  ${pm.exec} wrangler d1 create ${projectName}-db`,
        "  # Add the database_id to wrangler.toml",
        `  ${pm.exec} wrangler d1 execute --local --file=./src/cms/migrations/0000_*.sql`,
        `  ${pm.run} cms:seed`,
      ].join("\n"),
      "Seed manually",
    );
  }

  // --- Done ---

  if (target === "local") {
    p.outro("Starting dev server...");
    try {
      execSync(`${pm.run} dev`, { cwd: projectDir, stdio: "inherit" });
    } catch {
      console.log(`\n  Project directory: ${projectDir}`);
      console.log(`  To start again:   cd ${projectName} && pnpm dev\n`);
    }
  } else {
    p.note(
      [
        `cd ${projectName}`,
        "",
        "Set up Cloudflare resources:",
        `  ${pm.exec} wrangler d1 create ${projectName}-db`,
        "  # Copy the database_id to wrangler.toml",
        `  ${pm.exec} wrangler r2 bucket create ${projectName}-assets`,
        "",
        "Push database schema:",
        `  ${pm.exec} wrangler d1 execute ${projectName}-db --remote --file=src/cms/migrations/0000_init.sql`,
        "",
        "Local development:",
        `  ${pm.run} dev`,
        "",
        "Deploy:",
        "  pnpm run deploy",
      ].join("\n"),
      "Next steps",
    );
    p.outro("Project created!");
  }
}

main().catch((err) => {
  p.cancel(err.message);
  process.exit(1);
});
