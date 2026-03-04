/**
 * adapters/claude-code — Claude Code platform adapter.
 *
 * Implements HookAdapter for Claude Code's JSON stdin/stdout hook paradigm.
 *
 * Claude Code hook specifics:
 *   - I/O: JSON on stdin, JSON on stdout
 *   - Arg modification: `updatedInput` field in response
 *   - Blocking: `permissionDecision: "deny"` in response
 *   - PostToolUse output: `updatedMCPToolOutput` field
 *   - PreCompact: stdout on exit 0
 *   - Session ID: transcript_path UUID > session_id > CLAUDE_SESSION_ID > ppid
 *   - Config: ~/.claude/settings.json
 *   - Session dir: ~/.claude/context-mode/sessions/
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

import type {
  HookAdapter,
  HookParadigm,
  PlatformCapabilities,
  PreToolUseEvent,
  PostToolUseEvent,
  PreCompactEvent,
  SessionStartEvent,
  PreToolUseResponse,
  PostToolUseResponse,
  PreCompactResponse,
  SessionStartResponse,
  HookRegistration,
} from "../types.js";

// ─────────────────────────────────────────────────────────
// Claude Code raw input types
// ─────────────────────────────────────────────────────────

interface ClaudeCodeHookInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: string;
  is_error?: boolean;
  session_id?: string;
  transcript_path?: string;
  source?: string;
}

// ─────────────────────────────────────────────────────────
// Adapter implementation
// ─────────────────────────────────────────────────────────

export class ClaudeCodeAdapter implements HookAdapter {
  readonly name = "Claude Code";
  readonly paradigm: HookParadigm = "json-stdio";

  readonly capabilities: PlatformCapabilities = {
    preToolUse: true,
    postToolUse: true,
    preCompact: true,
    sessionStart: true,
    canModifyArgs: true,
    canModifyOutput: true,
    canInjectSessionContext: true,
  };

  // ── Input parsing ──────────────────────────────────────

  parsePreToolUseInput(raw: unknown): PreToolUseEvent {
    const input = raw as ClaudeCodeHookInput;
    return {
      toolName: input.tool_name ?? "",
      toolInput: input.tool_input ?? {},
      sessionId: this.extractSessionId(input),
      projectDir: process.env.CLAUDE_PROJECT_DIR,
      raw,
    };
  }

  parsePostToolUseInput(raw: unknown): PostToolUseEvent {
    const input = raw as ClaudeCodeHookInput;
    return {
      toolName: input.tool_name ?? "",
      toolInput: input.tool_input ?? {},
      toolOutput: input.tool_output,
      isError: input.is_error,
      sessionId: this.extractSessionId(input),
      projectDir: process.env.CLAUDE_PROJECT_DIR,
      raw,
    };
  }

  parsePreCompactInput(raw: unknown): PreCompactEvent {
    const input = raw as ClaudeCodeHookInput;
    return {
      sessionId: this.extractSessionId(input),
      projectDir: process.env.CLAUDE_PROJECT_DIR,
      raw,
    };
  }

  parseSessionStartInput(raw: unknown): SessionStartEvent {
    const input = raw as ClaudeCodeHookInput;
    const rawSource = input.source ?? "startup";

    let source: SessionStartEvent["source"];
    switch (rawSource) {
      case "compact":
        source = "compact";
        break;
      case "resume":
        source = "resume";
        break;
      case "clear":
        source = "clear";
        break;
      default:
        source = "startup";
    }

    return {
      sessionId: this.extractSessionId(input),
      source,
      projectDir: process.env.CLAUDE_PROJECT_DIR,
      raw,
    };
  }

  // ── Response formatting ────────────────────────────────

  formatPreToolUseResponse(response: PreToolUseResponse): unknown {
    if (response.decision === "deny") {
      return {
        permissionDecision: "deny",
        reason: response.reason ?? "Blocked by context-mode hook",
      };
    }
    if (response.decision === "modify" && response.updatedInput) {
      return { updatedInput: response.updatedInput };
    }
    // "allow" — return null/undefined for passthrough
    return undefined;
  }

  formatPostToolUseResponse(response: PostToolUseResponse): unknown {
    const result: Record<string, unknown> = {};
    if (response.additionalContext) {
      result.additionalContext = response.additionalContext;
    }
    if (response.updatedOutput) {
      result.updatedMCPToolOutput = response.updatedOutput;
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }

  formatPreCompactResponse(response: PreCompactResponse): unknown {
    // Claude Code: stdout content on exit 0 is injected as context
    return response.context ?? "";
  }

  formatSessionStartResponse(response: SessionStartResponse): unknown {
    // Claude Code: stdout content is injected as additional context
    return response.context ?? "";
  }

  // ── Configuration ──────────────────────────────────────

  getSettingsPath(): string {
    return resolve(homedir(), ".claude", "settings.json");
  }

  getSessionDir(): string {
    const dir = join(homedir(), ".claude", "context-mode", "sessions");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  getSessionDBPath(projectDir: string): string {
    const hash = createHash("sha256")
      .update(projectDir)
      .digest("hex")
      .slice(0, 16);
    return join(this.getSessionDir(), `${hash}.db`);
  }

  getSessionEventsPath(projectDir: string): string {
    const hash = createHash("sha256")
      .update(projectDir)
      .digest("hex")
      .slice(0, 16);
    return join(this.getSessionDir(), `${hash}-events.md`);
  }

  generateHookConfig(pluginRoot: string): HookRegistration {
    const preToolUseCommand = `node ${pluginRoot}/hooks/pretooluse.mjs`;
    const preToolUseMatchers = [
      "Bash",
      "WebFetch",
      "Read",
      "Grep",
      "Task",
      "mcp__plugin_context-mode_context-mode__execute",
      "mcp__plugin_context-mode_context-mode__execute_file",
      "mcp__plugin_context-mode_context-mode__batch_execute",
    ];

    return {
      PreToolUse: preToolUseMatchers.map((matcher) => ({
        matcher,
        hooks: [{ type: "command", command: preToolUseCommand }],
      })),
      PostToolUse: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: `node ${pluginRoot}/hooks/posttooluse.mjs`,
            },
          ],
        },
      ],
      PreCompact: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: `node ${pluginRoot}/hooks/precompact.mjs`,
            },
          ],
        },
      ],
      UserPromptSubmit: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: `node ${pluginRoot}/hooks/userpromptsubmit.mjs`,
            },
          ],
        },
      ],
      SessionStart: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: `node ${pluginRoot}/hooks/sessionstart.mjs`,
            },
          ],
        },
      ],
    };
  }

  readSettings(): Record<string, unknown> | null {
    try {
      const raw = readFileSync(this.getSettingsPath(), "utf-8");
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  writeSettings(settings: Record<string, unknown>): void {
    writeFileSync(
      this.getSettingsPath(),
      JSON.stringify(settings, null, 2) + "\n",
      "utf-8",
    );
  }

  // ── Internal helpers ───────────────────────────────────

  /**
   * Extract session ID from Claude Code hook input.
   * Priority: transcript_path UUID > session_id field > CLAUDE_SESSION_ID env > ppid fallback.
   */
  private extractSessionId(input: ClaudeCodeHookInput): string {
    if (input.transcript_path) {
      const match = input.transcript_path.match(
        /([a-f0-9-]{36})\.jsonl$/,
      );
      if (match) return match[1];
    }
    if (input.session_id) return input.session_id;
    if (process.env.CLAUDE_SESSION_ID) return process.env.CLAUDE_SESSION_ID;
    return `pid-${process.ppid}`;
  }
}

/**
 * Singleton adapter instance.
 * Use this for all Claude Code platform operations.
 */
export const claudeCodeAdapter = new ClaudeCodeAdapter();
