/**
 * AnalyticsEngine — All 27 metrics from SessionDB.
 *
 * Computes session-level and cross-session analytics using SQL queries
 * and JavaScript post-processing. Groups:
 *
 *  Group 1 (SQL Direct):    17 metrics — direct SQL against session tables
 *  Group 2 (JS Computed):    3 metrics — SQL + JS post-processing
 *  Group 3 (Runtime):        4 metrics — stubs for server.ts tracking
 *  Group 4 (New Extractor):  3 metrics — stubs for future extractors
 *
 * Usage:
 *   const engine = new AnalyticsEngine(sessionDb);
 *   const commits = engine.commitCount("session-123");
 */

import type { SessionDB } from "./db.js";

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

/** Database adapter — anything with a prepare() method (better-sqlite3, bun:sqlite, etc.) */
export interface DatabaseAdapter {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

/** Weekly trend data point */
export interface WeeklyTrendRow {
  day: string;
  sessions: number;
}

/** Category distribution row */
export interface ContinuityRow {
  category: string;
  count: number;
}

/** Hourly productivity row */
export interface HourlyRow {
  hour: string;
  count: number;
}

/** Project distribution row */
export interface ProjectRow {
  project_dir: string;
  sessions: number;
}

/** CLAUDE.md freshness row */
export interface FreshnessRow {
  data: string;
  last_updated: string;
}

/** Rework rate row */
export interface ReworkRow {
  data: string;
  edits: number;
}

/** Subagent usage row */
export interface SubagentRow {
  data: string;
  total: number;
}

/** Skill usage row */
export interface SkillRow {
  data: string;
  invocations: number;
}

/** Context savings result (#1) */
export interface ContextSavings {
  rawBytes: number;
  contextBytes: number;
  savedBytes: number;
  savedPercent: number;
}

/** Think in code comparison result (#2) */
export interface ThinkInCodeComparison {
  fileBytes: number;
  outputBytes: number;
  ratio: number;
}

/** Tool-level savings result (#3) */
export interface ToolSavingsRow {
  tool: string;
  rawBytes: number;
  contextBytes: number;
  savedBytes: number;
}

/** Sandbox I/O result (#19) */
export interface SandboxIO {
  inputBytes: number;
  outputBytes: number;
}

/** Pattern insight result (#6) */
export interface PatternInsight {
  pattern: string;
  confidence: number;
}

// ─────────────────────────────────────────────────────────
// AnalyticsEngine
// ─────────────────────────────────────────────────────────

export class AnalyticsEngine {
  private readonly db: DatabaseAdapter;

  /**
   * Create an AnalyticsEngine.
   *
   * Accepts either a SessionDB instance (extracts internal db via
   * the protected getter — use the static fromDB helper for raw adapters)
   * or any object with a prepare() method for direct usage.
   */
  constructor(db: DatabaseAdapter) {
    this.db = db;
  }

  // ═══════════════════════════════════════════════════════
  // GROUP 1 — SQL Direct (17 metrics)
  // ═══════════════════════════════════════════════════════

  /**
   * #5 Weekly Trend — sessions started per day over the last 7 days.
   * Returns an array of { day, sessions } sorted by day.
   */
  weeklyTrend(): WeeklyTrendRow[] {
    return this.db.prepare(
      `SELECT date(started_at) as day, COUNT(*) as sessions
       FROM session_meta
       WHERE started_at > datetime('now', '-7 days')
       GROUP BY day`,
    ).all() as WeeklyTrendRow[];
  }

  /**
   * #7 Session Continuity — event category distribution for a session.
   * Shows what the session focused on (file ops, git, errors, etc.).
   */
  sessionContinuity(sessionId: string): ContinuityRow[] {
    return this.db.prepare(
      `SELECT category, COUNT(*) as count
       FROM session_events
       WHERE session_id = ?
       GROUP BY category`,
    ).all(sessionId) as ContinuityRow[];
  }

  /**
   * #8 Commit Count — number of git commits made during a session.
   * Matches events where category='git' and data contains 'commit'.
   */
  commitCount(sessionId: string): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) as cnt
       FROM session_events
       WHERE session_id = ? AND category = 'git' AND data LIKE '%commit%'`,
    ).get(sessionId) as { cnt: number };
    return row.cnt;
  }

  /**
   * #9 Error Count — total error events in a session.
   */
  errorCount(sessionId: string): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) as cnt
       FROM session_events
       WHERE session_id = ? AND category = 'error'`,
    ).get(sessionId) as { cnt: number };
    return row.cnt;
  }

  /**
   * #10 Session Duration — elapsed minutes from session start to last event.
   * Returns null if last_event_at is not set (session still initializing).
   */
  sessionDuration(sessionId: string): number | null {
    const row = this.db.prepare(
      `SELECT (julianday(last_event_at) - julianday(started_at)) * 24 * 60 as minutes
       FROM session_meta
       WHERE session_id = ?`,
    ).get(sessionId) as { minutes: number | null } | undefined;
    return row?.minutes ?? null;
  }

  /**
   * #11 Error Rate — percentage of events that are errors in a session.
   * Returns 0 for sessions with no events (division by zero protection).
   */
  errorRate(sessionId: string): number {
    const row = this.db.prepare(
      `SELECT ROUND(100.0 * SUM(CASE WHEN category='error' THEN 1 ELSE 0 END) / COUNT(*), 1) as rate
       FROM session_events
       WHERE session_id = ?`,
    ).get(sessionId) as { rate: number | null };
    return row.rate ?? 0;
  }

  /**
   * #12 Tool Diversity — number of distinct MCP tools used in a session.
   * Higher diversity suggests more sophisticated tool usage.
   */
  toolDiversity(sessionId: string): number {
    const row = this.db.prepare(
      `SELECT COUNT(DISTINCT data) as cnt
       FROM session_events
       WHERE session_id = ? AND category = 'mcp'`,
    ).get(sessionId) as { cnt: number };
    return row.cnt;
  }

  /**
   * #14 Hourly Productivity — event distribution by hour of day.
   * Optionally scoped to a session; omit sessionId for all sessions.
   */
  hourlyProductivity(sessionId?: string): HourlyRow[] {
    if (sessionId) {
      return this.db.prepare(
        `SELECT strftime('%H', created_at) as hour, COUNT(*) as count
         FROM session_events
         WHERE session_id = ?
         GROUP BY hour`,
      ).all(sessionId) as HourlyRow[];
    }
    return this.db.prepare(
      `SELECT strftime('%H', created_at) as hour, COUNT(*) as count
       FROM session_events
       GROUP BY hour`,
    ).all() as HourlyRow[];
  }

  /**
   * #15 Project Distribution — session count per project directory.
   * Sorted descending by session count.
   */
  projectDistribution(): ProjectRow[] {
    return this.db.prepare(
      `SELECT project_dir, COUNT(*) as sessions
       FROM session_meta
       GROUP BY project_dir
       ORDER BY sessions DESC`,
    ).all() as ProjectRow[];
  }

  /**
   * #16 Compaction Count — number of snapshot compactions for a session.
   * Higher counts indicate longer/more active sessions.
   */
  compactionCount(sessionId: string): number {
    const row = this.db.prepare(
      `SELECT compact_count
       FROM session_meta
       WHERE session_id = ?`,
    ).get(sessionId) as { compact_count: number } | undefined;
    return row?.compact_count ?? 0;
  }

  /**
   * #17 Weekly Session Count — total sessions started in the last 7 days.
   */
  weeklySessionCount(): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) as cnt
       FROM session_meta
       WHERE started_at > datetime('now', '-7 days')`,
    ).get() as { cnt: number };
    return row.cnt;
  }

  /**
   * #18 Commits Per Session — average commits across all sessions.
   * Returns 0 when no sessions exist (NULLIF prevents division by zero).
   */
  commitsPerSession(): number {
    const row = this.db.prepare(
      `SELECT ROUND(1.0 * (SELECT COUNT(*) FROM session_events WHERE category='git' AND data LIKE '%commit%')
        / NULLIF((SELECT COUNT(DISTINCT session_id) FROM session_meta), 0), 1) as avg`,
    ).get() as { avg: number | null };
    return row.avg ?? 0;
  }

  /**
   * #22 CLAUDE.md Freshness — last update timestamp for each rule file.
   * Helps identify stale configuration files.
   */
  claudeMdFreshness(): FreshnessRow[] {
    return this.db.prepare(
      `SELECT data, MAX(created_at) as last_updated
       FROM session_events
       WHERE category = 'rule'
       GROUP BY data`,
    ).all() as FreshnessRow[];
  }

  /**
   * #24 Rework Rate — files edited more than once (indicates iteration/rework).
   * Sorted descending by edit count.
   */
  reworkRate(sessionId?: string): ReworkRow[] {
    if (sessionId) {
      return this.db.prepare(
        `SELECT data, COUNT(*) as edits
         FROM session_events
         WHERE session_id = ? AND category = 'file'
         GROUP BY data
         HAVING edits > 1
         ORDER BY edits DESC`,
      ).all(sessionId) as ReworkRow[];
    }
    return this.db.prepare(
      `SELECT data, COUNT(*) as edits
       FROM session_events
       WHERE category = 'file'
       GROUP BY data
       HAVING edits > 1
       ORDER BY edits DESC`,
    ).all() as ReworkRow[];
  }

  /**
   * #25 Session Outcome — classify a session as 'productive' or 'exploratory'.
   * Productive: has at least one commit AND last event is not an error.
   */
  sessionOutcome(sessionId: string): "productive" | "exploratory" {
    const row = this.db.prepare(`
      SELECT CASE
        WHEN EXISTS(SELECT 1 FROM session_events WHERE session_id=? AND category='git' AND data LIKE '%commit%')
         AND NOT EXISTS(SELECT 1 FROM session_events WHERE session_id=?
             AND category='error' AND id=(SELECT MAX(id) FROM session_events WHERE session_id=?))
        THEN 'productive'
        ELSE 'exploratory'
      END as outcome
    `).get(sessionId, sessionId, sessionId) as { outcome: "productive" | "exploratory" };
    return row.outcome;
  }

  /**
   * #26 Subagent Usage — subagent spawn counts grouped by type/purpose.
   */
  subagentUsage(sessionId: string): SubagentRow[] {
    return this.db.prepare(
      `SELECT COUNT(*) as total, data
       FROM session_events
       WHERE session_id = ? AND category = 'subagent'
       GROUP BY data`,
    ).all(sessionId) as SubagentRow[];
  }

  /**
   * #27 Skill Usage — skill/slash-command invocation frequency.
   * Sorted descending by invocation count.
   */
  skillUsage(sessionId: string): SkillRow[] {
    return this.db.prepare(
      `SELECT data, COUNT(*) as invocations
       FROM session_events
       WHERE session_id = ? AND category = 'skill'
       GROUP BY data
       ORDER BY invocations DESC`,
    ).all(sessionId) as SkillRow[];
  }

  // ═══════════════════════════════════════════════════════
  // GROUP 2 — JS Computed (3 metrics)
  // ═══════════════════════════════════════════════════════

  /**
   * #4 Session Mix — percentage of sessions classified as productive.
   * Iterates all sessions and uses #25 (sessionOutcome) to classify each.
   */
  sessionMix(): { productive: number; exploratory: number } {
    const sessions = this.db.prepare(
      `SELECT session_id FROM session_meta`,
    ).all() as Array<{ session_id: string }>;

    if (sessions.length === 0) {
      return { productive: 0, exploratory: 0 };
    }

    let productiveCount = 0;
    for (const s of sessions) {
      if (this.sessionOutcome(s.session_id) === "productive") {
        productiveCount++;
      }
    }

    const productivePct = Math.round((100 * productiveCount) / sessions.length);
    return {
      productive: productivePct,
      exploratory: 100 - productivePct,
    };
  }

  /**
   * #13 / #20 Efficiency Score — composite score (0-100) measuring session productivity.
   *
   * Components:
   *  - Error rate (lower = better): weight 30%
   *  - Tool diversity (higher = better): weight 20%
   *  - Commit presence (boolean bonus): weight 25%
   *  - Rework rate (lower = better): weight 15%
   *  - Session duration efficiency (moderate = better): weight 10%
   *
   * Formula: score = 100 - errorPenalty + diversityBonus + commitBonus - reworkPenalty + durationBonus - 40
   * The -40 baseline prevents empty sessions from scoring 100.
   */
  efficiencyScore(sessionId: string): number {
    const errRate = this.errorRate(sessionId);
    const diversity = this.toolDiversity(sessionId);
    const commits = this.commitCount(sessionId);

    const totalEvents = (this.db.prepare(
      `SELECT COUNT(*) as cnt FROM session_events WHERE session_id = ?`,
    ).get(sessionId) as { cnt: number }).cnt;

    const fileEvents = (this.db.prepare(
      `SELECT COUNT(*) as cnt FROM session_events WHERE session_id = ? AND category = 'file'`,
    ).get(sessionId) as { cnt: number }).cnt;

    // Rework: files edited more than once in this session
    const reworkFiles = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM (SELECT data, COUNT(*) as edits FROM session_events WHERE session_id = ? AND category = 'file' GROUP BY data HAVING edits > 1)`,
    ).get(sessionId) as { cnt: number };
    const reworkRatio = fileEvents > 0 ? reworkFiles.cnt / fileEvents : 0;

    // Duration in minutes
    const duration = this.sessionDuration(sessionId) ?? 0;

    // Score components
    const errorPenalty = Math.min(errRate * 0.3, 30);
    const diversityBonus = Math.min(diversity * 4, 20);
    const commitBonus = commits > 0 ? 25 : 0;
    const reworkPenalty = Math.min(reworkRatio * 15, 15);
    const durationBonus = duration > 5 && duration < 60 ? 10 : duration >= 60 ? 5 : 0;

    const score = Math.round(
      Math.max(0, Math.min(100,
        100 - errorPenalty + diversityBonus + commitBonus - reworkPenalty + durationBonus - 40,
      )),
    );
    return score;
  }

  /**
   * #23 Iteration Cycles — counts edit-error-fix sequences in a session.
   *
   * Walks events chronologically and detects patterns where a file event
   * is followed by an error event, then another file event.
   */
  iterationCycles(sessionId: string): number {
    const events = this.db.prepare(
      `SELECT category, data FROM session_events WHERE session_id = ? ORDER BY id ASC`,
    ).all(sessionId) as Array<{ category: string; data: string }>;

    let cycles = 0;
    for (let i = 0; i < events.length - 2; i++) {
      if (
        events[i].category === "file" &&
        events[i + 1].category === "error" &&
        events[i + 2].category === "file"
      ) {
        cycles++;
        i += 2; // Skip past this cycle
      }
    }
    return cycles;
  }

  // ═══════════════════════════════════════════════════════
  // GROUP 3 — Runtime (4 metrics, stubs)
  // ═══════════════════════════════════════════════════════

  /**
   * #1 Context Savings Total — bytes kept out of context window.
   *
   * Stub: requires server.ts to accumulate rawBytes and contextBytes
   * during a live session. Call with tracked values.
   */
  static contextSavingsTotal(rawBytes: number, contextBytes: number): ContextSavings {
    const savedBytes = rawBytes - contextBytes;
    const savedPercent = rawBytes > 0
      ? Math.round((savedBytes / rawBytes) * 1000) / 10
      : 0;
    return { rawBytes, contextBytes, savedBytes, savedPercent };
  }

  /**
   * #2 Think in Code Comparison — ratio of file size to sandbox output size.
   *
   * Stub: requires server.ts tracking of execute/execute_file calls.
   */
  static thinkInCodeComparison(fileBytes: number, outputBytes: number): ThinkInCodeComparison {
    const ratio = outputBytes > 0
      ? Math.round((fileBytes / outputBytes) * 10) / 10
      : 0;
    return { fileBytes, outputBytes, ratio };
  }

  /**
   * #3 Tool Savings — per-tool breakdown of context savings.
   *
   * Stub: requires per-tool accumulators in server.ts.
   */
  static toolSavings(
    tools: Array<{ tool: string; rawBytes: number; contextBytes: number }>,
  ): ToolSavingsRow[] {
    return tools.map((t) => ({
      ...t,
      savedBytes: t.rawBytes - t.contextBytes,
    }));
  }

  /**
   * #19 Sandbox I/O — total input/output bytes processed by the sandbox.
   *
   * Stub: requires PolyglotExecutor byte counters.
   */
  static sandboxIO(inputBytes: number, outputBytes: number): SandboxIO {
    return { inputBytes, outputBytes };
  }

  // ═══════════════════════════════════════════════════════
  // GROUP 4 — New Extractor Needed (3 metrics)
  // ═══════════════════════════════════════════════════════

  /**
   * #6 Pattern Detected — identifies recurring patterns in a session.
   *
   * Analyzes category distribution and detects dominant patterns
   * (>60% threshold). Falls back to combination detection and
   * "balanced" for evenly distributed sessions.
   */
  patternDetected(sessionId: string): string {
    const categories = this.sessionContinuity(sessionId);
    const total = categories.reduce((sum, c) => sum + c.count, 0);
    if (total === 0) return "no activity";

    // Sort by count descending
    categories.sort((a, b) => b.count - a.count);
    const dominant = categories[0];
    const ratio = dominant.count / total;

    if (ratio > 0.6) {
      const patterns: Record<string, string> = {
        file: "heavy file editor",
        git: "git-focused",
        mcp: "tool-heavy",
        error: "debugging session",
        plan: "planning session",
        subagent: "delegation-heavy",
        rule: "configuration session",
        task: "task management",
      };
      return patterns[dominant.category] ?? `${dominant.category}-focused`;
    }

    // Check for common combinations
    if (
      categories.find((c) => c.category === "git") &&
      categories.find((c) => c.category === "file")
    ) {
      return "build and commit";
    }
    return "balanced";
  }

  /**
   * #21 Permission Denials — count of tool calls blocked by security rules.
   *
   * Filters error events containing "denied", "blocked", or "permission".
   * Stub: ideally requires a dedicated extractor in extract.ts.
   */
  permissionDenials(sessionId: string): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) as cnt
       FROM session_events
       WHERE session_id = ? AND category = 'error'
         AND (data LIKE '%denied%' OR data LIKE '%blocked%' OR data LIKE '%permission%')`,
    ).get(sessionId) as { cnt: number };
    return row.cnt;
  }
}
