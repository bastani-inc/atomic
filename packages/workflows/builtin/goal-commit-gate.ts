/**
 * Commit gate for Goal completion.
 *
 * A goal run that ends `complete` over a dirty worktree leaves its work
 * undelivered: uncommitted changes are invisible to HEAD-based consumers and
 * easy to lose. Before the reducer's `complete` is finalized, the runner
 * inspects the run's working directory with a durably cached `ctx.tool` git
 * check. A dirty tree converts the completion into another worker turn whose
 * highest-priority action is committing (or intentionally discarding) the
 * outstanding changes; exhausted turn budgets end `needs_human`, never a false
 * `complete`.
 *
 * The gate is deliberately lenient at its edges: non-git directories, missing
 * git binaries, and git failures skip the gate with a recorded lifecycle note
 * rather than trapping runs that never had delivery-by-commit semantics. An
 * objective that explicitly forbids committing opts out textually.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type WorktreeCommitState = {
  readonly kind: "clean" | "dirty" | "non_git" | "git_error";
  readonly headSha?: string;
  readonly dirtyPaths?: readonly string[];
  readonly detail?: string;
};

const GIT_TIMEOUT_MS = 60_000;

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

/** Inspect the run's working directory for uncommitted work. */
export async function inspectWorktreeCommitState(cwd: string): Promise<WorktreeCommitState> {
  try {
    const inside = (await git(cwd, ["rev-parse", "--is-inside-work-tree"])).trim();
    if (inside !== "true") return { kind: "non_git" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Outside a git repository rev-parse exits nonzero; treat both that and a
    // missing git binary as non-git rather than an error worth surfacing.
    return /not a git repository/i.test(message)
      ? { kind: "non_git" }
      : { kind: "git_error", detail: message };
  }

  try {
    const status = await git(cwd, ["status", "--porcelain"]);
    const dirtyPaths = status
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);
    let headSha: string | undefined;
    try {
      headSha = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    } catch {
      // Unborn branch (no commits yet); leave headSha undefined.
    }
    if (dirtyPaths.length > 0) {
      return { kind: "dirty", dirtyPaths, ...(headSha === undefined ? {} : { headSha }) };
    }
    return { kind: "clean", ...(headSha === undefined ? {} : { headSha }) };
  } catch (err) {
    return { kind: "git_error", detail: err instanceof Error ? err.message : String(err) };
  }
}

const COMMIT_OPT_OUT_PATTERN =
  /\b(?:do\s+not|don't|dont|never|without)\s+(?:git\s+)?commit|\bno\s+(?:git\s+)?commits?\b|\bleave\b[^.]*\buncommitted\b/i;

/** True when the objective/acceptance criteria explicitly forbid committing. */
export function commitOptOutRequested(objective: string, acceptanceCriteria: string): boolean {
  return COMMIT_OPT_OUT_PATTERN.test(objective) || COMMIT_OPT_OUT_PATTERN.test(acceptanceCriteria);
}

export function describeCommitGateBlock(state: WorktreeCommitState): string {
  const paths = state.dirtyPaths ?? [];
  const preview = paths.slice(0, 10).join(", ");
  const suffix = paths.length > 10 ? `, … ${paths.length - 10} more` : "";
  return [
    `Completion is on hold: the worktree has ${paths.length} uncommitted change(s) (${preview}${suffix}).`,
    "Commit the work in the current worktree with a descriptive message (or intentionally discard changes that must not ship), verify `git status --porcelain` is empty, and report the commit SHA in your receipt.",
    "Do not start new implementation work unless committing surfaces a genuine defect.",
  ].join(" ");
}

export function describeCommitGateSkip(state: WorktreeCommitState, optOut: boolean): string {
  if (optOut) return "Commit gate skipped: the objective/acceptance criteria explicitly forbid committing.";
  if (state.kind === "non_git") return "Commit gate skipped: the working directory is not a git worktree.";
  return `Commit gate skipped: git inspection failed (${state.detail ?? "unknown error"}).`;
}

export function describeCommitGatePass(state: WorktreeCommitState): string {
  return state.headSha === undefined
    ? "Commit gate passed: worktree clean."
    : `Commit gate passed: worktree clean at commit ${state.headSha}.`;
}

import type { ReducerOutcome, ReviewRecord } from "./goal-types.js";

/**
 * Convert a reducer `complete` into a held outcome when uncommitted work
 * remains: another worker turn while budget allows, `needs_human` otherwise.
 */
export function commitGateHeldOutcome(input: {
  readonly turn: number;
  readonly maxTurns: number;
  readonly reviewQuorum: number;
  readonly reviews: readonly ReviewRecord[];
  readonly message: string;
}): ReducerOutcome {
  const base = {
    turn: input.turn,
    complete_votes: input.reviews.filter((review) => review.decision === "complete").length,
    review_quorum: input.reviewQuorum,
    parsed: input.reviews.every((review) => review.parsed),
    approved: false,
    stopReviewLoop: false,
    finalActionRemaining: false,
    diagnostics: [input.message],
  };
  if (input.turn >= input.maxTurns) {
    return {
      status: "needs_human",
      decision: {
        ...base,
        decision: "needs_human",
        nextAction: "needs_human",
        reason: `Reviewer quorum approved the implementation, but uncommitted work remains and the turn budget is exhausted. ${input.message}`,
      },
    };
  }
  return {
    status: "active",
    decision: {
      ...base,
      decision: "continue",
      nextAction: "implementation",
      reason: `Reviewer quorum approved the implementation, but the worktree holds uncommitted work. ${input.message}`,
    },
  };
}
