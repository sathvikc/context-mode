/**
 * Issue #9 (updated PRD) — extractUserPromptFeatures per F1 spec.
 *
 * Reference: context-mode-platform/docs/prds/2026-06-insight-data-flow/
 *   09-oss-handoff-prd.md Issue #9 (interface PromptFeatures)
 *   10-prompt-analytics-strategy.md §2 (signal list) + §5 (typed columns)
 *
 * Returns the 5-field F1-canonical shape (platform typed columns):
 *   prompt_length: number
 *   prompt_first_word: string (lowercased, max 32 chars)
 *   prompt_question_count: number
 *   prompt_file_ref_count: number (identifiers like foo.ts / bar.py)
 *   prompt_path_ref_count: number (paths starting with src/tests/docs/scripts/hooks/packages)
 *
 * NEVER stores raw prompt text on the returned object — features only.
 */

import { describe, test, expect } from "vitest";
import { extractUserPromptFeatures } from "../../src/session/extract.js";

describe("extractUserPromptFeatures — F1 §2 spec", () => {
  test("tracer: empty prompt → all zeros + empty first_word", () => {
    const f = extractUserPromptFeatures("");
    expect(f.prompt_length).toBe(0);
    expect(f.prompt_first_word).toBe("");
    expect(f.prompt_question_count).toBe(0);
    expect(f.prompt_file_ref_count).toBe(0);
    expect(f.prompt_path_ref_count).toBe(0);
  });

  test("English imperative: first_word + length + file ref", () => {
    const f = extractUserPromptFeatures("Add login page with OAuth flow at src/auth.ts");
    expect(f.prompt_first_word).toBe("add");
    expect(f.prompt_length).toBeGreaterThan(20);
    expect(f.prompt_file_ref_count).toBeGreaterThanOrEqual(1);
    expect(f.prompt_path_ref_count).toBeGreaterThanOrEqual(1);
  });

  test("first_word lowercased", () => {
    expect(extractUserPromptFeatures("REFACTOR auth").prompt_first_word).toBe("refactor");
    expect(extractUserPromptFeatures("Why is this slow?").prompt_first_word).toBe("why");
  });

  test("first_word capped at 32 chars", () => {
    const veryLongFirstWord = "a".repeat(80) + " rest of prompt";
    const f = extractUserPromptFeatures(veryLongFirstWord);
    expect(f.prompt_first_word.length).toBeLessThanOrEqual(32);
  });

  test("question count: multi-question Turkish prompt", () => {
    const f = extractUserPromptFeatures("Bu kod neden patladı? Nerede hata var? Ne yapmalıyız?");
    expect(f.prompt_question_count).toBe(3);
  });

  test("question count: no questions → 0", () => {
    expect(extractUserPromptFeatures("Refactor module.").prompt_question_count).toBe(0);
  });

  test("file ref counting: multiple file extensions", () => {
    const f = extractUserPromptFeatures("Update foo.ts, bar.py, and baz.json, also some.md");
    expect(f.prompt_file_ref_count).toBe(4);
  });

  test("file ref counting: ignores plain words without extension", () => {
    const f = extractUserPromptFeatures("Refactor the auth module please.");
    expect(f.prompt_file_ref_count).toBe(0);
  });

  test("path ref counting: src/ + tests/ + docs/", () => {
    const f = extractUserPromptFeatures("Look in src/foo/bar.ts and tests/x.test.ts and docs/readme.md");
    expect(f.prompt_path_ref_count).toBeGreaterThanOrEqual(3);
  });

  test("path ref counting: ignores bare directories without trailing path chars", () => {
    const f = extractUserPromptFeatures("Just talking about src and tests in general.");
    expect(f.prompt_path_ref_count).toBe(0);
  });

  test("emoji-only prompt → first_word is empty, length non-zero", () => {
    const f = extractUserPromptFeatures("🎉 🚀 🐛");
    expect(f.prompt_first_word).toBe("");
    expect(f.prompt_length).toBeGreaterThan(0);
  });

  test("non-string input (defensive) → all zeros", () => {
    // @ts-expect-error — defensive boundary
    const f = extractUserPromptFeatures(null);
    expect(f.prompt_length).toBe(0);
    expect(f.prompt_first_word).toBe("");
  });

  test("prompt_length matches String.length (chars, not bytes)", () => {
    expect(extractUserPromptFeatures("hello").prompt_length).toBe(5);
    expect(extractUserPromptFeatures("şğı").prompt_length).toBe(3);
  });

  test("function returns plain object, NOT a SessionEvent", () => {
    const f = extractUserPromptFeatures("anything");
    expect(f).not.toHaveProperty("type");
    expect(f).not.toHaveProperty("category");
    expect(f).not.toHaveProperty("data");
    expect(f).not.toHaveProperty("priority");
  });

  test("non-first-token content NEVER leaks into features (privacy)", () => {
    // Per F1 §5 the first_word legitimately captures the first 32 chars of
    // the first whitespace-separated token. Privacy is enforced at the
    // SURFACE layer (UI/MCP), not at capture. But content past the first
    // token must NEVER appear in the features object.
    const sensitive = "refactor the api_key=sk-secret123 module";
    const f = extractUserPromptFeatures(sensitive);
    const serialized = JSON.stringify(f);
    expect(f.prompt_first_word).toBe("refactor");
    expect(serialized).not.toContain("sk-secret123");
    expect(serialized).not.toContain("api_key");
  });

  test("first_word length cap enforced even on adversarial input", () => {
    const longToken = "a".repeat(100);
    const f = extractUserPromptFeatures(longToken);
    expect(f.prompt_first_word.length).toBeLessThanOrEqual(32);
  });
});
