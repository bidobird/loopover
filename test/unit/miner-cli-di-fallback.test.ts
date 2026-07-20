import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@loopover/engine", async () => {
  return import("../../packages/loopover-engine/src/index");
});

import { runLoop } from "../../packages/loopover-miner/lib/loop-cli.js";
import { runAttempt } from "../../packages/loopover-miner/lib/attempt-cli.js";
import { runQueueClaimBatch, runQueueList } from "../../packages/loopover-miner/lib/portfolio-queue-cli.js";
import { initAttemptLog } from "../../packages/loopover-miner/lib/attempt-log.js";

// These tests deliberately pass `{}` (no injected stores or helper hooks) so every `options.x ?? realX`
// seam resolves to its REAL default, with each default store redirected into an isolated tmp DB via its
// env var -- the same isolation pattern as orb-export's own DI-fallback test. They live in their own file,
// not the per-CLI suites: each CLI's `finally` closes the default handles it opened, and the per-CLI suites'
// afterEach `closeDefault*()` calls would double-close those same cached handles and throw.

const roots: string[] = [];
let logs: string[] = [];

function tempDbPath(prefix: string, name: string) {
  const root = mkdtempSync(join(tmpdir(), `loopover-miner-${prefix}-`));
  roots.push(root);
  return join(root, name);
}

function captureLog() {
  logs = [];
  return vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
    logs.push(String(msg));
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runLoop DI fallback (#5135)", () => {
  it("falls back to the REAL default stores and helpers when every hook is omitted, halting safely on the env kill switch", async () => {
    vi.stubEnv("LOOPOVER_MINER_GOVERNOR_STATE_DB", tempDbPath("loop-di", "governor-state.sqlite3"));
    vi.stubEnv("LOOPOVER_MINER_EVENT_LEDGER_DB", tempDbPath("loop-di", "event-ledger.sqlite3"));
    vi.stubEnv("LOOPOVER_MINER_GOVERNOR_LEDGER_DB", tempDbPath("loop-di", "governor-ledger.sqlite3"));
    vi.stubEnv("LOOPOVER_MINER_PORTFOLIO_QUEUE_DB", tempDbPath("loop-di", "portfolio-queue.sqlite3"));
    vi.stubEnv("LOOPOVER_MINER_RUN_STATE_DB", tempDbPath("loop-di", "run-state.sqlite3"));
    // Active from the very first probe, so the loop halts before its first discovery call -- no network, no
    // GitHub, no queue writes; the run exercises purely the real store opens/closes and the halt path.
    vi.stubEnv("LOOPOVER_MINER_KILL_SWITCH", "1");
    // Satisfies resolveGitHubToken's env-override branch outright, so the real default never consults the
    // loopover-mcp session config on this machine.
    vi.stubEnv("GITHUB_TOKEN", "test-token");
    const spy = captureLog();

    const exitCode = await runLoop(["acme/widgets", "--miner-login", "alice", "--json"], {});
    spy.mockRestore();

    expect(exitCode).toBe(0);
    const summary = JSON.parse(logs.join(""));
    expect(summary).toMatchObject({ haltReason: "kill_switch_global", cyclesRun: 1 });
    expect(summary.cycles[0]).toMatchObject({ cycle: 1, outcome: "halted", reason: "kill_switch_global" });
  });
});

describe("runQueueList / runQueueClaimBatch DI fallback (#4833)", () => {
  it("runQueueList opens (and closes) the real default portfolio-queue store when none is injected", () => {
    vi.stubEnv("LOOPOVER_MINER_PORTFOLIO_QUEUE_DB", tempDbPath("queue-di", "portfolio-queue.sqlite3"));
    const spy = captureLog();
    const exitCode = runQueueList([], {});
    spy.mockRestore();
    expect(exitCode).toBe(0);
    expect(logs.join("")).toBe("no portfolio queue entries");
  });

  it("runQueueClaimBatch opens (and closes) the real default manager when none is injected", () => {
    vi.stubEnv("LOOPOVER_MINER_PORTFOLIO_QUEUE_DB", tempDbPath("claim-di", "portfolio-queue.sqlite3"));
    const spy = captureLog();
    const exitCode = runQueueClaimBatch([], {});
    spy.mockRestore();
    expect(exitCode).toBe(0);
    expect(logs.join("")).toBe("none");
  });
});

describe("runAttempt DI fallback (#5132)", () => {
  it("opens every real default store and blocks on a live AI-usage-policy ban, before any worktree or network write", async () => {
    const root = mkdtempSync(join(tmpdir(), "loopover-miner-attempt-di-"));
    roots.push(root);
    vi.stubEnv("LOOPOVER_MINER_WORKTREE_ALLOCATOR_DB", join(root, "worktree-allocator.sqlite3"));
    vi.stubEnv("LOOPOVER_MINER_WORKTREE_DIR", join(root, "worktrees"));
    vi.stubEnv("LOOPOVER_MINER_CLAIM_LEDGER_DB", join(root, "claim-ledger.sqlite3"));
    vi.stubEnv("LOOPOVER_MINER_EVENT_LEDGER_DB", join(root, "event-ledger.sqlite3"));
    vi.stubEnv("LOOPOVER_MINER_ATTEMPT_LOG_DB", join(root, "attempt-log.sqlite3"));
    vi.stubEnv("LOOPOVER_MINER_GOVERNOR_LEDGER_DB", join(root, "governor-ledger.sqlite3"));
    vi.stubEnv("GITHUB_TOKEN", "test-token");
    // The real resolveRejectionSignaled fetches the repo's policy docs off the default global fetch when no
    // fetchImpl is injected; a banning AI-USAGE.md short-circuits the attempt at the earliest gate.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) =>
        String(input).includes("AI-USAGE.md")
          ? new Response("No AI-generated pull requests, please.", { status: 200 })
          : new Response("Welcome, contributors!", { status: 200 }),
      ),
    );
    const spy = captureLog();

    const exitCode = await runAttempt(["acme/widgets", "7", "--miner-login", "alice", "--json"], {
      attemptId: "di-fallback-attempt",
    });
    spy.mockRestore();

    expect(exitCode).toBe(5);
    expect(JSON.parse(logs.join(""))).toMatchObject({
      outcome: "blocked_rejection_signaled",
      repoFullName: "acme/widgets",
      issueNumber: 7,
    });
    // The abort trail landed in the REAL default attempt-log store (a fresh connection sees the same file).
    const attemptLog = initAttemptLog(join(root, "attempt-log.sqlite3"));
    const events = attemptLog.readAttemptLogEvents({ attemptId: "di-fallback-attempt" });
    attemptLog.close();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: "attempt_aborted" });
  });
});
