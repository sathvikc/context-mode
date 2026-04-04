/**
 * Analytics Metrics — TDD Tests for All 27 Metrics
 *
 * Tests metric computation functions against an in-memory SessionDB.
 * Each test creates realistic session_events data and verifies the
 * expected metric output.
 *
 * Schema: session_events, session_meta, session_resume
 * Categories: rule, file, cwd, error, git, task, plan, env, skill,
 *             subagent, mcp, decision, role, intent, data, prompt
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";

// ─────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────

/** Schema matching src/session/db.ts */
function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      category TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 2,
      data TEXT NOT NULL,
      source_hook TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      data_hash TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id);
    CREATE INDEX IF NOT EXISTS idx_session_events_type ON session_events(session_id, type);
    CREATE INDEX IF NOT EXISTS idx_session_events_priority ON session_events(session_id, priority);

    CREATE TABLE IF NOT EXISTS session_meta (
      session_id TEXT PRIMARY KEY,
      project_dir TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_event_at TEXT,
      event_count INTEGER NOT NULL DEFAULT 0,
      compact_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS session_resume (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL UNIQUE,
      snapshot TEXT NOT NULL,
      event_count INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      consumed INTEGER NOT NULL DEFAULT 0
    );
  `);
}

interface InsertEventParams {
  session_id: string;
  type: string;
  category: string;
  priority?: number;
  data: string;
  source_hook?: string;
  created_at?: string;
  data_hash?: string;
}

function insertEvent(db: Database.Database, params: InsertEventParams): void {
  db.prepare(`
    INSERT INTO session_events (session_id, type, category, priority, data, source_hook, created_at, data_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.session_id,
    params.type,
    params.category,
    params.priority ?? 2,
    params.data,
    params.source_hook ?? "PostToolUse",
    params.created_at ?? new Date().toISOString().replace("T", " ").slice(0, 19),
    params.data_hash ?? "",
  );
}

function insertSession(
  db: Database.Database,
  sessionId: string,
  projectDir: string,
  startedAt: string,
  lastEventAt: string | null = null,
  eventCount: number = 0,
  compactCount: number = 0,
): void {
  db.prepare(`
    INSERT INTO session_meta (session_id, project_dir, started_at, last_event_at, event_count, compact_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(sessionId, projectDir, startedAt, lastEventAt, eventCount, compactCount);
}

// ─────────────────────────────────────────────────────────
// Metric computation functions (to be implemented in src/analytics/metrics.ts)
// For TDD, we define the expected signatures here and implement inline.
// Once the real module exists, replace these with imports.
// ─────────────────────────────────────────────────────────

/** #8 Commits this session */
function getCommitCount(db: Database.Database, sessionId: string): number {
  const row = db.prepare(
    `SELECT COUNT(*) as cnt FROM session_events WHERE session_id = ? AND category = 'git' AND data LIKE '%commit%'`,
  ).get(sessionId) as { cnt: number };
  return row.cnt;
}

/** #9 Errors this session */
function getErrorCount(db: Database.Database, sessionId: string): number {
  const row = db.prepare(
    `SELECT COUNT(*) as cnt FROM session_events WHERE session_id = ? AND category = 'error'`,
  ).get(sessionId) as { cnt: number };
  return row.cnt;
}

/** #10 Session duration in minutes */
function getSessionDuration(db: Database.Database, sessionId: string): number | null {
  const row = db.prepare(
    `SELECT (julianday(last_event_at) - julianday(started_at)) * 24 * 60 as minutes FROM session_meta WHERE session_id = ?`,
  ).get(sessionId) as { minutes: number | null } | undefined;
  return row?.minutes ?? null;
}

/** #16 Compaction count */
function getCompactionCount(db: Database.Database, sessionId: string): number {
  const row = db.prepare(
    `SELECT compact_count FROM session_meta WHERE session_id = ?`,
  ).get(sessionId) as { compact_count: number };
  return row.compact_count;
}

/** #17 Session count (weekly) */
function getWeeklySessionCount(db: Database.Database): number {
  const row = db.prepare(
    `SELECT COUNT(*) as cnt FROM session_meta WHERE started_at > datetime('now', '-7 days')`,
  ).get() as { cnt: number };
  return row.cnt;
}

/** #11 Error rate % */
function getErrorRate(db: Database.Database, sessionId: string): number {
  const row = db.prepare(
    `SELECT ROUND(100.0 * SUM(CASE WHEN category='error' THEN 1 ELSE 0 END) / COUNT(*), 1) as rate FROM session_events WHERE session_id = ?`,
  ).get(sessionId) as { rate: number | null };
  return row.rate ?? 0;
}

/** #12 Tool diversity — distinct MCP tools */
function getToolDiversity(db: Database.Database, sessionId: string): number {
  const row = db.prepare(
    `SELECT COUNT(DISTINCT data) as cnt FROM session_events WHERE session_id = ? AND category = 'mcp'`,
  ).get(sessionId) as { cnt: number };
  return row.cnt;
}

/** #18 Commits per session (average) */
function getAvgCommitsPerSession(db: Database.Database): number {
  const row = db.prepare(`
    SELECT ROUND(1.0 * (SELECT COUNT(*) FROM session_events WHERE category='git' AND data LIKE '%commit%')
      / NULLIF((SELECT COUNT(DISTINCT session_id) FROM session_meta), 0), 1) as avg
  `).get() as { avg: number | null };
  return row.avg ?? 0;
}

/** #24 Rework rate — files edited more than once */
function getReworkedFiles(db: Database.Database): Array<{ data: string; edits: number }> {
  return db.prepare(
    `SELECT data, COUNT(*) as edits FROM session_events WHERE category = 'file' GROUP BY data HAVING edits > 1 ORDER BY edits DESC`,
  ).all() as Array<{ data: string; edits: number }>;
}

/** #4 Session mix — productive % */
function getSessionMix(db: Database.Database): number {
  const sessions = db.prepare(`SELECT session_id FROM session_meta`).all() as Array<{ session_id: string }>;
  if (sessions.length === 0) return 0;
  let productive = 0;
  for (const s of sessions) {
    const outcome = getSessionOutcome(db, s.session_id);
    if (outcome === "productive") productive++;
  }
  return Math.round((100 * productive) / sessions.length);
}

/** #5 Weekly trend — sessions per day */
function getWeeklyTrend(db: Database.Database): Array<{ day: string; sessions: number }> {
  return db.prepare(
    `SELECT date(started_at) as day, COUNT(*) as sessions FROM session_meta WHERE started_at > datetime('now', '-7 days') GROUP BY day`,
  ).all() as Array<{ day: string; sessions: number }>;
}

/** #7 Session continuity — category distribution */
function getSessionContinuity(db: Database.Database, sessionId: string): Array<{ category: string; count: number }> {
  return db.prepare(
    `SELECT category, COUNT(*) as count FROM session_events WHERE session_id = ? GROUP BY category`,
  ).all(sessionId) as Array<{ category: string; count: number }>;
}

/** #14 Time of day distribution */
function getTimeOfDay(db: Database.Database, sessionId: string): Array<{ hour: string; count: number }> {
  return db.prepare(
    `SELECT strftime('%H', created_at) as hour, COUNT(*) as count FROM session_events WHERE session_id = ? GROUP BY hour`,
  ).all(sessionId) as Array<{ hour: string; count: number }>;
}

/** #15 Project distribution */
function getProjectDistribution(db: Database.Database): Array<{ project_dir: string; sessions: number }> {
  return db.prepare(
    `SELECT project_dir, COUNT(*) as sessions FROM session_meta GROUP BY project_dir ORDER BY sessions DESC`,
  ).all() as Array<{ project_dir: string; sessions: number }>;
}

/** #22 CLAUDE.md freshness */
function getClaudeMdFreshness(db: Database.Database): Array<{ data: string; last_updated: string }> {
  return db.prepare(
    `SELECT data, MAX(created_at) as last_updated FROM session_events WHERE category = 'rule' GROUP BY data`,
  ).all() as Array<{ data: string; last_updated: string }>;
}

/** #26 Subagent usage */
function getSubagentUsage(db: Database.Database, sessionId: string): Array<{ data: string; total: number }> {
  return db.prepare(
    `SELECT COUNT(*) as total, data FROM session_events WHERE session_id = ? AND category = 'subagent' GROUP BY data`,
  ).all(sessionId) as Array<{ data: string; total: number }>;
}

/** #27 Skill usage */
function getSkillUsage(db: Database.Database, sessionId: string): Array<{ data: string; invocations: number }> {
  return db.prepare(
    `SELECT data, COUNT(*) as invocations FROM session_events WHERE session_id = ? AND category = 'skill' GROUP BY data ORDER BY invocations DESC`,
  ).all(sessionId) as Array<{ data: string; invocations: number }>;
}

/** #25 Session outcome — productive or exploratory */
function getSessionOutcome(db: Database.Database, sessionId: string): "productive" | "exploratory" {
  const row = db.prepare(`
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
 * #13 / #20 Efficiency score (North Star)
 * Composite: error rate (30%), tool diversity (20%), commit bonus (25%),
 * rework penalty (15%), duration bonus (10%)
 */
function getEfficiencyScore(db: Database.Database, sessionId: string): number {
  const errorRate = getErrorRate(db, sessionId);
  const diversity = getToolDiversity(db, sessionId);
  const commits = getCommitCount(db, sessionId);
  const totalEvents = (db.prepare(
    `SELECT COUNT(*) as cnt FROM session_events WHERE session_id = ?`,
  ).get(sessionId) as { cnt: number }).cnt;
  const fileEvents = (db.prepare(
    `SELECT COUNT(*) as cnt FROM session_events WHERE session_id = ? AND category = 'file'`,
  ).get(sessionId) as { cnt: number }).cnt;

  // Rework: files edited > 1 time in this session
  const reworkFiles = db.prepare(
    `SELECT COUNT(*) as cnt FROM (SELECT data, COUNT(*) as edits FROM session_events WHERE session_id = ? AND category = 'file' GROUP BY data HAVING edits > 1)`,
  ).get(sessionId) as { cnt: number };
  const reworkRatio = fileEvents > 0 ? reworkFiles.cnt / fileEvents : 0;

  // Duration in minutes
  const duration = getSessionDuration(db, sessionId) ?? 0;

  // Score components
  const errorPenalty = Math.min(errorRate * 0.3, 30); // max 30 points off
  const diversityBonus = Math.min(diversity * 4, 20); // up to 20 points for 5+ tools
  const commitBonus = commits > 0 ? 25 : 0; // 25 points for any commit
  const reworkPenalty = Math.min(reworkRatio * 15, 15); // max 15 points off
  const durationBonus = duration > 5 && duration < 60 ? 10 : duration >= 60 ? 5 : 0; // moderate sessions are best

  const score = Math.round(
    Math.max(0, Math.min(100, 100 - errorPenalty + diversityBonus + commitBonus - reworkPenalty + durationBonus - 40)),
  );
  // Subtract 40 baseline so an empty session isn't 100
  return score;
}

/** #6 Pattern detected — identify dominant session pattern */
function detectPattern(db: Database.Database, sessionId: string): string {
  const categories = getSessionContinuity(db, sessionId);
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
  if (categories.find((c) => c.category === "git") && categories.find((c) => c.category === "file")) {
    return "build and commit";
  }
  return "balanced";
}

/** #23 Iteration cycles — edit-error-fix sequences */
function getIterationCycles(db: Database.Database, sessionId: string): number {
  const events = db.prepare(
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

/** #21 Permission denials */
function getPermissionDenials(db: Database.Database, sessionId: string): number {
  const row = db.prepare(
    `SELECT COUNT(*) as cnt FROM session_events WHERE session_id = ? AND category = 'error' AND (data LIKE '%denied%' OR data LIKE '%blocked%' OR data LIKE '%permission%')`,
  ).get(sessionId) as { cnt: number };
  return row.cnt;
}

// ─────────────────────────────────────────────────────────
// Runtime metric stubs (need server.ts tracking at runtime)
// ─────────────────────────────────────────────────────────

interface ContextSavings {
  rawBytes: number;
  contextBytes: number;
  savedBytes: number;
  savedPercent: number;
}

function computeContextSavings(rawBytes: number, contextBytes: number): ContextSavings {
  const savedBytes = rawBytes - contextBytes;
  const savedPercent = rawBytes > 0 ? Math.round((savedBytes / rawBytes) * 1000) / 10 : 0;
  return { rawBytes, contextBytes, savedBytes, savedPercent };
}

interface ThinkInCodeComparison {
  fileBytes: number;
  outputBytes: number;
  ratio: number;
}

function computeThinkInCode(fileBytes: number, outputBytes: number): ThinkInCodeComparison {
  const ratio = outputBytes > 0 ? Math.round((fileBytes / outputBytes) * 10) / 10 : 0;
  return { fileBytes, outputBytes, ratio };
}

interface ToolSavings {
  tool: string;
  rawBytes: number;
  contextBytes: number;
  savedBytes: number;
}

function computeToolSavings(
  tools: Array<{ tool: string; rawBytes: number; contextBytes: number }>,
): ToolSavings[] {
  return tools.map((t) => ({
    ...t,
    savedBytes: t.rawBytes - t.contextBytes,
  }));
}

interface SandboxIO {
  inputBytes: number;
  outputBytes: number;
}

function computeSandboxIO(inputBytes: number, outputBytes: number): SandboxIO {
  return { inputBytes, outputBytes };
}

// ═══════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════

describe("Analytics Metrics", () => {
  let db: Database.Database;
  const SESSION_ID = "test-session-001";
  const SESSION_ID_2 = "test-session-002";
  const PROJECT_DIR = "/Users/dev/my-project";

  beforeEach(() => {
    db = new Database(":memory:");
    createSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  // ─── Group 1: Session-level Counts (SQL Direct) ─────────

  describe("Session Counts", () => {
    it("#8 Commits this session — counts git commit events", () => {
      insertSession(db, SESSION_ID, PROJECT_DIR, "2026-04-04 10:00:00", "2026-04-04 10:30:00", 5);

      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "git", data: "git commit -m 'feat: add login'" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "git", data: "git commit -m 'fix: typo'" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "git", data: "git push origin main" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "git", data: "git status" });

      expect(getCommitCount(db, SESSION_ID)).toBe(2);
    });

    it("#8 Commits — returns 0 when no commits exist", () => {
      insertSession(db, SESSION_ID, PROJECT_DIR, "2026-04-04 10:00:00");
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "git", data: "git status" });
      expect(getCommitCount(db, SESSION_ID)).toBe(0);
    });

    it("#9 Errors this session — counts error events", () => {
      insertSession(db, SESSION_ID, PROJECT_DIR, "2026-04-04 10:00:00");

      insertEvent(db, { session_id: SESSION_ID, type: "tool_error", category: "error", data: "ENOENT: no such file" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_error", category: "error", data: "Permission denied: /etc/shadow" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_error", category: "error", data: "TypeScript: Cannot find module" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "file", data: "Read: src/index.ts" });

      expect(getErrorCount(db, SESSION_ID)).toBe(3);
    });

    it("#9 Errors — returns 0 for clean sessions", () => {
      insertSession(db, SESSION_ID, PROJECT_DIR, "2026-04-04 10:00:00");
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "file", data: "Read: src/index.ts" });
      expect(getErrorCount(db, SESSION_ID)).toBe(0);
    });

    it("#10 Session duration — computes minutes from meta timestamps", () => {
      insertSession(db, SESSION_ID, PROJECT_DIR, "2026-04-04 10:00:00", "2026-04-04 10:12:00", 15);

      const minutes = getSessionDuration(db, SESSION_ID);
      expect(minutes).toBeCloseTo(12, 0);
    });

    it("#10 Duration — returns null when last_event_at is null", () => {
      insertSession(db, SESSION_ID, PROJECT_DIR, "2026-04-04 10:00:00", null);
      const minutes = getSessionDuration(db, SESSION_ID);
      expect(minutes).toBeNull();
    });

    it("#16 Compaction count — reads from session_meta", () => {
      insertSession(db, SESSION_ID, PROJECT_DIR, "2026-04-04 10:00:00", "2026-04-04 10:30:00", 50, 3);

      expect(getCompactionCount(db, SESSION_ID)).toBe(3);
    });

    it("#16 Compaction — defaults to 0 for fresh sessions", () => {
      insertSession(db, SESSION_ID, PROJECT_DIR, "2026-04-04 10:00:00");
      expect(getCompactionCount(db, SESSION_ID)).toBe(0);
    });

    it("#17 Session count weekly — counts sessions in last 7 days", () => {
      const now = new Date();
      const today = now.toISOString().replace("T", " ").slice(0, 19);
      const yesterday = new Date(now.getTime() - 86400000).toISOString().replace("T", " ").slice(0, 19);
      const lastWeek = new Date(now.getTime() - 8 * 86400000).toISOString().replace("T", " ").slice(0, 19);

      insertSession(db, "s1", PROJECT_DIR, today);
      insertSession(db, "s2", PROJECT_DIR, yesterday);
      insertSession(db, "s3", PROJECT_DIR, lastWeek); // Outside 7-day window

      expect(getWeeklySessionCount(db)).toBe(2);
    });
  });

  // ─── Group 2: Rates and Ratios ──────────────────────────

  describe("Rates and Ratios", () => {
    it("#4 Session mix — computes productive percentage across sessions", () => {
      insertSession(db, SESSION_ID, PROJECT_DIR, "2026-04-04 09:00:00", "2026-04-04 09:30:00", 10);
      insertSession(db, SESSION_ID_2, PROJECT_DIR, "2026-04-04 10:00:00", "2026-04-04 10:30:00", 5);

      // Session 1: has commit, no trailing error → productive
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "git", data: "git commit -m 'feat'" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "file", data: "Edit: src/app.ts" });

      // Session 2: no commits → exploratory
      insertEvent(db, { session_id: SESSION_ID_2, type: "tool_use", category: "file", data: "Read: README.md" });

      expect(getSessionMix(db)).toBe(50); // 1 of 2 productive
    });

    it("#4 Session mix — 100% when all sessions productive", () => {
      insertSession(db, SESSION_ID, PROJECT_DIR, "2026-04-04 09:00:00");
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "git", data: "git commit -m 'fix'" });
      expect(getSessionMix(db)).toBe(100);
    });

    it("#11 Error rate — computes percentage of error events", () => {
      insertSession(db, SESSION_ID, PROJECT_DIR, "2026-04-04 10:00:00");

      // 2 errors out of 10 total events = 20%
      for (let i = 0; i < 8; i++) {
        insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "file", data: `Edit: file${i}.ts` });
      }
      insertEvent(db, { session_id: SESSION_ID, type: "tool_error", category: "error", data: "Error 1" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_error", category: "error", data: "Error 2" });

      expect(getErrorRate(db, SESSION_ID)).toBe(20.0);
    });

    it("#11 Error rate — 0% for clean sessions", () => {
      insertSession(db, SESSION_ID, PROJECT_DIR, "2026-04-04 10:00:00");
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "file", data: "Read: index.ts" });
      expect(getErrorRate(db, SESSION_ID)).toBe(0);
    });

    it("#12 Tool diversity — counts distinct MCP tools", () => {
      insertSession(db, SESSION_ID, PROJECT_DIR, "2026-04-04 10:00:00");

      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "mcp", data: "ctx_execute" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "mcp", data: "ctx_search" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "mcp", data: "ctx_batch_execute" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "mcp", data: "ctx_execute" }); // duplicate
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "mcp", data: "ctx_index" });

      expect(getToolDiversity(db, SESSION_ID)).toBe(4); // 4 distinct
    });

    it("#18 Commits per session — average across all sessions", () => {
      insertSession(db, SESSION_ID, PROJECT_DIR, "2026-04-04 09:00:00");
      insertSession(db, SESSION_ID_2, PROJECT_DIR, "2026-04-04 10:00:00");

      // Session 1: 3 commits
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "git", data: "git commit -m 'a'" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "git", data: "git commit -m 'b'" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "git", data: "git commit -m 'c'" });
      // Session 2: 1 commit
      insertEvent(db, { session_id: SESSION_ID_2, type: "tool_use", category: "git", data: "git commit -m 'd'" });

      expect(getAvgCommitsPerSession(db)).toBe(2.0); // 4 commits / 2 sessions
    });

    it("#24 Rework rate — identifies files edited multiple times", () => {
      insertSession(db, SESSION_ID, PROJECT_DIR, "2026-04-04 10:00:00");

      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "file", data: "src/app.ts" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "file", data: "src/app.ts" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "file", data: "src/app.ts" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "file", data: "src/utils.ts" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "file", data: "src/utils.ts" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "file", data: "src/index.ts" }); // only once

      const reworked = getReworkedFiles(db);
      expect(reworked).toHaveLength(2);
      expect(reworked[0].data).toBe("src/app.ts");
      expect(reworked[0].edits).toBe(3);
      expect(reworked[1].data).toBe("src/utils.ts");
      expect(reworked[1].edits).toBe(2);
    });

    it("#24 Rework rate — empty when no rework", () => {
      insertSession(db, SESSION_ID, PROJECT_DIR, "2026-04-04 10:00:00");
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "file", data: "src/a.ts" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "file", data: "src/b.ts" });
      expect(getReworkedFiles(db)).toHaveLength(0);
    });
  });

  // ─── Group 3: Distributions (SQL GROUP BY) ──────────────

  describe("Distributions", () => {
    it("#5 Weekly trend — sessions per day for last 7 days", () => {
      const now = new Date();
      const fmt = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19);

      const today = fmt(now);
      const yesterday = fmt(new Date(now.getTime() - 86400000));

      insertSession(db, "s1", PROJECT_DIR, today);
      insertSession(db, "s2", PROJECT_DIR, today);
      insertSession(db, "s3", PROJECT_DIR, yesterday);

      const trend = getWeeklyTrend(db);
      expect(trend.length).toBeGreaterThanOrEqual(1);
      // Today should have 2 sessions
      const todayEntry = trend.find((t) => t.day === today.slice(0, 10));
      expect(todayEntry?.sessions).toBe(2);
    });

    it("#7 Session continuity — category distribution", () => {
      insertSession(db, SESSION_ID, PROJECT_DIR, "2026-04-04 10:00:00");

      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "file", data: "Read: a.ts" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "file", data: "Edit: b.ts" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "git", data: "git commit" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_error", category: "error", data: "ENOENT" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "mcp", data: "ctx_execute" });

      const continuity = getSessionContinuity(db, SESSION_ID);
      expect(continuity).toHaveLength(4); // file, git, error, mcp

      const fileEntry = continuity.find((c) => c.category === "file");
      expect(fileEntry?.count).toBe(2);

      const gitEntry = continuity.find((c) => c.category === "git");
      expect(gitEntry?.count).toBe(1);
    });

    it("#14 Time of day — event distribution by hour", () => {
      insertSession(db, SESSION_ID, PROJECT_DIR, "2026-04-04 10:00:00");

      insertEvent(db, {
        session_id: SESSION_ID, type: "tool_use", category: "file", data: "a.ts",
        created_at: "2026-04-04 09:15:00",
      });
      insertEvent(db, {
        session_id: SESSION_ID, type: "tool_use", category: "file", data: "b.ts",
        created_at: "2026-04-04 09:30:00",
      });
      insertEvent(db, {
        session_id: SESSION_ID, type: "tool_use", category: "file", data: "c.ts",
        created_at: "2026-04-04 14:00:00",
      });

      const hours = getTimeOfDay(db, SESSION_ID);
      expect(hours).toHaveLength(2); // hour 09 and hour 14

      const morning = hours.find((h) => h.hour === "09");
      expect(morning?.count).toBe(2);

      const afternoon = hours.find((h) => h.hour === "14");
      expect(afternoon?.count).toBe(1);
    });

    it("#15 Project distribution — sessions per project", () => {
      insertSession(db, "s1", "/Users/dev/project-a", "2026-04-04 09:00:00");
      insertSession(db, "s2", "/Users/dev/project-a", "2026-04-04 10:00:00");
      insertSession(db, "s3", "/Users/dev/project-b", "2026-04-04 11:00:00");

      const dist = getProjectDistribution(db);
      expect(dist).toHaveLength(2);
      expect(dist[0].project_dir).toBe("/Users/dev/project-a");
      expect(dist[0].sessions).toBe(2);
      expect(dist[1].project_dir).toBe("/Users/dev/project-b");
      expect(dist[1].sessions).toBe(1);
    });

    it("#22 CLAUDE.md freshness — latest rule update timestamps", () => {
      insertEvent(db, {
        session_id: SESSION_ID, type: "rule_load", category: "rule",
        data: "/Users/dev/.claude/CLAUDE.md",
        created_at: "2026-04-01 10:00:00",
      });
      insertEvent(db, {
        session_id: SESSION_ID, type: "rule_load", category: "rule",
        data: "/Users/dev/.claude/CLAUDE.md",
        created_at: "2026-04-04 10:00:00",
      });
      insertEvent(db, {
        session_id: SESSION_ID, type: "rule_load", category: "rule",
        data: "/Users/dev/project/CLAUDE.md",
        created_at: "2026-04-03 08:00:00",
      });

      const freshness = getClaudeMdFreshness(db);
      expect(freshness).toHaveLength(2);

      const globalRule = freshness.find((f) => f.data.includes(".claude/CLAUDE.md"));
      expect(globalRule?.last_updated).toBe("2026-04-04 10:00:00");

      const projectRule = freshness.find((f) => f.data.includes("project/CLAUDE.md"));
      expect(projectRule?.last_updated).toBe("2026-04-03 08:00:00");
    });

    it("#26 Subagent usage — counts by type", () => {
      insertSession(db, SESSION_ID, PROJECT_DIR, "2026-04-04 10:00:00");

      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "subagent", data: "DX Engineer" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "subagent", data: "DX Engineer" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "subagent", data: "QA Engineer" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "subagent", data: "Security Engineer" });

      const usage = getSubagentUsage(db, SESSION_ID);
      expect(usage).toHaveLength(3);

      const dx = usage.find((u) => u.data === "DX Engineer");
      expect(dx?.total).toBe(2);
    });

    it("#27 Skill usage — invocation frequency", () => {
      insertSession(db, SESSION_ID, PROJECT_DIR, "2026-04-04 10:00:00");

      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "skill", data: "commit" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "skill", data: "commit" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "skill", data: "commit" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "skill", data: "review-pr" });

      const skills = getSkillUsage(db, SESSION_ID);
      expect(skills).toHaveLength(2);
      expect(skills[0].data).toBe("commit");
      expect(skills[0].invocations).toBe(3);
      expect(skills[1].data).toBe("review-pr");
      expect(skills[1].invocations).toBe(1);
    });
  });

  // ─── Group 4: Computed Scores (Multi-query + JS) ────────

  describe("Computed Scores", () => {
    it("#6 Pattern detected — identifies dominant category", () => {
      insertSession(db, SESSION_ID, PROJECT_DIR, "2026-04-04 10:00:00");

      // 7 file events out of 10 = 70% → "heavy file editor"
      for (let i = 0; i < 7; i++) {
        insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "file", data: `file${i}.ts` });
      }
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "git", data: "git status" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "mcp", data: "ctx_execute" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "error", data: "minor" });

      expect(detectPattern(db, SESSION_ID)).toBe("heavy file editor");
    });

    it("#6 Pattern — balanced when no category dominates", () => {
      insertSession(db, SESSION_ID, PROJECT_DIR, "2026-04-04 10:00:00");

      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "file", data: "a.ts" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "file", data: "b.ts" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "git", data: "git commit -m 'x'" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "git", data: "git push" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "mcp", data: "ctx_execute" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "mcp", data: "ctx_search" });

      expect(detectPattern(db, SESSION_ID)).toBe("build and commit");
    });

    it("#6 Pattern — no activity for empty session", () => {
      insertSession(db, SESSION_ID, PROJECT_DIR, "2026-04-04 10:00:00");
      expect(detectPattern(db, SESSION_ID)).toBe("no activity");
    });

    it("#13/#20 Efficiency score — high score for productive session", () => {
      insertSession(db, SESSION_ID, PROJECT_DIR, "2026-04-04 10:00:00", "2026-04-04 10:20:00", 20);

      // Diverse tools, commits, few errors, moderate duration
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "mcp", data: "ctx_execute" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "mcp", data: "ctx_search" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "mcp", data: "ctx_batch_execute" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "mcp", data: "ctx_index" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "mcp", data: "ctx_execute_file" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "git", data: "git commit -m 'feat'" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "file", data: "src/a.ts" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "file", data: "src/b.ts" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "file", data: "src/c.ts" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "file", data: "src/d.ts" });

      const score = getEfficiencyScore(db, SESSION_ID);
      expect(score).toBeGreaterThan(50);
      expect(score).toBeLessThanOrEqual(100);
    });

    it("#13/#20 Efficiency score — low score for error-heavy session", () => {
      insertSession(db, SESSION_ID, PROJECT_DIR, "2026-04-04 10:00:00", "2026-04-04 10:05:00", 10);

      // Many errors, no commits, no tool diversity, rework
      for (let i = 0; i < 5; i++) {
        insertEvent(db, { session_id: SESSION_ID, type: "tool_error", category: "error", data: `Error ${i}` });
      }
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "file", data: "src/broken.ts" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "file", data: "src/broken.ts" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "file", data: "src/broken.ts" });

      const score = getEfficiencyScore(db, SESSION_ID);
      expect(score).toBeLessThan(50);
    });

    it("#13/#20 Efficiency score — bounded between 0 and 100", () => {
      insertSession(db, SESSION_ID, PROJECT_DIR, "2026-04-04 10:00:00", "2026-04-04 10:01:00", 1);
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "file", data: "x.ts" });

      const score = getEfficiencyScore(db, SESSION_ID);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    });

    it("#23 Iteration cycles — detects edit-error-fix sequences", () => {
      insertSession(db, SESSION_ID, PROJECT_DIR, "2026-04-04 10:00:00");

      // Cycle 1: file → error → file
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "file", data: "Edit: src/app.ts" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_error", category: "error", data: "TypeScript error" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "file", data: "Edit: src/app.ts" });

      // Non-cycle event
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "git", data: "git status" });

      // Cycle 2: file → error → file
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "file", data: "Edit: src/utils.ts" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_error", category: "error", data: "Import error" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "file", data: "Edit: src/utils.ts" });

      expect(getIterationCycles(db, SESSION_ID)).toBe(2);
    });

    it("#23 Iteration cycles — 0 when no cycles", () => {
      insertSession(db, SESSION_ID, PROJECT_DIR, "2026-04-04 10:00:00");
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "file", data: "a.ts" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "file", data: "b.ts" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "git", data: "commit" });
      expect(getIterationCycles(db, SESSION_ID)).toBe(0);
    });

    it("#25 Session outcome — productive when has commits and no trailing error", () => {
      insertSession(db, SESSION_ID, PROJECT_DIR, "2026-04-04 10:00:00");

      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "file", data: "src/app.ts" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "git", data: "git commit -m 'feat'" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "file", data: "src/readme.md" });

      expect(getSessionOutcome(db, SESSION_ID)).toBe("productive");
    });

    it("#25 Session outcome — exploratory when no commits", () => {
      insertSession(db, SESSION_ID, PROJECT_DIR, "2026-04-04 10:00:00");

      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "file", data: "Read: src/app.ts" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "mcp", data: "ctx_search" });

      expect(getSessionOutcome(db, SESSION_ID)).toBe("exploratory");
    });

    it("#25 Session outcome — exploratory when last event is an error", () => {
      insertSession(db, SESSION_ID, PROJECT_DIR, "2026-04-04 10:00:00");

      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "git", data: "git commit -m 'wip'" });
      insertEvent(db, { session_id: SESSION_ID, type: "tool_error", category: "error", data: "Build failed" });

      expect(getSessionOutcome(db, SESSION_ID)).toBe("exploratory");
    });
  });

  // ─── Group 5: Runtime Metrics ───────────────────────────

  describe("Runtime Metrics", () => {
    it("#1 Context savings — computes saved bytes and percentage", () => {
      const savings = computeContextSavings(847_000, 3_600);

      expect(savings.rawBytes).toBe(847_000);
      expect(savings.contextBytes).toBe(3_600);
      expect(savings.savedBytes).toBe(843_400);
      expect(savings.savedPercent).toBe(99.6);
    });

    it("#1 Context savings — 0% when no raw bytes", () => {
      const savings = computeContextSavings(0, 0);
      expect(savings.savedPercent).toBe(0);
      expect(savings.savedBytes).toBe(0);
    });

    it("#1 Context savings — handles edge case where context > raw", () => {
      // This shouldn't happen in practice, but defensive
      const savings = computeContextSavings(100, 200);
      expect(savings.savedBytes).toBe(-100);
      expect(savings.savedPercent).toBe(-100);
    });

    it("#2 Think in Code comparison — computes file-to-output ratio", () => {
      const comparison = computeThinkInCode(50_000, 2_000);

      expect(comparison.fileBytes).toBe(50_000);
      expect(comparison.outputBytes).toBe(2_000);
      expect(comparison.ratio).toBe(25); // 50K/2K = 25x
    });

    it("#2 Think in Code — handles zero output", () => {
      const comparison = computeThinkInCode(10_000, 0);
      expect(comparison.ratio).toBe(0);
    });

    it("#3 Tool-based savings — per-tool breakdown", () => {
      const tools = [
        { tool: "batch_execute", rawBytes: 500_000, contextBytes: 2_000 },
        { tool: "execute", rawBytes: 200_000, contextBytes: 1_000 },
        { tool: "search", rawBytes: 100_000, contextBytes: 500 },
      ];

      const savings = computeToolSavings(tools);
      expect(savings).toHaveLength(3);

      expect(savings[0].tool).toBe("batch_execute");
      expect(savings[0].savedBytes).toBe(498_000);

      expect(savings[1].tool).toBe("execute");
      expect(savings[1].savedBytes).toBe(199_000);

      expect(savings[2].tool).toBe("search");
      expect(savings[2].savedBytes).toBe(99_500);
    });

    it("#3 Tool-based savings — empty array when no tools", () => {
      expect(computeToolSavings([])).toHaveLength(0);
    });

    it("#19 Sandbox I/O — tracks input and output bytes", () => {
      const io = computeSandboxIO(847_000, 3_600);

      expect(io.inputBytes).toBe(847_000);
      expect(io.outputBytes).toBe(3_600);
    });

    it("#19 Sandbox I/O — zero values for unused sandbox", () => {
      const io = computeSandboxIO(0, 0);
      expect(io.inputBytes).toBe(0);
      expect(io.outputBytes).toBe(0);
    });
  });

  // ─── Group 6: New Extractors Needed ─────────────────────

  describe("New Extractors", () => {
    it("#21 Permission denials — counts denied/blocked error events", () => {
      insertSession(db, SESSION_ID, PROJECT_DIR, "2026-04-04 10:00:00");

      insertEvent(db, {
        session_id: SESSION_ID, type: "tool_error", category: "error",
        data: "Permission denied: cannot write to /etc/hosts",
      });
      insertEvent(db, {
        session_id: SESSION_ID, type: "tool_error", category: "error",
        data: "Blocked: curl command intercepted by security rules",
      });
      insertEvent(db, {
        session_id: SESSION_ID, type: "tool_error", category: "error",
        data: "ENOENT: no such file /tmp/test.txt",
      }); // Not a permission denial
      insertEvent(db, {
        session_id: SESSION_ID, type: "tool_error", category: "error",
        data: "Permission check failed for /usr/local/bin",
      });

      expect(getPermissionDenials(db, SESSION_ID)).toBe(3);
    });

    it("#21 Permission denials — 0 when no denials", () => {
      insertSession(db, SESSION_ID, PROJECT_DIR, "2026-04-04 10:00:00");
      insertEvent(db, {
        session_id: SESSION_ID, type: "tool_error", category: "error",
        data: "ENOENT: file not found",
      });
      expect(getPermissionDenials(db, SESSION_ID)).toBe(0);
    });

    it("#21 Permission denials — 0 when no errors at all", () => {
      insertSession(db, SESSION_ID, PROJECT_DIR, "2026-04-04 10:00:00");
      insertEvent(db, { session_id: SESSION_ID, type: "tool_use", category: "file", data: "Read: a.ts" });
      expect(getPermissionDenials(db, SESSION_ID)).toBe(0);
    });
  });

  // ─── Cross-cutting concerns ─────────────────────────────

  describe("Cross-cutting", () => {
    it("metrics are session-scoped — events from other sessions are excluded", () => {
      insertSession(db, SESSION_ID, PROJECT_DIR, "2026-04-04 10:00:00");
      insertSession(db, SESSION_ID_2, PROJECT_DIR, "2026-04-04 11:00:00");

      insertEvent(db, { session_id: SESSION_ID, type: "tool_error", category: "error", data: "Error A" });
      insertEvent(db, { session_id: SESSION_ID_2, type: "tool_error", category: "error", data: "Error B" });
      insertEvent(db, { session_id: SESSION_ID_2, type: "tool_error", category: "error", data: "Error C" });

      expect(getErrorCount(db, SESSION_ID)).toBe(1);
      expect(getErrorCount(db, SESSION_ID_2)).toBe(2);
    });

    it("empty database returns safe defaults", () => {
      expect(getWeeklySessionCount(db)).toBe(0);
      expect(getReworkedFiles(db)).toHaveLength(0);
      expect(getProjectDistribution(db)).toHaveLength(0);
      expect(getClaudeMdFreshness(db)).toHaveLength(0);
    });

    it("handles sessions with no events gracefully", () => {
      insertSession(db, SESSION_ID, PROJECT_DIR, "2026-04-04 10:00:00");

      expect(getCommitCount(db, SESSION_ID)).toBe(0);
      expect(getErrorCount(db, SESSION_ID)).toBe(0);
      expect(getToolDiversity(db, SESSION_ID)).toBe(0);
      expect(getSessionContinuity(db, SESSION_ID)).toHaveLength(0);
      expect(getSubagentUsage(db, SESSION_ID)).toHaveLength(0);
      expect(getSkillUsage(db, SESSION_ID)).toHaveLength(0);
      expect(detectPattern(db, SESSION_ID)).toBe("no activity");
      expect(getIterationCycles(db, SESSION_ID)).toBe(0);
      expect(getPermissionDenials(db, SESSION_ID)).toBe(0);
    });

    it("large event volume — metrics remain correct with 500+ events", () => {
      insertSession(db, SESSION_ID, PROJECT_DIR, "2026-04-04 10:00:00", "2026-04-04 11:00:00", 500);

      // Insert 500 events in a transaction for speed
      const insertStmt = db.prepare(`
        INSERT INTO session_events (session_id, type, category, priority, data, source_hook, created_at, data_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const categories = ["file", "mcp", "git", "error", "plan"];
      // git events occur at i % 5 === 2, i.e., i = 2, 7, 12, 17, 22, ...
      // We make every 10th git event a commit (gitIndex % 10 === 0)
      let gitIndex = 0;
      const txn = db.transaction(() => {
        for (let i = 0; i < 500; i++) {
          const cat = categories[i % categories.length];
          let data: string;
          if (cat === "git") {
            data = gitIndex % 10 === 0 ? `git commit -m 'c${gitIndex}'` : `git status ${gitIndex}`;
            gitIndex++;
          } else {
            data = `${cat}-event-${i}`;
          }
          insertStmt.run(
            SESSION_ID, "tool_use", cat, 2, data, "PostToolUse",
            `2026-04-04 10:${String(Math.floor(i / 10)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`,
            "",
          );
        }
      });
      txn();

      // Verify counts are consistent
      const totalErrors = getErrorCount(db, SESSION_ID);
      const totalCommits = getCommitCount(db, SESSION_ID);
      const continuity = getSessionContinuity(db, SESSION_ID);
      const totalFromContinuity = continuity.reduce((sum, c) => sum + c.count, 0);

      expect(totalFromContinuity).toBe(500);
      expect(totalErrors).toBe(100); // every 5th is error (indices 3, 8, 13, ...)
      expect(totalCommits).toBe(10); // every 10th git event is a commit, 100 git events total
      expect(continuity).toHaveLength(5);
    });
  });
});
