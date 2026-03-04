/**
 * adapters/claude-code/config — Claude Code configuration management.
 *
 * Handles reading/writing ~/.claude/settings.json, hook installation,
 * plugin registration verification, and upgrade operations specific
 * to the Claude Code platform.
 */

import {
  readFileSync,
  writeFileSync,
  copyFileSync,
  accessSync,
  readdirSync,
  chmodSync,
  constants,
} from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { ClaudeCodeAdapter } from "./index.js";
import {
  HOOK_TYPES,
  HOOK_SCRIPTS,
  PRE_TOOL_USE_MATCHER_PATTERN,
  isContextModeHook,
  buildHookCommand,
  type HookType,
} from "./hooks.js";

// ─────────────────────────────────────────────────────────
// Settings management
// ─────────────────────────────────────────────────────────

const adapter = new ClaudeCodeAdapter();

/** Read Claude Code settings from ~/.claude/settings.json. */
export function readSettings(): Record<string, unknown> | null {
  return adapter.readSettings();
}

/** Write Claude Code settings to ~/.claude/settings.json. */
export function writeSettings(settings: Record<string, unknown>): void {
  adapter.writeSettings(settings);
}

/** Get the settings file path. */
export function getSettingsPath(): string {
  return adapter.getSettingsPath();
}

/** Backup settings.json before modifications. Returns backup path or null. */
export function backupSettings(): string | null {
  const settingsPath = adapter.getSettingsPath();
  try {
    accessSync(settingsPath, constants.R_OK);
    const backupPath = settingsPath + ".bak";
    copyFileSync(settingsPath, backupPath);
    return backupPath;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────
// Hook configuration
// ─────────────────────────────────────────────────────────

/**
 * Configure a specific hook type in settings.json.
 * Returns a description of what was done.
 */
export function configureHook(
  settings: Record<string, unknown>,
  hookType: HookType,
  pluginRoot: string,
): string {
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  const command = buildHookCommand(hookType, pluginRoot);

  if (hookType === HOOK_TYPES.PRE_TOOL_USE) {
    // PreToolUse uses a consolidated matcher pattern
    const entry = {
      matcher: PRE_TOOL_USE_MATCHER_PATTERN,
      hooks: [{ type: "command", command }],
    };

    const existing = hooks.PreToolUse as
      | Array<Record<string, unknown>>
      | undefined;

    if (existing && Array.isArray(existing)) {
      const idx = existing.findIndex((e) =>
        isContextModeHook(
          e as { hooks?: Array<{ command?: string }> },
          hookType,
        ),
      );
      if (idx >= 0) {
        existing[idx] = entry;
        hooks.PreToolUse = existing;
        settings.hooks = hooks;
        return `Updated existing ${hookType} hook entry`;
      }
      existing.push(entry);
      hooks.PreToolUse = existing;
      settings.hooks = hooks;
      return `Added ${hookType} hook entry to existing hooks`;
    }

    hooks.PreToolUse = [entry];
    settings.hooks = hooks;
    return `Created ${hookType} hooks section`;
  }

  // All other hook types use empty matcher (match all)
  const entry = {
    matcher: "",
    hooks: [{ type: "command", command }],
  };

  const existing = hooks[hookType] as
    | Array<Record<string, unknown>>
    | undefined;

  if (existing && Array.isArray(existing)) {
    const idx = existing.findIndex((e) =>
      isContextModeHook(
        e as { hooks?: Array<{ command?: string }> },
        hookType,
      ),
    );
    if (idx >= 0) {
      existing[idx] = entry;
      hooks[hookType] = existing;
      settings.hooks = hooks;
      return `Updated existing ${hookType} hook entry`;
    }
    existing.push(entry);
    hooks[hookType] = existing;
    settings.hooks = hooks;
    return `Added ${hookType} hook entry to existing hooks`;
  }

  hooks[hookType] = [entry];
  settings.hooks = hooks;
  return `Created ${hookType} hooks section`;
}

/**
 * Configure all context-mode hooks in settings.json.
 * Returns list of change descriptions.
 */
export function configureAllHooks(
  settings: Record<string, unknown>,
  pluginRoot: string,
): string[] {
  const hookTypes: HookType[] = [
    HOOK_TYPES.PRE_TOOL_USE,
    HOOK_TYPES.POST_TOOL_USE,
    HOOK_TYPES.PRE_COMPACT,
    HOOK_TYPES.SESSION_START,
    HOOK_TYPES.USER_PROMPT_SUBMIT,
  ];

  return hookTypes.map((type) => configureHook(settings, type, pluginRoot));
}

// ─────────────────────────────────────────────────────────
// Hook validation (for doctor command)
// ─────────────────────────────────────────────────────────

export interface HookCheckResult {
  hookType: HookType;
  status: "pass" | "fail" | "warn";
  message: string;
}

/**
 * Validate that all required hooks are properly configured.
 */
export function validateHooks(pluginRoot: string): HookCheckResult[] {
  const results: HookCheckResult[] = [];
  const settings = readSettings();

  if (!settings) {
    results.push({
      hookType: HOOK_TYPES.PRE_TOOL_USE,
      status: "fail",
      message: "Could not read ~/.claude/settings.json",
    });
    return results;
  }

  const hooks = settings.hooks as Record<string, unknown[]> | undefined;

  // Check PreToolUse
  const preToolUse = hooks?.PreToolUse as
    | Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>
    | undefined;
  if (preToolUse && preToolUse.length > 0) {
    const hasHook = preToolUse.some((entry) =>
      isContextModeHook(entry, HOOK_TYPES.PRE_TOOL_USE),
    );
    results.push({
      hookType: HOOK_TYPES.PRE_TOOL_USE,
      status: hasHook ? "pass" : "fail",
      message: hasHook
        ? "PreToolUse hook configured"
        : "PreToolUse exists but does not point to pretooluse.mjs",
    });
  } else {
    results.push({
      hookType: HOOK_TYPES.PRE_TOOL_USE,
      status: "fail",
      message: "No PreToolUse hooks found",
    });
  }

  // Check SessionStart
  const sessionStart = hooks?.SessionStart as
    | Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>
    | undefined;
  if (sessionStart && sessionStart.length > 0) {
    const hasHook = sessionStart.some((entry) =>
      isContextModeHook(entry, HOOK_TYPES.SESSION_START),
    );
    results.push({
      hookType: HOOK_TYPES.SESSION_START,
      status: hasHook ? "pass" : "fail",
      message: hasHook
        ? "SessionStart hook configured"
        : "SessionStart exists but does not point to sessionstart.mjs",
    });
  } else {
    results.push({
      hookType: HOOK_TYPES.SESSION_START,
      status: "fail",
      message: "No SessionStart hooks found",
    });
  }

  return results;
}

// ─────────────────────────────────────────────────────────
// Plugin registration
// ─────────────────────────────────────────────────────────

export interface PluginCheckResult {
  status: "pass" | "warn";
  pluginKey?: string;
  message: string;
}

/** Check if context-mode is registered in enabledPlugins. */
export function checkPluginRegistration(): PluginCheckResult {
  const settings = readSettings();
  if (!settings) {
    return {
      status: "warn",
      message: "Could not read settings.json",
    };
  }

  const enabledPlugins = settings.enabledPlugins as
    | Record<string, boolean>
    | undefined;
  if (!enabledPlugins) {
    return {
      status: "warn",
      message: "No enabledPlugins section found (might be using standalone MCP mode)",
    };
  }

  const pluginKey = Object.keys(enabledPlugins).find((k) =>
    k.startsWith("context-mode"),
  );

  if (pluginKey && enabledPlugins[pluginKey]) {
    return {
      status: "pass",
      pluginKey,
      message: `Plugin enabled: ${pluginKey}`,
    };
  }

  return {
    status: "warn",
    message:
      "context-mode not in enabledPlugins (might be using standalone MCP mode)",
  };
}

// ─────────────────────────────────────────────────────────
// Version management
// ─────────────────────────────────────────────────────────

/** Get the installed marketplace/plugin version. */
export function getMarketplaceVersion(): string {
  // Primary: read from installed_plugins.json
  try {
    const ipPath = resolve(
      homedir(),
      ".claude",
      "plugins",
      "installed_plugins.json",
    );
    const ipRaw = JSON.parse(readFileSync(ipPath, "utf-8"));
    const plugins = ipRaw.plugins ?? {};
    for (const [key, entries] of Object.entries(plugins)) {
      if (!key.toLowerCase().includes("context-mode")) continue;
      const arr = entries as Array<Record<string, unknown>>;
      if (arr.length > 0 && typeof arr[0].version === "string") {
        return arr[0].version;
      }
    }
  } catch {
    /* fallback below */
  }

  // Fallback: scan common plugin cache locations
  const bases = [
    resolve(homedir(), ".claude"),
    resolve(homedir(), ".config", "claude"),
  ];
  for (const base of bases) {
    const cacheDir = resolve(
      base,
      "plugins",
      "cache",
      "claude-context-mode",
      "context-mode",
    );
    try {
      const entries = readdirSync(cacheDir);
      const versions = entries
        .filter((e) => /^\d+\.\d+\.\d+/.test(e))
        .sort((a, b) => {
          const pa = a.split(".").map(Number);
          const pb = b.split(".").map(Number);
          for (let i = 0; i < 3; i++) {
            if ((pa[i] ?? 0) !== (pb[i] ?? 0))
              return (pa[i] ?? 0) - (pb[i] ?? 0);
          }
          return 0;
        });
      if (versions.length > 0) return versions[versions.length - 1];
    } catch {
      /* continue */
    }
  }
  return "not installed";
}

/** Update installed_plugins.json registry to point to given path and version. */
export function updatePluginRegistry(
  pluginRoot: string,
  newVersion: string,
): void {
  try {
    const ipPath = resolve(
      homedir(),
      ".claude",
      "plugins",
      "installed_plugins.json",
    );
    const ipRaw = JSON.parse(readFileSync(ipPath, "utf-8"));
    for (const [key, entries] of Object.entries(ipRaw.plugins || {})) {
      if (!key.toLowerCase().includes("context-mode")) continue;
      for (const entry of entries as Array<Record<string, unknown>>) {
        entry.installPath = pluginRoot;
        entry.version = newVersion;
        entry.lastUpdated = new Date().toISOString();
      }
    }
    writeFileSync(ipPath, JSON.stringify(ipRaw, null, 2) + "\n", "utf-8");
  } catch {
    /* best effort */
  }
}

// ─────────────────────────────────────────────────────────
// Hook script permissions
// ─────────────────────────────────────────────────────────

/** Set executable permissions on all hook scripts. Returns paths that were set. */
export function setHookPermissions(pluginRoot: string): string[] {
  const set: string[] = [];
  for (const [, scriptName] of Object.entries(HOOK_SCRIPTS)) {
    const scriptPath = resolve(pluginRoot, "hooks", scriptName);
    try {
      accessSync(scriptPath, constants.R_OK);
      chmodSync(scriptPath, 0o755);
      set.push(scriptPath);
    } catch {
      /* skip missing scripts */
    }
  }
  return set;
}
