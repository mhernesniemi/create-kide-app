#!/usr/bin/env node

import * as p from "@clack/prompts";
import { execFileSync, execSync, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

// Async spawn wrapper so long-running commands don't block clack spinners
const runAsync = (cmd, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, { cwd, shell: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else {
        const err = new Error(`Command failed: ${cmd}`);
        err.stderr = stderr;
        err.stdout = stdout;
        reject(err);
      }
    });
  });

// --- Package manager detection ---

const pm = {
  name: "pnpm",
  exec: "pnpm exec",
  dlx: "pnpm dlx",
  run: "pnpm",
  install: "pnpm install",
};

// --- Template repo ---

const REPO = "https://github.com/mhernesniemi/kide-cms.git";

// Files from the kide-cms repo that shouldn't leak into scaffolded projects.
// NOTE: `.claude/settings.local.json` is removed but `.claude/skills/` is kept,
// so scaffolds ship the /migrate skill alongside AGENTS.md.
const CLEANUP = [
  "docs",
  "CLAUDE.md",
  ".claude/settings.local.json",
  "data",
  ".cms-data",
  "dist",
  ".astro",
  ".DS_Store",
];

// The project name reaches shell commands (git, wrangler) and path.resolve, so it is
// validated before either. Restricting it to one path segment of safe characters keeps
// `$(...)`, backticks, `;` and separators out of those commands and out of the target
// path. Must start alphanumeric so "." and ".." can never be the whole name.
const PROJECT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

const validateProjectName = (value) => {
  if (!PROJECT_NAME_PATTERN.test(value)) {
    return "Project name must start with a letter or number and contain only letters, numbers, dots, dashes and underscores.";
  }
  return undefined;
};

// Resolve the latest release tag (v-prefixed semver) so scaffolds pin to a
// deliberate release instead of whatever HEAD happens to be. Returns null when
// the repo has no tags (falls back to the default branch).
const resolveLatestTag = () => {
  try {
    const output = execSync(
      `git ls-remote --tags --sort=-v:refname ${REPO} "v*"`,
      { stdio: "pipe" },
    ).toString();
    for (const line of output.split("\n")) {
      const match = line.match(/refs\/tags\/(v[0-9][^^\s]*)$/);
      if (match) return match[1];
    }
  } catch {
    // Network/git hiccup — fall back to default branch
  }
  return null;
};

// --- Main ---

async function main() {
  p.intro("🪐 Create Kide CMS Project");

  // 1. Project name
  const projectName =
    process.argv[2] ||
    (await p.text({
      message: "Project name",
      placeholder: "my-cms-app",
      validate: (value) => {
        if (!value) return "Project name is required";
        return validateProjectName(value);
      },
    }));

  if (p.isCancel(projectName)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  // Re-check: the interactive path validates above, but a name from argv skips it,
  // and this value reaches shell commands and path.resolve below.
  const nameError = validateProjectName(projectName);
  if (nameError) {
    p.cancel(nameError);
    process.exit(1);
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

  // --- Scaffold via git clone ---

  s.start(`Scaffolding project (using ${pm.name})`);

  const templateRef = resolveLatestTag();
  let templateCommit = null;

  try {
    const branchArgs = templateRef ? ["--branch", templateRef] : [];
    // execFileSync, not execSync: no shell, so projectDir is passed as one argv entry
    // and can never be reinterpreted as a command regardless of what it contains.
    execFileSync(
      "git",
      ["clone", "--depth", "1", ...branchArgs, REPO, projectDir],
      {
        stdio: "pipe",
      },
    );
    try {
      templateCommit = execSync("git rev-parse HEAD", {
        cwd: projectDir,
        stdio: "pipe",
      })
        .toString()
        .trim();
    } catch {
      // best-effort — stamp without a commit hash
    }
    rmSync(path.join(projectDir, ".git"), { recursive: true, force: true });
  } catch {
    s.stop("Failed to download template.");
    p.cancel("Check your network connection.");
    process.exit(1);
  }

  // Remove files that shouldn't be in the scaffold
  for (const f of CLEANUP) {
    rmSync(path.join(projectDir, f), { recursive: true, force: true });
  }

  s.stop(
    templateRef
      ? `Project scaffolded from ${templateRef}`
      : "Project scaffolded",
  );

  // --- Apply target-specific files ---

  s.start(`Applying ${target} configuration`);

  const adaptersDir = path.join(projectDir, "adapters");
  const targetDir = path.join(adaptersDir, target);

  if (target === "cloudflare") {
    // The Cloudflare adapter/storage/env implementations live in the tree at
    // src/cms/platform/cloudflare. We only copy the target's Astro/Drizzle/wrangler config and
    // flip the two platform selectors to point at that profile — no source files are overwritten.
    cpSync(
      path.join(targetDir, "astro.config.mjs"),
      path.join(projectDir, "astro.config.mjs"),
    );
    cpSync(
      path.join(targetDir, "drizzle.config.ts"),
      path.join(projectDir, "drizzle.config.ts"),
    );
    writeFileSync(
      path.join(projectDir, "src/cms/adapters/db.ts"),
      'export * from "../platform/cloudflare/database";\n',
    );
    writeFileSync(
      path.join(projectDir, "src/cms/adapters/storage.ts"),
      'export * from "../platform/cloudflare/storage";\n',
    );
  }

  const pkgPath = path.join(projectDir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

  pkg.name = projectName;

  if (target === "cloudflare") {
    delete pkg.dependencies["@astrojs/node"];
    pkg.dependencies["@astrojs/cloudflare"] = "~14.1.7";

    // Move better-sqlite3 to devDependencies — drizzle-kit needs it to push schema to local D1
    if (pkg.dependencies["better-sqlite3"]) {
      if (!pkg.devDependencies) pkg.devDependencies = {};
      pkg.devDependencies["better-sqlite3"] =
        pkg.dependencies["better-sqlite3"];
      delete pkg.dependencies["better-sqlite3"];
    }
    delete pkg.dependencies["sharp"];

    let wranglerContent = readFileSync(
      path.join(targetDir, "wrangler.toml"),
      "utf-8",
    );
    wranglerContent = wranglerContent.replaceAll(
      "{{PROJECT_NAME}}",
      projectName,
    );
    // Seed a placeholder database_id so `pnpm dev` works out of the box —
    // miniflare requires a non-empty id even for the local D1. It's overwritten
    // with the real id if a D1 is created below; otherwise paste the real id
    // before deploying (`wrangler deploy` rejects an id it doesn't own).
    wranglerContent = wranglerContent.replace(
      /database_id = ""[^\n]*/,
      `database_id = "${crypto.randomUUID()}" # local placeholder - replace with the id from \`wrangler d1 create ${projectName}-db\` before deploying`,
    );
    writeFileSync(path.join(projectDir, "wrangler.toml"), wranglerContent);

    pkg.devDependencies.wrangler = "^4.83.0";

    pkg.scripts.dev = "astro dev";
    pkg.scripts.build = "astro build";
    pkg.scripts.preview =
      "astro build && wrangler dev --config dist/server/wrangler.json";
    pkg.scripts.deploy =
      "astro build && wrangler deploy --config dist/server/wrangler.json";

    // @cloudflare/vite-plugin statically imports module.registerHooks (Node
    // >=22.15), and Node >=23 changes the native ABI (breaking the prebuilt
    // better-sqlite3 used for local D1). So pin Node 22.18–22.x and guard `dev`
    // with a friendly check instead of a cryptic ESM "registerHooks" crash.
    pkg.engines = { ...(pkg.engines ?? {}), node: ">=22.18.0" };
    pkg.scripts.predev =
      `node -e "const v=process.versions.node.split('.').map(Number);` +
      `if(v[0]<22||(v[0]===22&&v[1]<18)||v[0]>=23){` +
      `console.error('\\n[kide] Cloudflare dev needs Node 22.18+ (22.x). You have '+process.version+'.\\n` +
      `       Run: nvm install 22 && nvm use   (or use fnm/volta)\\n');` +
      `process.exit(1)}"`;
    writeFileSync(path.join(projectDir, ".nvmrc"), "22\n");
  }

  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  rmSync(adaptersDir, { recursive: true, force: true });

  // Stamp the scaffold provenance. This file is the project's record of which
  // template release it came from — used to diff against upstream and to check
  // whether published security advisories apply to this project.
  let cliVersion = null;
  try {
    cliVersion = JSON.parse(
      readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
    ).version;
  } catch {
    // best-effort
  }
  const versionStamp = {
    template: REPO.replace(/\.git$/, ""),
    kideVersion: pkg.version ?? null,
    ref: templateRef ?? "HEAD",
    commit: templateCommit,
    target,
    corePath: "src/cms",
    scaffoldedAt: new Date().toISOString(),
    createKideApp: cliVersion,
  };
  writeFileSync(
    path.join(projectDir, ".kide-version"),
    `${JSON.stringify(versionStamp, null, 2)}\n`,
  );

  // Wire up the local MCP server so Claude Code (and other MCP clients that read
  // a project-scoped `.mcp.json`) discover it automatically — no manual
  // `claude mcp add` needed. The command runs from the project root, where the
  // `cms:mcp` script lives, so no `cwd` override is required.
  const mcpConfig = {
    mcpServers: {
      kide: {
        type: "stdio",
        command: "pnpm",
        args: ["cms:mcp"],
      },
    },
  };
  writeFileSync(
    path.join(projectDir, ".mcp.json"),
    `${JSON.stringify(mcpConfig, null, 2)}\n`,
  );

  s.stop("Configuration applied");

  // --- Install dependencies ---

  s.start("Installing dependencies");
  try {
    await runAsync(pm.install, projectDir);
    s.stop("Dependencies installed");
  } catch {
    s.stop(`${pm.install} failed — run it manually`);
  }

  // --- Initialize git repository ---

  let gitInitialized = false;
  try {
    execSync(
      "git init -q && git add . && git commit -q -m 'Initial commit from create-kide-app'",
      {
        cwd: projectDir,
        stdio: "pipe",
      },
    );
    gitInitialized = true;
  } catch {
    // git not available — silently skip
  }

  // --- Optional: create GitHub repository ---

  if (gitInitialized) {
    let ghAvailable = false;
    try {
      execSync("gh --version", { stdio: "pipe" });
      execSync("gh auth status", { stdio: "pipe" });
      ghAvailable = true;
    } catch {
      // gh not installed or not authenticated — skip the prompt
    }

    if (ghAvailable) {
      const createRepo = await p.confirm({
        message: "Create a GitHub repository for this project?",
        initialValue: false,
      });
      if (!p.isCancel(createRepo) && createRepo) {
        // Get the GitHub username so we can check repo availability
        let ghUser = "";
        try {
          ghUser = execSync("gh api user --jq .login", { stdio: "pipe" })
            .toString()
            .trim();
        } catch {
          // ignore
        }

        // Prompt for repo name, validate it doesn't already exist
        let repoName = null;
        while (true) {
          const input = await p.text({
            message: "Repository name",
            initialValue: projectName,
            validate: (value) => {
              if (!value) return "Repository name is required";
              if (!/^[a-zA-Z0-9._-]+$/.test(value))
                return "Only letters, numbers, dots, hyphens, and underscores";
            },
          });
          if (p.isCancel(input)) break;

          if (ghUser) {
            try {
              execSync(`gh repo view ${ghUser}/${input}`, { stdio: "pipe" });
              p.note(
                `A repository named "${input}" already exists. Pick a different name.`,
                "Name taken",
              );
              continue;
            } catch {
              // Repo doesn't exist — name is free
            }
          }
          repoName = input;
          break;
        }

        if (repoName) {
          const visibility = await p.select({
            message: "Repository visibility",
            options: [
              { label: "Private", value: "--private" },
              { label: "Public", value: "--public" },
            ],
          });
          if (!p.isCancel(visibility)) {
            s.start("Creating GitHub repository");
            try {
              execSync(`gh repo create ${repoName} ${visibility}`, {
                cwd: projectDir,
                stdio: "pipe",
              });

              // Use SSH for the remote (works with the user's existing SSH keys;
              // avoids HTTPS credential prompts when gh's git_protocol defaults to https).
              execSync(
                `git remote add origin git@github.com:${ghUser}/${repoName}.git`,
                {
                  cwd: projectDir,
                  stdio: "pipe",
                },
              );
              execSync("git branch -M main && git push -u origin main", {
                cwd: projectDir,
                stdio: "pipe",
              });
              s.stop("GitHub repository created and pushed");
            } catch (err) {
              s.stop("GitHub repository creation failed");
              if (err.stderr) console.error(err.stderr.toString().slice(-500));
            }
          }
        }
      }
    }
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
    // The guarded sync script (exits non-zero on failure, creates data/ itself) —
    // same path the dev server and deploys use.
    try {
      execSync(`${pm.run} cms:push`, { cwd: projectDir, stdio: "pipe" });
      s.stop("Schema pushed");
    } catch {
      s.stop("Schema push failed — run `pnpm cms:push` manually");
    }
    s.start("Seeding demo content");
    try {
      execSync(`${pm.run} cms:seed`, { cwd: projectDir, stdio: "pipe" });
      s.stop("Demo content seeded");
    } catch (err) {
      s.stop("Seeding failed — run `pnpm cms:seed` manually");
      if (err.stderr) console.error(err.stderr.toString());
      if (err.stdout) console.error(err.stdout.toString());
    }
  } else if (seedDemo && target === "cloudflare") {
    p.note(
      [
        "Seeding for Cloudflare requires a D1 database.",
        "",
        `  ${pm.dlx} wrangler d1 create ${projectName}-db`,
        "  # then replace the placeholder database_id in wrangler.toml",
        `  ${pm.dlx} wrangler d1 migrations apply ${projectName}-db --local`,
        `  ${pm.run} cms:seed`,
      ].join("\n"),
      "Seed manually",
    );
  }

  // --- Cloudflare resource setup ---

  const cf = {
    d1Created: false,
    r2Created: false,
    migrationsApplied: false,
    deployed: false,
    url: null,
  };
  if (target === "cloudflare") {
    const setupNow = await p.confirm({
      message:
        "Set up Cloudflare resources now? (creates D1 database and R2 bucket)",
      initialValue: true,
    });

    if (!p.isCancel(setupNow) && setupNow) {
      // Check wrangler authentication
      let authenticated = false;
      try {
        execSync(`${pm.exec} wrangler whoami`, {
          cwd: projectDir,
          stdio: "pipe",
        });
        authenticated = true;
      } catch {
        p.note(
          "You need to log in to Cloudflare first.",
          "Wrangler login required",
        );
        const doLogin = await p.confirm({
          message: "Open browser to log in?",
          initialValue: true,
        });
        if (!p.isCancel(doLogin) && doLogin) {
          try {
            execSync(`${pm.exec} wrangler login`, {
              cwd: projectDir,
              stdio: "inherit",
            });
            authenticated = true;
          } catch {
            s.stop("Login failed");
          }
        }
      }

      if (authenticated) {
        // Create D1 database
        let databaseId = null;
        s.start("Creating D1 database");
        try {
          const output = execSync(
            `${pm.exec} wrangler d1 create ${projectName}-db`,
            {
              cwd: projectDir,
              stdio: "pipe",
            },
          ).toString();
          const match = output.match(/database_id\s*=\s*"([^"]+)"/);
          if (match) {
            databaseId = match[1];
            cf.d1Created = true;
            s.stop("D1 database created");
          } else {
            // Created but the id couldn't be parsed from wrangler's output —
            // don't mark as done, so the summary tells the user to wire it up.
            s.stop(
              "D1 database created, but its id could not be read — copy the database_id to wrangler.toml manually",
            );
          }
        } catch (err) {
          // Already exists — look it up
          try {
            const listOutput = execSync(`${pm.exec} wrangler d1 list`, {
              cwd: projectDir,
              stdio: "pipe",
            }).toString();
            const lines = listOutput.split("\n");
            const dbLine = lines.find((l) => l.includes(`${projectName}-db`));
            if (dbLine) {
              const idMatch = dbLine.match(
                /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
              );
              if (idMatch) databaseId = idMatch[0];
            }
            if (databaseId) {
              cf.d1Created = true;
              s.stop("D1 database already exists — using existing");
            } else {
              s.stop("D1 setup failed");
              if (err.stderr) console.error(err.stderr.toString());
            }
          } catch {
            s.stop("D1 setup failed");
          }
        }

        // Update wrangler.toml with database_id
        if (databaseId) {
          const wranglerPath = path.join(projectDir, "wrangler.toml");
          let wranglerContent = readFileSync(wranglerPath, "utf-8");
          wranglerContent = wranglerContent.replace(
            /database_id = "[^"]*"[^\n]*/,
            `database_id = "${databaseId}"`,
          );
          writeFileSync(wranglerPath, wranglerContent);
        }

        // Create R2 bucket
        s.start("Creating R2 bucket");
        try {
          execSync(
            `${pm.exec} wrangler r2 bucket create ${projectName}-assets`,
            { cwd: projectDir, stdio: "pipe" },
          );
          cf.r2Created = true;
          s.stop("R2 bucket created");
        } catch {
          cf.r2Created = true;
          s.stop("R2 bucket already exists");
        }

        // Generate migrations and apply to remote D1
        if (databaseId) {
          s.start("Generating database migrations");
          try {
            execSync(`${pm.exec} drizzle-kit generate`, {
              cwd: projectDir,
              stdio: "pipe",
            });
            s.stop("Migrations generated");
          } catch (err) {
            s.stop("Migration generation failed");
            if (err.stderr) console.error(err.stderr.toString().slice(-800));
            if (err.stdout) console.error(err.stdout.toString().slice(-800));
          }

          s.start("Applying migrations to remote D1");
          try {
            execSync(
              `${pm.exec} wrangler d1 migrations apply ${projectName}-db --remote`,
              {
                cwd: projectDir,
                stdio: "pipe",
                input: "y\n",
              },
            );
            cf.migrationsApplied = true;
            s.stop("Migrations applied");
          } catch {
            s.stop(
              "Migration apply failed — run manually with: wrangler d1 migrations apply --remote",
            );
          }
        }

        // Deploy to Cloudflare
        if (cf.migrationsApplied) {
          const doDeploy = await p.confirm({
            message: "Deploy to Cloudflare now?",
            initialValue: true,
          });
          if (!p.isCancel(doDeploy) && doDeploy) {
            s.start("Building and deploying to Cloudflare");
            try {
              const deployOutput = await runAsync(
                `${pm.run} run deploy`,
                projectDir,
              );
              const urlMatch = deployOutput.match(
                /https:\/\/[^\s]+\.workers\.dev/,
              );
              if (urlMatch) cf.url = urlMatch[0];
              cf.deployed = true;
              s.stop("Deployed to Cloudflare");
            } catch (err) {
              s.stop("Deploy failed — run manually with: pnpm run deploy");
              if (err.stderr) console.error(err.stderr.slice(-1500));
              if (err.stdout) console.error(err.stdout.slice(-1500));
            }
          }
        }
      }
    }
  }

  // --- Done ---

  if (target === "local") {
    const startDev = await p.confirm({
      message: "Start the dev server now?",
      initialValue: true,
    });

    if (!p.isCancel(startDev) && startDev) {
      p.outro("Starting dev server...");
      try {
        execSync(`${pm.run} dev`, { cwd: projectDir, stdio: "inherit" });
      } catch {
        console.log(`\n  Project directory: ${projectDir}`);
        console.log(`  To start again:   cd ${projectName} && pnpm dev\n`);
      }
    } else {
      p.note(
        [`cd ${projectName}`, "", `${pm.run} dev`].join("\n"),
        "Next steps",
      );
      p.outro("Project created!");
    }
  } else {
    if (cf.deployed && cf.url) {
      p.note(
        [
          `Live at: ${cf.url}`,
          `Admin:   ${cf.url}/admin`,
          "",
          `cd ${projectName}`,
          "",
          "Local development:",
          `  ${pm.run} dev`,
          "",
          "Redeploy:",
          "  pnpm run deploy",
        ].join("\n"),
        "🎉 Your Kide CMS is live",
      );
      p.outro("Project created!");
    } else {
      const lines = [`cd ${projectName}`];
      const remaining = [];
      if (!cf.d1Created) {
        remaining.push(
          `  ${pm.dlx} wrangler d1 create ${projectName}-db`,
          "  # then replace the placeholder database_id in wrangler.toml",
        );
      }
      if (!cf.r2Created) {
        remaining.push(
          `  ${pm.dlx} wrangler r2 bucket create ${projectName}-assets`,
        );
      }
      if (!cf.migrationsApplied) {
        remaining.push(
          `  ${pm.dlx} wrangler d1 migrations apply ${projectName}-db --remote`,
        );
      }
      if (!cf.deployed) {
        remaining.push(`  ${pm.run} run deploy`);
      }
      if (remaining.length > 0) {
        lines.push("", "Remaining setup:", ...remaining);
      }
      lines.push("", "Local development:", `  ${pm.run} dev`);
      p.note(lines.join("\n"), "Next steps");
      p.outro("Project created!");
    }
  }
}

main().catch((err) => {
  p.cancel(err.message);
  process.exit(1);
});
