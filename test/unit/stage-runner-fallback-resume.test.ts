/**
 * Regression: a reattached (post-completion) follow-up must resume on the model
 * the stage session last settled on, instead of replaying the whole fallback
 * chain from an unavailable primary.
 *
 * When a stage finishes and its session is later reattached from disk (e.g. the
 * user sends a follow-up after the run completes / the CLI is reloaded),
 * `ensureSession` used to unconditionally restart from `candidates[0]` (the
 * primary). For a chain whose primary is unavailable (e.g. it 404s), every
 * follow-up replayed `primary -> 404 -> ... -> working model` before answering.
 *
 * New behavior: reattach restores the session's saved model (the one that
 * worked) and `promptWithFallback` retries THAT model first. If it fails again
 * retryably, it restarts the full chain from the primary.
 *
 * cross-ref: packages/workflows/src/runs/foreground/stage-runner.ts
 */
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { createStageContext } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import type {
  StageRunnerOpts,
  StageSessionCreateOptions,
  StageSessionRuntime,
} from "../../packages/workflows/src/runs/foreground/stage-runner.js";

interface FakeSessionConfig {
  /** Model object the session reports via `.model` (drives workflowModelId). */
  model?: { provider: string; id: string };
  /** When set, prompt() throws this error. */
  promptError?: Error;
  /** Shared sink recording prompt/followUp/steer calls for assertions. */
  calls?: Array<{ kind: "prompt" | "followUp" | "steer"; text: string }>;
}

function makeFakeStageSession(config: FakeSessionConfig): StageSessionRuntime {
  const base: StageSessionRuntime = {
    async prompt(text: string) {
      config.calls?.push({ kind: "prompt", text });
      if (config.promptError) throw config.promptError;
      return `stub:${text}`;
    },
    async steer(text: string) {
      config.calls?.push({ kind: "steer", text });
    },
    async followUp(text: string) {
      config.calls?.push({ kind: "followUp", text });
    },
    subscribe() {
      return () => {};
    },
    sessionFile: undefined,
    sessionId: `fake-${crypto.randomUUID()}`,
    async setModel() {},
    setThinkingLevel() {},
    async cycleModel() {
      return undefined;
    },
    cycleThinkingLevel() {
      return undefined;
    },
    agent: Object.create(null) as StageSessionRuntime["agent"],
    model: config.model as StageSessionRuntime["model"],
    thinkingLevel: "off",
    messages: [] as StageSessionRuntime["messages"],
    isStreaming: false as StageSessionRuntime["isStreaming"],
    async navigateTree() {
      return { cancelled: true };
    },
    async compact() {
      return {
        promptVersion: 1,
        parameters: { compression_ratio: 0.5, preserve_recent: 2, query: "auto-detected" },
        deletedTargets: [],
        protectedEntryIds: [],
        stats: {
          objectsBefore: 0,
          objectsAfter: 0,
          objectsDeleted: 0,
          tokensBefore: 0,
          tokensAfter: 0,
          percentReduction: 0,
        },
      };
    },
    abortCompaction() {},
    async abort() {},
    dispose() {},
    getLastAssistantText() {
      return undefined;
    },
  };
  return base;
}

const A = { provider: "anthropic", id: "model-a" };
const B = { provider: "anthropic", id: "model-b" };

interface CreateRecord {
  readonly model: unknown;
  readonly hasSessionManager: boolean;
}

function makeOpts(
  create: (options: StageSessionCreateOptions, record: CreateRecord) => StageSessionRuntime,
  createdWith: CreateRecord[],
): StageRunnerOpts {
  return {
    stageId: "stage-1",
    stageName: "Reviewer",
    runId: "run-1",
    stageOptions: {
      model: "anthropic/model-a",
      fallbackModels: ["anthropic/model-b"],
    },
    adapters: {
      agentSession: {
        async create(options: StageSessionCreateOptions) {
          const record: CreateRecord = {
            model: options?.model,
            hasSessionManager: options?.sessionManager !== undefined,
          };
          createdWith.push(record);
          return create(options, record);
        },
      },
    },
  };
}

describe("reattached follow-up resumes on the last working model (#1431 follow-up)", () => {
  test("resumes on the saved model without replaying the primary", async () => {
    const createdWith: CreateRecord[] = [];
    const opts = makeOpts((options) => {
      // The reattach-resume create carries no model override (the SDK restores
      // the saved model). Simulate a session that last worked on model-b.
      if ((options?.model as unknown) === undefined) {
        return makeFakeStageSession({ model: B });
      }
      return makeFakeStageSession({ model: A });
    }, createdWith);

    const ctx = createStageContext(opts);
    await ctx.__ensureSessionFromFile("/tmp/does-not-exist-resume.jsonl");
    await ctx.prompt("follow up");
    await ctx.__dispose();

    // Exactly ONE session was created: the reattach, with no model override so
    // the SDK restores the saved (working) model. No primary/fallback replay.
    assert.equal(createdWith.length, 1, "should not re-create sessions for each candidate");
    assert.equal(createdWith[0]?.model, undefined, "reattach must omit the model override to restore the saved model");
    assert.equal(createdWith[0]?.hasSessionManager, true, "reattach must open the persisted session");

    const attempts = ctx.__modelFallbackMeta().modelAttempts ?? [];
    assert.deepEqual(
      attempts.map((a) => ({ model: a.model, success: a.success })),
      [{ model: "anthropic/model-b", success: true }],
      "only the resumed working model should be attempted",
    );
  });

  test("restarts the full chain from the primary when the resumed model fails again", async () => {
    const createdWith: CreateRecord[] = [];
    const opts = makeOpts((options) => {
      // Resume attempt (no model override): saved model-b, but it now fails.
      if ((options?.model as unknown) === undefined) {
        return makeFakeStageSession({ model: B, promptError: new Error("rate limit exceeded") });
      }
      // Restarted chain: primary (model-a) fails, fallback (model-b) succeeds.
      if ((options?.model as unknown) === "anthropic/model-a") {
        return makeFakeStageSession({ model: A, promptError: new Error("rate limit exceeded") });
      }
      return makeFakeStageSession({ model: B });
    }, createdWith);

    const ctx = createStageContext(opts);
    await ctx.__ensureSessionFromFile("/tmp/does-not-exist-restart.jsonl");
    await ctx.prompt("follow up");
    await ctx.__dispose();

    // Resume (no override) -> failed -> restart from primary -> fallback.
    assert.deepEqual(
      createdWith.map((r) => r.model),
      [undefined, "anthropic/model-a", "anthropic/model-b"],
      "a failed resume must restart the full chain from the primary",
    );

    const attempts = ctx.__modelFallbackMeta().modelAttempts ?? [];
    assert.deepEqual(
      attempts.map((a) => ({ model: a.model, success: a.success })),
      [
        { model: "anthropic/model-b", success: false },
        { model: "anthropic/model-a", success: false },
        { model: "anthropic/model-b", success: true },
      ],
      "resume failure is recorded, then the full chain runs from the primary",
    );
  });
});

describe("live (retained-session) follow-up resumes on the settled model (#1431 follow-up)", () => {
  function liveOpts(
    create: (options: StageSessionCreateOptions) => StageSessionRuntime,
    createdWith: CreateRecord[],
  ): StageRunnerOpts {
    return {
      stageId: "stage-live",
      stageName: "Reviewer",
      runId: "run-live",
      stageOptions: { model: "anthropic/model-a", fallbackModels: ["anthropic/model-b"] },
      adapters: {
        agentSession: {
          async create(options: StageSessionCreateOptions) {
            createdWith.push({ model: options?.model, hasSessionManager: options?.sessionManager !== undefined });
            return create(options);
          },
        },
      },
    };
  }

  test("ctx.followUp() reuses the settled fallback session instead of recreating the primary", async () => {
    const createdWith: CreateRecord[] = [];
    const settledCalls: Array<{ kind: "prompt" | "followUp" | "steer"; text: string }> = [];
    const opts = liveOpts((options) => {
      if ((options?.model as unknown) === "anthropic/model-a") {
        return makeFakeStageSession({ model: A, promptError: new Error("rate limit exceeded") });
      }
      return makeFakeStageSession({ model: B, calls: settledCalls });
    }, createdWith);

    const ctx = createStageContext(opts);
    await ctx.prompt("first turn"); // primary fails -> settles on model-b
    await ctx.followUp("a follow-up message");
    await ctx.__dispose();

    // Only the original primary + fallback were created. The follow-up must NOT
    // create a third (primary) session.
    assert.deepEqual(createdWith.map((r) => r.model), ["anthropic/model-a", "anthropic/model-b"]);
    // The follow-up went to the settled (model-b) session.
    assert.deepEqual(
      settledCalls,
      [{ kind: "prompt", text: "first turn" }, { kind: "followUp", text: "a follow-up message" }],
    );
  });

  test("a second ctx.prompt() resumes on the settled model with no chain replay", async () => {
    const createdWith: CreateRecord[] = [];
    const settledCalls: Array<{ kind: "prompt" | "followUp" | "steer"; text: string }> = [];
    const opts = liveOpts((options) => {
      if ((options?.model as unknown) === "anthropic/model-a") {
        return makeFakeStageSession({ model: A, promptError: new Error("rate limit exceeded") });
      }
      return makeFakeStageSession({ model: B, calls: settledCalls });
    }, createdWith);

    const ctx = createStageContext(opts);
    await ctx.prompt("first turn"); // settles on model-b
    await ctx.prompt("second turn"); // must resume on model-b, not replay model-a
    await ctx.__dispose();

    assert.deepEqual(
      createdWith.map((r) => r.model),
      ["anthropic/model-a", "anthropic/model-b"],
      "the second prompt must reuse the settled session, not recreate the primary",
    );
    assert.deepEqual(
      settledCalls,
      [{ kind: "prompt", text: "first turn" }, { kind: "prompt", text: "second turn" }],
    );
    const attempts = ctx.__modelFallbackMeta().modelAttempts ?? [];
    assert.deepEqual(attempts.map((a) => ({ model: a.model, success: a.success })), [
      { model: "anthropic/model-a", success: false },
      { model: "anthropic/model-b", success: true },
      { model: "anthropic/model-b", success: true },
    ]);
  });
});
