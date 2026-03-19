#!/usr/bin/env node

import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(__dirname, "templates");

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
};

const log = (msg) => console.log(msg);
const success = (msg) => log(`${colors.green}${msg}${colors.reset}`);
const info = (msg) => log(`${colors.cyan}${msg}${colors.reset}`);
const warn = (msg) => log(`${colors.yellow}${msg}${colors.reset}`);
const error = (msg) => log(`${colors.red}${msg}${colors.reset}`);
const bold = (msg) => `${colors.bold}${msg}${colors.reset}`;

// --- Prompts ---

const rl = createInterface({ input: process.stdin, output: process.stdout });

const ask = (question) =>
  new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });

const select = async (question, options) => {
  log(`\n${bold(question)}`);
  options.forEach((opt, i) => {
    const marker = i === 0 ? `${colors.cyan}>${colors.reset}` : " ";
    log(`  ${marker} ${i + 1}. ${opt.label}`);
  });
  const answer = await ask(`\n  Enter choice (1-${options.length}) [1]: `);
  const index = answer ? parseInt(answer, 10) - 1 : 0;
  if (index < 0 || index >= options.length) {
    error("  Invalid choice.");
    process.exit(1);
  }
  return options[index].value;
};

const confirm = async (question) => {
  const answer = await ask(`${bold(question)} (y/n) [n]: `);
  return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
};

// --- Package manager detection ---

const detectPackageManager = () => {
  // npm_config_user_agent is set by npm/pnpm/yarn/bun when running via npx/pnpx/bunx
  const ua = process.env.npm_config_user_agent ?? "";
  if (ua.startsWith("pnpm")) return { name: "pnpm", exec: "pnpm dlx", run: "pnpm", install: "pnpm install" };
  if (ua.startsWith("yarn")) return { name: "yarn", exec: "yarn dlx", run: "yarn", install: "yarn install" };
  if (ua.startsWith("bun")) return { name: "bun", exec: "bunx", run: "bun", install: "bun install" };
  return { name: "npm", exec: "npx", run: "npm run", install: "npm install" };
};

// --- Template repo URL ---
const REPO_URL = "https://github.com/mhernesniemi/liito-cms/archive/refs/heads/main.tar.gz";
const REPO_EXTRACT_DIR = "liito-cms-main";

// --- Main ---

async function main() {
  log("");
  log(`  ${bold("create-liito-app")} ${colors.dim}v0.0.1${colors.reset}`);
  log(`  ${colors.dim}Code-first, single-schema CMS built inside Astro${colors.reset}`);
  log("");

  // 1. Project name
  let projectName = process.argv[2];
  if (!projectName) {
    projectName = await ask(`  ${bold("Project name:")} `);
    if (!projectName) {
      error("  Project name is required.");
      process.exit(1);
    }
  }

  const projectDir = path.resolve(process.cwd(), projectName);
  if (existsSync(projectDir)) {
    error(`  Directory "${projectName}" already exists.`);
    process.exit(1);
  }

  // 2. Deploy target
  const target = await select("Where will you deploy?", [
    { label: "Local / Node.js", value: "local" },
    { label: "Cloudflare", value: "cloudflare" },
  ]);

  // 3. Demo content
  const seedDemo = await confirm("\n  Seed database with demo content?");

  rl.close();

  const pm = detectPackageManager();

  // --- Scaffold ---

  log("");
  info(`  Scaffolding project... ${colors.dim}(using ${pm.name})${colors.reset}`);

  // Download and extract template from GitHub
  mkdirSync(projectDir, { recursive: true });
  const tmpArchive = path.join(projectDir, "_template.tar.gz");

  try {
    execSync(`curl -sL "${REPO_URL}" -o "${tmpArchive}"`, { stdio: "pipe" });
    execSync(`tar -xzf "${tmpArchive}" -C "${projectDir}" --strip-components=1`, { stdio: "pipe" });
    rmSync(tmpArchive, { force: true });
  } catch {
    // Fallback: if curl/tar fail, try with git
    warn("  Archive download failed, trying git clone...");
    rmSync(projectDir, { recursive: true, force: true });
    try {
      execSync(`git clone --depth 1 https://github.com/mhernesniemi/liito-cms.git "${projectDir}"`, {
        stdio: "pipe",
      });
      rmSync(path.join(projectDir, ".git"), { recursive: true, force: true });
    } catch {
      error("  Failed to download template. Check your network connection.");
      process.exit(1);
    }
  }

  // Remove files that shouldn't be in the scaffold
  for (const remove of ["docs", "packages", "CLAUDE.md", ".claude", "data", ".cms-data", "dist", ".astro", ".env"]) {
    const p = path.join(projectDir, remove);
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }

  // --- Apply target-specific files ---

  info(`  Applying ${target} configuration...`);

  const targetDir = path.join(TEMPLATES_DIR, target);

  // astro.config.mjs
  cpSync(path.join(targetDir, "astro.config.mjs"), path.join(projectDir, "astro.config.mjs"));

  // db.ts
  cpSync(path.join(targetDir, "db.ts"), path.join(projectDir, "src/cms/core/db.ts"));

  // drizzle.config.ts
  cpSync(path.join(targetDir, "drizzle.config.ts"), path.join(projectDir, "drizzle.config.ts"));

  // --- Target-specific setup ---

  const pkgPath = path.join(projectDir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

  // Update package name
  pkg.name = projectName;

  if (target === "cloudflare") {
    // Swap adapter dependency
    delete pkg.dependencies["@astrojs/node"];
    pkg.dependencies["@astrojs/cloudflare"] = "^12.0.0";

    // Remove native SQLite deps
    delete pkg.dependencies["better-sqlite3"];
    if (pkg.devDependencies) delete pkg.devDependencies["@types/better-sqlite3"];
    if (pkg.pnpm?.onlyBuiltDependencies) {
      pkg.pnpm.onlyBuiltDependencies = pkg.pnpm.onlyBuiltDependencies.filter((d) => d !== "better-sqlite3");
      if (pkg.pnpm.onlyBuiltDependencies.length === 0) delete pkg.pnpm.onlyBuiltDependencies;
      if (Object.keys(pkg.pnpm).length === 0) delete pkg.pnpm;
    }

    // Write wrangler.toml with project name
    let wranglerContent = readFileSync(path.join(targetDir, "wrangler.toml"), "utf-8");
    wranglerContent = wranglerContent.replaceAll("{{PROJECT_NAME}}", projectName);
    writeFileSync(path.join(projectDir, "wrangler.toml"), wranglerContent);

    // Add wrangler as dev dependency
    pkg.devDependencies["wrangler"] = "^4.0.0";

    // Update scripts for Cloudflare
    pkg.scripts["dev"] = "astro dev";
    pkg.scripts["build"] = "astro build";
    pkg.scripts["preview"] = "wrangler pages dev ./dist";
    pkg.scripts["deploy"] = "astro build && wrangler pages deploy ./dist";
  }

  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

  // Update .gitignore for Cloudflare
  if (target === "cloudflare") {
    const gitignorePath = path.join(projectDir, ".gitignore");
    let gitignore = readFileSync(gitignorePath, "utf-8");
    gitignore += "\n# Cloudflare\n.wrangler/\n";
    writeFileSync(gitignorePath, gitignore);
  }

  // --- Install dependencies ---

  info("  Installing dependencies...");
  try {
    execSync(pm.install, { cwd: projectDir, stdio: "pipe" });
  } catch {
    warn(`  ${pm.install} failed. Run it manually.`);
  }

  // --- Generate schema ---

  info("  Generating CMS schema...");
  try {
    execSync(`${pm.run} cms:generate`, { cwd: projectDir, stdio: "pipe" });
  } catch {
    warn(`  Schema generation failed. Run \`${pm.run} cms:generate\` manually.`);
  }

  // --- Seed demo content ---

  if (seedDemo && target === "local") {
    info("  Seeding demo content...");
    try {
      execSync(`${pm.exec} drizzle-kit push --force`, { cwd: projectDir, stdio: "pipe" });
      execSync(`${pm.run} cms:seed`, { cwd: projectDir, stdio: "pipe" });
      success("  Demo content seeded.");
    } catch {
      warn(`  Seeding failed. Run \`${pm.exec} drizzle-kit push --force && ${pm.run} cms:seed\` manually.`);
    }
  } else if (seedDemo && target === "cloudflare") {
    warn("  Seeding for Cloudflare requires a D1 database. Set up D1 first, then run:");
    log(`    ${pm.exec} wrangler d1 create ${projectName}-db`);
    log("    # Add the database_id to wrangler.toml");
    log(`    ${pm.exec} wrangler d1 execute --local --file=./src/cms/migrations/0000_*.sql`);
    log(`    ${pm.run} cms:seed`);
  }

  // --- Done ---

  log("");
  success("  Project created successfully!");
  log("");
  log(`  ${bold("Next steps:")}`);
  log("");
  log(`    cd ${projectName}`);

  if (target === "local") {
    if (!seedDemo) {
      log(`    ${pm.exec} drizzle-kit push --force`);
    }
    log(`    ${pm.run} dev`);
    log("");
    log(`  ${colors.dim}Open http://localhost:4321/admin to set up your admin account.${colors.reset}`);
  } else {
    log("");
    log(`  ${bold("Set up Cloudflare resources:")}`);
    log(`    ${pm.exec} wrangler d1 create ${projectName}-db`);
    log(`    ${pm.exec} wrangler r2 bucket create ${projectName}-assets`);
    log("    # Add the database_id to wrangler.toml");
    log("");
    log(`  ${bold("Local development:")}`);
    log(`    ${pm.run} dev`);
    log("");
    log(`  ${bold("Deploy:")}`);
    log(`    ${pm.run} deploy`);
  }

  log("");
}

main().catch((err) => {
  error(`\n  ${err.message}`);
  process.exit(1);
});
