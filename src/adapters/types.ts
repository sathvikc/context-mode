/**
 * adapters/types — Platform adapter interface for multi-platform hook support.
 *
 * Defines the contract that each platform adapter must implement.
 * Three paradigms exist across supported platforms:
 *   A) JSON stdin/stdout — Claude Code, Gemini CLI, VS Code Copilot, Copilot CLI, Cursor
 *   B) TS Plugin Functions — OpenCode
 *   C) MCP-only (no hooks) — Codex CLI
 *
 * The MCP server layer is 100% portable and needs no adapter.
 * Only the hook layer requires platform-specific adapters.
 */

// ─────────────────────────────────────────────────────────
// Hook paradigm
// ─────────────────────────────────────────────────────────

export type HookParadigm = "json-stdio" | "ts-plugin" | "mcp-only";

// ─────────────────────────────────────────────────────────
// Platform capabilities
// ─────────────────────────────────────────────────────────

export interface PlatformCapabilities {
  /** Platform supports PreToolUse / BeforeTool / tool.execute.before hooks. */
  preToolUse: boolean;
  /** Platform supports PostToolUse / AfterTool / tool.execute.after hooks. */
  postToolUse: boolean;
  /** Platform supports PreCompact / PreCompress / session.compacting hooks. */
  preCompact: boolean;
  /** Platform supports SessionStart / session.created hooks. */
  sessionStart: boolean;
  /** Platform allows modifying tool input arguments via hooks. */
  canModifyArgs: boolean;
  /** Platform allows modifying tool output via PostToolUse hooks. */
  canModifyOutput: boolean;
  /** Platform allows injecting context during session start or compaction. */
  canInjectSessionContext: boolean;
}

// ─────────────────────────────────────────────────────────
// Normalized hook event types
// ─────────────────────────────────────────────────────────

/** Normalized PreToolUse event — platform-agnostic representation. */
export interface PreToolUseEvent {
  /** Tool name being invoked (e.g., "Bash", "Read", "WebFetch"). */
  toolName: string;
  /** Tool input arguments as key-value pairs. */
  toolInput: Record<string, unknown>;
  /** Session ID extracted by the adapter. */
  sessionId: string;
  /** Project directory (if available). */
  projectDir?: string;
  /** Raw platform-specific input (for passthrough if needed). */
  raw: unknown;
}

/** Normalized PostToolUse event — platform-agnostic representation. */
export interface PostToolUseEvent {
  /** Tool name that was invoked. */
  toolName: string;
  /** Tool input arguments. */
  toolInput: Record<string, unknown>;
  /** Tool output/response (if available). */
  toolOutput?: string;
  /** Whether the tool call resulted in an error. */
  isError?: boolean;
  /** Session ID extracted by the adapter. */
  sessionId: string;
  /** Project directory (if available). */
  projectDir?: string;
  /** Raw platform-specific input. */
  raw: unknown;
}

/** Normalized PreCompact event. */
export interface PreCompactEvent {
  /** Session ID. */
  sessionId: string;
  /** Project directory (if available). */
  projectDir?: string;
  /** Raw platform-specific input. */
  raw: unknown;
}

/** Normalized SessionStart event. */
export interface SessionStartEvent {
  /** Session ID. */
  sessionId: string;
  /** Lifecycle source: fresh start, compaction, resume, or clear. */
  source: "startup" | "compact" | "resume" | "clear";
  /** Project directory (if available). */
  projectDir?: string;
  /** Raw platform-specific input. */
  raw: unknown;
}

// ─────────────────────────────────────────────────────────
// Hook response types
// ─────────────────────────────────────────────────────────

/** Response from PreToolUse hook — can block, modify, or pass through. */
export interface PreToolUseResponse {
  /** "allow" = pass through, "deny" = block tool execution, "modify" = change input. */
  decision: "allow" | "deny" | "modify";
  /** Reason for denial (shown to the model). */
  reason?: string;
  /** Modified tool input (only when decision = "modify"). */
  updatedInput?: Record<string, unknown>;
}

/** Response from PostToolUse hook — can inject context or modify output. */
export interface PostToolUseResponse {
  /** Additional context to inject after tool output. */
  additionalContext?: string;
  /** Modified tool output (if platform supports it). */
  updatedOutput?: string;
}

/** Response from PreCompact hook — injects context before compaction. */
export interface PreCompactResponse {
  /** Context to preserve across compaction. */
  context?: string;
}

/** Response from SessionStart hook — injects context at session start. */
export interface SessionStartResponse {
  /** Context to inject at session start. */
  context?: string;
}

// ─────────────────────────────────────────────────────────
// Hook config types
// ─────────────────────────────────────────────────────────

/** A single hook entry in platform configuration. */
export interface HookEntry {
  /** Tool matcher pattern (empty = match all). */
  matcher: string;
  /** Hook commands/handlers to execute. */
  hooks: Array<{
    type: string;
    command: string;
  }>;
}

/** Hook registration map — maps hook types to their entries. */
export type HookRegistration = Record<string, HookEntry[]>;

// ─────────────────────────────────────────────────────────
// Adapter interface
// ─────────────────────────────────────────────────────────

/**
 * HookAdapter — contract for platform-specific hook implementations.
 *
 * Each supported platform (Claude Code, Gemini CLI, OpenCode, etc.)
 * provides an adapter that normalizes its hook I/O into a common format.
 */
export interface HookAdapter {
  /** Human-readable platform name (e.g., "Claude Code", "Gemini CLI"). */
  readonly name: string;

  /** Hook I/O paradigm used by this platform. */
  readonly paradigm: HookParadigm;

  /** What this platform supports. */
  readonly capabilities: PlatformCapabilities;

  // ── Input parsing ──────────────────────────────────────

  /** Parse raw PreToolUse input into normalized form. */
  parsePreToolUseInput(raw: unknown): PreToolUseEvent;

  /** Parse raw PostToolUse input into normalized form. */
  parsePostToolUseInput(raw: unknown): PostToolUseEvent;

  /** Parse raw PreCompact input (optional — not all platforms support it). */
  parsePreCompactInput?(raw: unknown): PreCompactEvent;

  /** Parse raw SessionStart input (optional — not all platforms support it). */
  parseSessionStartInput?(raw: unknown): SessionStartEvent;

  // ── Response formatting ────────────────────────────────

  /** Format a PreToolUse response into platform-specific output. */
  formatPreToolUseResponse(response: PreToolUseResponse): unknown;

  /** Format a PostToolUse response into platform-specific output. */
  formatPostToolUseResponse(response: PostToolUseResponse): unknown;

  /** Format a PreCompact response into platform-specific output. */
  formatPreCompactResponse?(response: PreCompactResponse): unknown;

  /** Format a SessionStart response into platform-specific output. */
  formatSessionStartResponse?(response: SessionStartResponse): unknown;

  // ── Configuration ──────────────────────────────────────

  /** Path to the platform's settings file (e.g., ~/.claude/settings.json). */
  getSettingsPath(): string;

  /** Directory where session data is stored. */
  getSessionDir(): string;

  /** Compute per-project session DB path. */
  getSessionDBPath(projectDir: string): string;

  /** Compute per-project session events file path. */
  getSessionEventsPath(projectDir: string): string;

  /** Generate hook registration config for this platform. */
  generateHookConfig(pluginRoot: string): HookRegistration;

  /** Read current platform settings. */
  readSettings(): Record<string, unknown> | null;

  /** Write platform settings. */
  writeSettings(settings: Record<string, unknown>): void;
}
