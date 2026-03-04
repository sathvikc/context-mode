#!/usr/bin/env node
/**
 * context-mode CLI
 *
 * Usage:
 *   context-mode          → Start MCP server (stdio)
 *   context-mode setup    → Interactive setup (detect runtimes, install Bun)
 *   context-mode doctor   → Diagnose runtime issues, hooks, FTS5, version
 *   context-mode upgrade  → Fix hooks, permissions, and settings
 *   context-mode stats    → (skill only — /context-mode:ctx-stats)
 */

import * as p from "@clack/prompts";
import color from "picocolors";
import { execSync } from "node:child_process";
import { readFileSync, cpSync, accessSync, readdirSync, rmSync, constants } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectRuntimes,
  getRuntimeSummary,
  hasBunRuntime,
  getAvailableLanguages,
} from "./runtime.js";

// ── Adapter imports ──────────────────────────────────────
import {
  readSettings,
  getSettingsPath,
  backupSettings,
  configureHook,
  validateHooks,
  checkPluginRegistration,
  getMarketplaceVersion,
  updatePluginRegistry,
  setHookPermissions,
  writeSettings,
} from "./adapters/claude-code/config.js";
import { HOOK_TYPES } from "./adapters/claude-code/hooks.js";

const args = process.argv.slice(2);

if (args[0] === "setup") {
  setup();
} else if (args[0] === "doctor") {
  doctor().then((code) => process.exit(code));
} else if (args[0] === "upgrade") {
  upgrade();
} else {
  // Default: start MCP server
  import("./server.js");
}

/* -------------------------------------------------------
 * Shared helpers
 * ------------------------------------------------------- */

/** Normalize Windows backslash paths to forward slashes for Bash (MSYS2) compatibility. */
export function toUnixPath(p: string): string {
  return p.replace(/\\/g, "/");
}

function getPluginRoot(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  return resolve(__dirname, "..");
}

function getLocalVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(getPluginRoot(), "package.json"), "utf-8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function fetchLatestVersion(): Promise<string> {
  try {
    const resp = await fetch("https://registry.npmjs.org/context-mode/latest");
    if (!resp.ok) return "unknown";
    const data = (await resp.json()) as { version?: string };
    return data.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function semverGt(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
  }
  return false;
}

/* -------------------------------------------------------
 * Doctor
 * ------------------------------------------------------- */

async function doctor(): Promise<number> {
  if (process.stdout.isTTY) console.clear();

  p.intro(color.bgMagenta(color.white(" context-mode doctor ")));

  let criticalFails = 0;

  const s = p.spinner();
  s.start("Running diagnostics");

  let runtimes: ReturnType<typeof detectRuntimes>;
  let available: string[];
  try {
    runtimes = detectRuntimes();
    available = getAvailableLanguages(runtimes);
  } catch {
    s.stop("Diagnostics partial");
    p.log.warn(color.yellow("Could not detect runtimes") + color.dim(" — module may be missing, restart session after upgrade"));
    p.outro(color.yellow("Doctor could not fully run — try again after restarting Claude Code"));
    return 1;
  }

  s.stop("Diagnostics complete");

  // Runtime check
  p.note(getRuntimeSummary(runtimes), "Runtimes");

  // Speed tier
  if (hasBunRuntime()) {
    p.log.success(
      color.green("Performance: FAST") +
        " — Bun detected for JS/TS execution",
    );
  } else {
    p.log.warn(
      color.yellow("Performance: NORMAL") +
        " — Using Node.js (install Bun for 3-5x speed boost)",
    );
  }

  // Language coverage
  const total = 11;
  const pct = ((available.length / total) * 100).toFixed(0);
  if (available.length < 2) {
    criticalFails++;
    p.log.error(
      color.red(`Language coverage: ${available.length}/${total} (${pct}%)`) +
        " — too few runtimes detected" +
        color.dim(` — ${available.join(", ") || "none"}`),
    );
  } else {
    p.log.info(
      `Language coverage: ${available.length}/${total} (${pct}%)` +
        color.dim(` — ${available.join(", ")}`),
    );
  }

  // Server test
  p.log.step("Testing server initialization...");
  try {
    const { PolyglotExecutor } = await import("./executor.js");
    const executor = new PolyglotExecutor({ runtimes });
    const result = await executor.execute({
      language: "javascript",
      code: 'console.log("ok");',
      timeout: 5000,
    });
    if (result.exitCode === 0 && result.stdout.trim() === "ok") {
      p.log.success(color.green("Server test: PASS"));
    } else {
      criticalFails++;
      p.log.error(
        color.red("Server test: FAIL") + ` — exit ${result.exitCode}`,
      );
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Cannot find module") || message.includes("MODULE_NOT_FOUND")) {
      p.log.warn(color.yellow("Server test: SKIP") + color.dim(" — module not available (restart session after upgrade)"));
    } else {
      criticalFails++;
      p.log.error(color.red("Server test: FAIL") + ` — ${message}`);
    }
  }

  // Hooks installed — using adapter validation
  p.log.step("Checking hooks configuration...");
  const pluginRoot = getPluginRoot();
  const hookResults = validateHooks(pluginRoot);

  for (const result of hookResults) {
    if (result.status === "pass") {
      p.log.success(color.green(`${result.hookType} hook: PASS`) + ` — ${result.message}`);
    } else {
      p.log.error(
        color.red(`${result.hookType} hook: FAIL`) +
          ` — ${result.message}` +
          color.dim("\n  Run: npx context-mode upgrade"),
      );
    }
  }

  // Hook script exists
  p.log.step("Checking hook script...");
  const hookScriptPath = resolve(pluginRoot, "hooks", "pretooluse.mjs");
  try {
    accessSync(hookScriptPath, constants.R_OK);
    p.log.success(color.green("Hook script exists: PASS") + color.dim(` — ${hookScriptPath}`));
  } catch {
    p.log.error(
      color.red("Hook script exists: FAIL") +
        color.dim(` — not found at ${hookScriptPath}`),
    );
  }

  // Plugin enabled — using adapter check
  p.log.step("Checking plugin registration...");
  const pluginCheck = checkPluginRegistration();
  if (pluginCheck.status === "pass") {
    p.log.success(color.green("Plugin enabled: PASS") + color.dim(` — ${pluginCheck.pluginKey}`));
  } else {
    p.log.warn(
      color.yellow("Plugin enabled: WARN") +
        ` — ${pluginCheck.message}`,
    );
  }

  // FTS5 / better-sqlite3
  p.log.step("Checking FTS5 / better-sqlite3...");
  try {
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(":memory:");
    db.exec("CREATE VIRTUAL TABLE fts_test USING fts5(content)");
    db.exec("INSERT INTO fts_test(content) VALUES ('hello world')");
    const row = db.prepare("SELECT * FROM fts_test WHERE fts_test MATCH 'hello'").get() as { content: string } | undefined;
    db.close();
    if (row && row.content === "hello world") {
      p.log.success(color.green("FTS5 / better-sqlite3: PASS") + " — native module works");
    } else {
      criticalFails++;
      p.log.error(color.red("FTS5 / better-sqlite3: FAIL") + " — query returned unexpected result");
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Cannot find module") || message.includes("MODULE_NOT_FOUND")) {
      p.log.warn(color.yellow("FTS5 / better-sqlite3: SKIP") + color.dim(" — module not available (restart session after upgrade)"));
    } else {
      criticalFails++;
      p.log.error(
        color.red("FTS5 / better-sqlite3: FAIL") +
          ` — ${message}` +
          color.dim("\n  Try: npm rebuild better-sqlite3"),
      );
    }
  }

  // Version check
  p.log.step("Checking versions...");
  const localVersion = getLocalVersion();
  const latestVersion = await fetchLatestVersion();
  const marketplaceVersion = getMarketplaceVersion();

  // npm / MCP version
  if (latestVersion === "unknown") {
    p.log.warn(
      color.yellow("npm (MCP): WARN") +
        ` — local v${localVersion}, could not reach npm registry`,
    );
  } else if (localVersion === latestVersion) {
    p.log.success(
      color.green("npm (MCP): PASS") +
        ` — v${localVersion}`,
    );
  } else {
    p.log.warn(
      color.yellow("npm (MCP): WARN") +
        ` — local v${localVersion}, latest v${latestVersion}` +
        color.dim("\n  Run: /context-mode:ctx-upgrade"),
    );
  }

  // Marketplace version
  if (marketplaceVersion === "not installed") {
    p.log.info(
      color.dim("Marketplace: not installed") +
        " — using standalone MCP mode",
    );
  } else if (latestVersion !== "unknown" && marketplaceVersion === latestVersion) {
    p.log.success(
      color.green("Marketplace: PASS") +
        ` — v${marketplaceVersion}`,
    );
  } else if (latestVersion !== "unknown") {
    p.log.warn(
      color.yellow("Marketplace: WARN") +
        ` — v${marketplaceVersion}, latest v${latestVersion}` +
        color.dim("\n  Run: /context-mode:ctx-upgrade"),
    );
  } else {
    p.log.info(
      `Marketplace: v${marketplaceVersion}` +
        color.dim(" — could not verify against npm registry"),
    );
  }

  // Summary
  if (criticalFails > 0) {
    p.outro(
      color.red(`Diagnostics failed — ${criticalFails} critical issue(s) found`),
    );
    return 1;
  }

  p.outro(
    available.length >= 4
      ? color.green("Diagnostics complete!")
      : color.yellow("Some checks need attention — see above for details"),
  );
  return 0;
}

/* -------------------------------------------------------
 * Upgrade
 * ------------------------------------------------------- */

async function upgrade() {
  if (process.stdout.isTTY) console.clear();

  p.intro(color.bgCyan(color.black(" context-mode upgrade ")));

  let pluginRoot = getPluginRoot();
  const changes: string[] = [];
  const s = p.spinner();

  // Step 1: Pull latest from GitHub (same source as marketplace)
  p.log.step("Pulling latest from GitHub...");
  const localVersion = getLocalVersion();
  const tmpDir = `/tmp/context-mode-upgrade-${Date.now()}`;

  s.start("Cloning mksglu/claude-context-mode");
  try {
    execSync(
      `git clone --depth 1 https://github.com/mksglu/claude-context-mode.git "${tmpDir}"`,
      { stdio: "pipe", timeout: 30000 },
    );
    s.stop("Downloaded");

    const srcDir = tmpDir;

    // Read new version
    const newPkg = JSON.parse(
      readFileSync(resolve(srcDir, "package.json"), "utf-8"),
    );
    const newVersion = newPkg.version ?? "unknown";

    if (newVersion === localVersion) {
      p.log.success(color.green("Already on latest") + ` — v${localVersion}`);
    } else {
      p.log.info(
        `Update available: ${color.yellow("v" + localVersion)} → ${color.green("v" + newVersion)}`,
      );
    }

    // Step 2: Install dependencies + build
    s.start("Installing dependencies & building");
    execSync("npm install --no-audit --no-fund", {
      cwd: srcDir,
      stdio: "pipe",
      timeout: 60000,
    });
    execSync("npm run build", {
      cwd: srcDir,
      stdio: "pipe",
      timeout: 30000,
    });
    s.stop("Built successfully");

    // Step 3: Update in-place (same directory, no registry changes needed)
    s.start("Updating files in-place");

    // Clean stale version dirs from previous upgrade attempts
    const cacheParentMatch = pluginRoot.match(
      /^(.*[\\/]plugins[\\/]cache[\\/][^\\/]+[\\/][^\\/]+[\\/])/,
    );
    if (cacheParentMatch) {
      const cacheParent = cacheParentMatch[1];
      const myDir = pluginRoot.replace(cacheParent, "").replace(/[\\/]/g, "");
      try {
        const oldDirs = readdirSync(cacheParent).filter(d => d !== myDir);
        for (const d of oldDirs) {
          try { rmSync(resolve(cacheParent, d), { recursive: true, force: true }); } catch { /* skip */ }
        }
        if (oldDirs.length > 0) {
          p.log.info(color.dim(`  Cleaned ${oldDirs.length} stale cache dir(s)`));
        }
      } catch { /* parent may not exist */ }
    }

    // Copy new files over old ones — same path, no registry update needed
    const items = [
      "build", "src", "hooks", "skills", ".claude-plugin",
      "start.mjs", "server.bundle.mjs", "package.json", ".mcp.json",
    ];
    for (const item of items) {
      try {
        rmSync(resolve(pluginRoot, item), { recursive: true, force: true });
        cpSync(resolve(srcDir, item), resolve(pluginRoot, item), { recursive: true });
      } catch { /* some files may not exist in source */ }
    }
    s.stop(color.green(`Updated in-place to v${newVersion}`));

    // Fix registry — using adapter
    updatePluginRegistry(pluginRoot, newVersion);
    p.log.info(color.dim("  Registry synced to " + pluginRoot));

    // Install production deps (rebuild native modules if needed)
    s.start("Installing production dependencies");
    execSync("npm install --production --no-audit --no-fund", {
      cwd: pluginRoot,
      stdio: "pipe",
      timeout: 60000,
    });
    s.stop("Dependencies ready");

    // Update global npm package from same GitHub source
    s.start("Updating npm global package");
    try {
      execSync(`npm install -g "${pluginRoot}" --no-audit --no-fund 2>/dev/null`, {
        stdio: "pipe",
        timeout: 30000,
      });
      s.stop(color.green("npm global updated"));
      changes.push("Updated npm global package");
    } catch {
      s.stop(color.yellow("npm global update skipped"));
      p.log.info(color.dim("  Could not update global npm — may need sudo or standalone install"));
    }

    // Cleanup
    rmSync(tmpDir, { recursive: true, force: true });

    changes.push(
      newVersion !== localVersion
        ? `Updated v${localVersion} → v${newVersion}`
        : `Reinstalled v${localVersion} from GitHub`,
    );
    p.log.success(
      color.green("Plugin reinstalled from GitHub!") +
        color.dim(` — v${newVersion}`),
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    s.stop(color.red("Update failed"));
    p.log.error(color.red("GitHub pull failed") + ` — ${message}`);
    p.log.info(color.dim("Continuing with hooks/settings fix..."));
    // Cleanup on failure
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // Step 3: Backup settings.json — using adapter
  p.log.step("Backing up settings.json...");
  const backupPath = backupSettings();
  if (backupPath) {
    p.log.success(color.green("Backup created") + color.dim(" -> " + backupPath));
    changes.push("Backed up settings.json");
  } else {
    p.log.warn(
      color.yellow("No existing settings.json to backup") +
        " — a new one will be created",
    );
  }

  // Step 4: Fix hooks — using adapter
  p.log.step("Configuring hooks...");
  const settings = readSettings() ?? {};

  const hookTypes = [
    HOOK_TYPES.PRE_TOOL_USE,
    HOOK_TYPES.SESSION_START,
  ] as const;

  for (const hookType of hookTypes) {
    const result = configureHook(settings, hookType, pluginRoot);
    p.log.info(color.dim(`  ${result}`));
    changes.push(result);
  }

  // Write updated settings — using adapter
  try {
    writeSettings(settings);
    p.log.success(color.green("Hooks configured") + color.dim(" -> " + getSettingsPath()));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    p.log.error(color.red("Failed to write settings.json") + " — " + message);
    p.outro(color.red("Upgrade failed."));
    process.exit(1);
  }

  // Step 5: Set hook script permissions — using adapter
  p.log.step("Setting hook script permissions...");
  const permSet = setHookPermissions(pluginRoot);
  if (permSet.length > 0) {
    p.log.success(color.green("Permissions set") + color.dim(` — ${permSet.length} hook script(s)`));
    changes.push(`Set ${permSet.length} hook scripts as executable`);
  } else {
    p.log.error(
      color.red("No hook scripts found") +
        color.dim(" — expected in " + resolve(pluginRoot, "hooks")),
    );
  }

  // Step 6: Report
  if (changes.length > 0) {
    p.note(
      changes.map((c) => color.green("  + ") + c).join("\n"),
      "Changes Applied",
    );
  } else {
    p.log.info(color.dim("No changes were needed."));
  }

  // Step 7: Run doctor from updated pluginRoot
  p.log.step("Running doctor to verify...");
  console.log();

  try {
    execSync(`node "${resolve(pluginRoot, "build", "cli.js")}" doctor`, {
      stdio: "inherit",
      timeout: 30000,
      cwd: pluginRoot,
    });
  } catch {
    p.log.warn(
      color.yellow("Doctor had warnings") +
        color.dim(" — restart your Claude Code session to pick up the new version"),
    );
  }
}

/* -------------------------------------------------------
 * Setup
 * ------------------------------------------------------- */

async function setup() {
  if (process.stdout.isTTY) console.clear();

  p.intro(color.bgCyan(color.black(" context-mode setup ")));

  const s = p.spinner();

  // Step 1: Detect runtimes
  s.start("Detecting installed runtimes");
  const runtimes = detectRuntimes();
  const available = getAvailableLanguages(runtimes);
  s.stop("Detected " + available.length + " languages");

  // Show what's available
  p.note(getRuntimeSummary(runtimes), "Detected Runtimes");

  // Step 2: Check Bun
  if (!hasBunRuntime()) {
    p.log.warn(
      color.yellow("Bun is not installed.") +
        " JS/TS will run with Node.js (3-5x slower).",
    );

    const installBun = await p.confirm({
      message: "Would you like to install Bun for faster execution?",
      initialValue: true,
    });

    if (p.isCancel(installBun)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }

    if (installBun) {
      s.start("Installing Bun");
      try {
        execSync("curl -fsSL https://bun.sh/install | bash", {
          stdio: "pipe",
          timeout: 60000,
        });
        s.stop(color.green("Bun installed successfully!"));

        // Re-detect runtimes
        const newRuntimes = detectRuntimes();
        if (hasBunRuntime()) {
          p.log.success(
            "JavaScript and TypeScript will now use Bun " +
              color.dim("(3-5x faster)"),
          );
        }
        p.note(getRuntimeSummary(newRuntimes), "Updated Runtimes");
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : String(err);
        s.stop(color.red("Failed to install Bun"));
        p.log.error(
          "Installation failed: " +
            message +
            "\nYou can install manually: curl -fsSL https://bun.sh/install | bash",
        );
        p.log.info(
          color.dim("Continuing with Node.js — everything will still work."),
        );
      }
    } else {
      p.log.info(
        color.dim(
          "No problem! Using Node.js. You can install Bun later: curl -fsSL https://bun.sh/install | bash",
        ),
      );
    }
  } else {
    p.log.success(
      color.green("Bun detected!") +
        " JS/TS will run at maximum speed.",
    );
  }

  // Step 3: Check optional runtimes
  const missing: string[] = [];
  if (!runtimes.python) missing.push("Python (python3)");
  if (!runtimes.ruby) missing.push("Ruby (ruby)");
  if (!runtimes.go) missing.push("Go (go)");
  if (!runtimes.php) missing.push("PHP (php)");
  if (!runtimes.r) missing.push("R (Rscript)");

  if (missing.length > 0) {
    p.log.info(
      color.dim("Optional runtimes not found: " + missing.join(", ")),
    );
    p.log.info(
      color.dim(
        "Install them to enable additional language support in context-mode.",
      ),
    );
  }

  // Step 4: Installation instructions
  const installMethod = await p.select({
    message: "How would you like to configure context-mode?",
    options: [
      {
        value: "claude-code",
        label: "Claude Code (recommended)",
        hint: "claude mcp add",
      },
      {
        value: "manual",
        label: "Show manual configuration",
        hint: ".mcp.json",
      },
      { value: "skip", label: "Skip — I'll configure later" },
    ],
  });

  if (p.isCancel(installMethod)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const serverPath = new URL("./server.js", import.meta.url).pathname;

  if (installMethod === "claude-code") {
    s.start("Adding to Claude Code");
    try {
      execSync(
        `claude mcp add context-mode -- node ${serverPath}`,
        { stdio: "pipe", timeout: 10000 },
      );
      s.stop(color.green("Added to Claude Code!"));
    } catch {
      s.stop(color.yellow("Could not add automatically"));
      p.log.info(
        "Run manually:\n" +
          color.cyan(`  claude mcp add context-mode -- node ${serverPath}`),
      );
    }
  } else if (installMethod === "manual") {
    p.note(
      JSON.stringify(
        {
          mcpServers: {
            "context-mode": {
              command: "node",
              args: [serverPath],
            },
          },
        },
        null,
        2,
      ),
      "Add to your .mcp.json or Claude Code settings",
    );
  }

  p.outro(
    color.green("Setup complete!") +
      " " +
      color.dim(available.length + " languages ready."),
  );
}
