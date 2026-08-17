#!/usr/bin/env node

import * as p from "@clack/prompts";
import { execSync, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  readdirSync,
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

// Argv-based variant: no shell, so untrusted values (like the project directory)
// are passed as single arguments and can never be reinterpreted as commands.
const runFileAsync = (file, args, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else {
        const err = new Error(`Command failed: ${file} ${args.join(" ")}`);
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

// Overridable for forks and for testing against a local checkout
// (e.g. KIDE_TEMPLATE_REPO=file:///path/to/kide-cms).
const REPO =
  process.env.KIDE_TEMPLATE_REPO ||
  "https://github.com/mhernesniemi/kide-cms.git";

// Files from the kide-cms repo that shouldn't leak into scaffolded projects.
// NOTE: `.claude/settings.local.json` is removed but `.claude/skills/` is kept,
// so scaffolds ship the /migrate skill alongside AGENTS.md.
const CLEANUP = [
  "docs",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  ".claude/settings.local.json",
  ".github/workflows", // upstream CI + @kidecms/core release pipeline — wrong in any scaffold
  ".github/pull_request_template.md", // Kide's own contribution checklist — wrong in any scaffold
  "scripts/verify-cloudflare.mjs", // needs the adapters/ overlay, which every scaffold deletes
  "scripts/dev-preview.mjs", // needs starters/ (deleted below) and symlinks back into this repo
  "data",
  ".cms-data",
  "dist",
  ".astro",
  ".DS_Store",
];

// Managed runtime dirs inside src/cms — the contents of the @kidecms/core
// package. Deleted in package mode (the npm dependency provides them);
// everything else in src/cms (cms.config, collections, adapters, fields,
// runtime.ts, migrations) is project-owned and stays in both modes.
const MANAGED_DIRS = [
  "admin",
  "client",
  "core",
  "internals",
  "middleware",
  "platform",
  "routes",
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
// the repo has no tags (falls back to the default branch). Async so the
// "Downloading template" spinner keeps animating during the network call.
const resolveLatestTag = async () => {
  try {
    const output = await runFileAsync("git", [
      "ls-remote",
      "--tags",
      "--sort=-v:refname",
      REPO,
      "v*",
    ]);
    for (const line of output.split("\n")) {
      const match = line.match(/refs\/tags\/(v[0-9][^^\s]*)$/);
      if (match) return match[1];
    }
  } catch {
    // Network/git hiccup — fall back to default branch
  }
  return null;
};

// --- CLI flags (non-interactive use: CI, agents, testing) ---
// Any prompt whose answer is supplied by a flag is skipped. Example:
//   create-kide-app my-app --starter=marketing --seed --mode=embedded --target=local --no-github --no-dev

const parseArgs = (argv) => {
  const flags = {};
  const positional = [];
  for (const arg of argv) {
    if (arg === "--seed") flags.seed = true;
    else if (arg === "--no-seed") flags.seed = false;
    else if (arg === "--no-github") flags.noGithub = true;
    else if (arg === "--no-dev") flags.noDev = true;
    else if (arg === "--no-cloudflare-setup") flags.noCloudflareSetup = true;
    else if (arg.startsWith("--starter=")) flags.starter = arg.slice("--starter=".length);
    else if (arg.startsWith("--mode=")) flags.mode = arg.slice("--mode=".length);
    else if (arg.startsWith("--target=")) flags.target = arg.slice("--target=".length);
    else if (arg.startsWith("--")) flags.unknown = arg;
    else positional.push(arg);
  }
  return { flags, positional };
};

// --- Main ---

async function main() {
  p.intro("🪐 Create Kide CMS Project");

  const { flags, positional } = parseArgs(process.argv.slice(2));
  if (flags.unknown) {
    p.cancel(`Unknown flag: ${flags.unknown}`);
    process.exit(1);
  }
  if (flags.mode !== undefined && !["package", "embedded"].includes(flags.mode)) {
    p.cancel(`--mode must be "package" or "embedded".`);
    process.exit(1);
  }
  if (flags.target !== undefined && !["local", "cloudflare"].includes(flags.target)) {
    p.cancel(`--target must be "local" or "cloudflare".`);
    process.exit(1);
  }

  // 1. Project name
  const projectName =
    positional[0] ||
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

  const s = p.spinner();

  // --- Scaffold via git clone ---
  // The clone happens before the remaining prompts so the starter list can be
  // read from the cloned tag — new starters ship with template releases, no CLI
  // release needed.

  s.start("Downloading template");

  const templateRef = await resolveLatestTag();
  let templateCommit = null;

  try {
    const branchArgs = templateRef ? ["--branch", templateRef] : [];
    await runFileAsync("git", ["clone", "--depth", "1", ...branchArgs, REPO, projectDir]);
    try {
      templateCommit = (await runFileAsync("git", ["rev-parse", "HEAD"], projectDir)).trim();
    } catch {
      // best-effort — stamp without a commit hash
    }
    rmSync(path.join(projectDir, ".git"), { recursive: true, force: true });
  } catch {
    rmSync(projectDir, { recursive: true, force: true });
    s.stop("Failed to download template.");
    p.cancel("Check your network connection.");
    process.exit(1);
  }

  // Remove files that shouldn't be in the scaffold
  for (const f of CLEANUP) {
    rmSync(path.join(projectDir, f), { recursive: true, force: true });
  }

  s.stop(templateRef ? `Template ready (${templateRef})` : "Template ready");

  // From here on the clone exists, so a cancelled prompt must remove it.
  const cancelSetup = (message = "Setup cancelled.") => {
    rmSync(projectDir, { recursive: true, force: true });
    p.cancel(message);
    process.exit(0);
  };

  // 2. Starter template — options come from starters/*/starter.json in the
  // cloned tag. Older tags have no starters/ dir; the prompt is skipped and the
  // scaffold stays blank.
  const startersDir = path.join(projectDir, "starters");
  const starterOptions = [];
  if (existsSync(startersDir)) {
    for (const entry of readdirSync(startersDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(startersDir, entry.name, "starter.json");
      if (!existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
        starterOptions.push({
          label: manifest.label ?? entry.name,
          value: entry.name,
          hint: manifest.hint,
          order: manifest.order ?? 100,
        });
      } catch {
        // unreadable manifest — skip this starter
      }
    }
    starterOptions.sort((a, b) => a.order - b.order);
  }

  let starter = null;
  if (flags.starter !== undefined) {
    if (flags.starter !== "blank") {
      if (!starterOptions.some((option) => option.value === flags.starter)) {
        cancelSetup(
          `Unknown starter "${flags.starter}". Available: blank${starterOptions.map((o) => `, ${o.value}`).join("")}`,
        );
      }
      starter = flags.starter;
    }
  } else if (starterOptions.length > 0) {
    const choice = await p.select({
      message: "Starter template",
      options: [
        { label: "Blank", value: null, hint: "empty schema, no demo content" },
        ...starterOptions.map(({ label, value, hint }) => ({
          label,
          value,
          hint,
        })),
      ],
    });
    if (p.isCancel(choice)) cancelSetup();
    starter = choice;
  }

  // 3. Distribution mode — package is the recommended default; embedded stays
  // first-class for teams that want to own and modify the runtime source.
  const mode =
    flags.mode ??
    (await p.select({
      message: "How do you want the CMS runtime?",
      options: [
        {
          label: "Package",
          value: "package",
          hint: "@kidecms/core dependency",
        },
        {
          label: "Embedded",
          value: "embedded",
          hint: "full CMS source in src/cms/, yours to modify",
        },
      ],
    }));

  if (p.isCancel(mode)) cancelSetup();

  // 4. Deploy target
  const target =
    flags.target ??
    (await p.select({
      message: "Where will you deploy?",
      options: [
        { label: "Local / Node.js", value: "local" },
        { label: "Cloudflare", value: "cloudflare" },
      ],
    }));

  if (p.isCancel(target)) cancelSetup();

  // Seeding runs at scaffold time and needs the local db adapter — the
  // Cloudflare adapter needs Worker bindings, so the question is local-only.
  let seedRequested = false;
  if (starter && target === "local") {
    if (flags.seed !== undefined) {
      seedRequested = flags.seed;
    } else {
      const seedChoice = await p.confirm({
        message: "Seed example content?",
        initialValue: true,
      });
      if (p.isCancel(seedChoice)) cancelSetup();
      seedRequested = seedChoice;
    }
  }

  // The npm artifact publishes after the template tag (CI runs the release gate
  // first) — a package-mode scaffold in that window would fail install with a
  // missing version. Fail early with a clear message instead.
  if (mode === "package") {
    const clonedCorePkg = path.join(projectDir, "src/cms/package.json");
    const clonedCoreVersion = existsSync(clonedCorePkg)
      ? JSON.parse(readFileSync(clonedCorePkg, "utf-8")).version
      : null;
    if (clonedCoreVersion) {
      try {
        execSync(`npm view @kidecms/core@${clonedCoreVersion} version`, {
          stdio: "pipe",
        });
      } catch {
        cancelSetup(
          `@kidecms/core@${clonedCoreVersion} is not on npm yet — if this release was just tagged, publishing may still be running. Retry in a few minutes, or choose Embedded mode.`,
        );
      }
    }
  }

  s.start(`Configuring project (using ${pm.name})`);

  // Apply the starter overlay — project-owned files copied over the barebone
  // base. starter.json is manifest metadata, not project content.
  if (starter) {
    cpSync(path.join(startersDir, starter), projectDir, { recursive: true });
    rmSync(path.join(projectDir, "starter.json"), { force: true });
  }
  rmSync(startersDir, { recursive: true, force: true });

  // Both modes scaffold the same template at the same tag; package mode then
  // deletes the managed runtime dirs and swaps the workspace link for the
  // published @kidecms/core at exactly that version — same source either way.
  const corePkgPath = path.join(projectDir, "src/cms/package.json");
  let coreVersion = null;
  if (existsSync(corePkgPath)) {
    coreVersion = JSON.parse(readFileSync(corePkgPath, "utf-8")).version;
  }

  if (mode === "package") {
    if (!coreVersion) {
      s.stop("Scaffolding failed");
      p.cancel(
        "This template release predates package mode — choose Embedded, or wait for the next release.",
      );
      process.exit(1);
    }
    for (const managed of MANAGED_DIRS) {
      rmSync(path.join(projectDir, "src/cms", managed), {
        recursive: true,
        force: true,
      });
    }
    rmSync(corePkgPath, { force: true });
    rmSync(path.join(projectDir, "pnpm-workspace.yaml"), { force: true });
    // Upstream distribution tooling that assumes the embedded workspace package.
    rmSync(path.join(projectDir, "scripts/verify-pack.mjs"), { force: true });
    rmSync(path.join(projectDir, "scripts/verify-package-mode.mjs"), {
      force: true,
    });
    // Worker tests and the Cloudflare type profile live in the deleted
    // src/cms/platform — their configs would match zero files.
    rmSync(path.join(projectDir, "vitest.workers.config.ts"), { force: true });
    rmSync(path.join(projectDir, "tsconfig.cloudflare.json"), { force: true });
  }

  s.stop(
    templateRef
      ? `Project scaffolded from ${templateRef} (${mode})`
      : `Project scaffolded (${mode})`,
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
      'export * from "@kidecms/core/platform/cloudflare/database";\n',
    );
    writeFileSync(
      path.join(projectDir, "src/cms/adapters/storage.ts"),
      'export * from "@kidecms/core/platform/cloudflare/storage";\n',
    );
    // The adapter test asserts Node filesystem storage — meaningless (and failing)
    // once the adapter re-exports the R2 profile.
    rmSync(path.join(projectDir, "src/cms/adapters/__tests__"), {
      recursive: true,
      force: true,
    });
  }

  const pkgPath = path.join(projectDir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

  pkg.name = projectName;

  // Upstream-repo tooling that no scaffold can run (needs the deleted adapters/ overlay).
  delete pkg.scripts["verify:cloudflare"];
  // Needs starters/ (deleted above) and symlinks back into the template repo — repo-only.
  delete pkg.scripts["dev:preview"];

  if (mode === "package" && pkg.dependencies["@kidecms/core"]) {
    pkg.dependencies["@kidecms/core"] = `^${coreVersion}`;
    delete pkg.scripts["verify:pack"];
    delete pkg.scripts["verify:package"];
    // The runtime (and its worker tests + Cloudflare type profile) now lives in
    // node_modules — keep check/test scoped to project code, and let vitest pass
    // until the project has tests of its own.
    delete pkg.scripts["test:workers"];
    delete pkg.scripts["check:cloudflare"];
    pkg.scripts.check = "astro check && eslint .";
    pkg.scripts.test = "pnpm cms:generate && vitest run --passWithNoTests";
    // Upstream test-fixture tooling lives in the deleted core/__tests__ tree.
    delete pkg.scripts["test:fixtures"];
    rmSync(path.join(projectDir, "scripts/generate-test-fixtures.ts"), {
      force: true,
    });
    // Dev tooling for the deleted worker tests / Cloudflare type profile.
    delete pkg.devDependencies["@cloudflare/vitest-pool-workers"];
    delete pkg.devDependencies["@cloudflare/workers-types"];
    delete pkg.devDependencies["jsdom"];
  }

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

    pkg.devDependencies.wrangler = "^4.121.0";

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
    kideVersion: coreVersion ?? pkg.version ?? null,
    ref: templateRef ?? "HEAD",
    commit: templateCommit,
    target,
    mode,
    starter: starter ?? null,
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

    if (ghAvailable && !flags.noGithub) {
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

  // --- Seed starter content (local target only) ---

  if (starter && seedRequested && target === "local") {
    s.start("Seeding example content");
    try {
      await runAsync(`${pm.run} cms:push`, projectDir);
      await runAsync(`${pm.exec} kide seed`, projectDir);
      s.stop("Example content seeded");
    } catch {
      s.stop(
        "Seeding failed — run `pnpm cms:push && pnpm cms:seed` manually",
      );
    }
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
    const setupNow =
      flags.noCloudflareSetup === true
        ? false
        : await p.confirm({
            message:
              "Set up Cloudflare resources now? (creates D1 database and R2 bucket)",
            initialValue: true,
          });

    if (!p.isCancel(setupNow) && setupNow) {
      // A missing wrangler binary (e.g. dependency install failed) must not be
      // misread as "not logged in" — check presence before authentication.
      let wranglerAvailable = false;
      try {
        execSync(`${pm.exec} wrangler --version`, {
          cwd: projectDir,
          stdio: "pipe",
        });
        wranglerAvailable = true;
      } catch {
        p.note(
          "wrangler is not installed — dependency install may have failed.\nRun `pnpm install`, then finish the setup steps listed below.",
          "Wrangler missing",
        );
      }

      // Check wrangler authentication
      let authenticated = false;
      if (wranglerAvailable) {
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
    const startDev = flags.noDev
      ? false
      : await p.confirm({
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
      const liveLines = [
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
      ];
      p.note(liveLines.join("\n"), "🎉 Your Kide CMS is live");
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
