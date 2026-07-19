// @ts-nocheck
import { afterEach, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import factory from "../../packages/workflows/src/extension/index.js";
import { sendCustomMessage } from "../../packages/coding-agent/src/core/agent-session-message-queue.js";
import { _runAgentPrompt as runAgentPrompt } from "../../packages/coding-agent/src/core/agent-session-prompt.js";
import { WORKFLOW_STAGE_SUBAGENT_GUARD_ENV } from "@bastani/atomic";
import type {
  ExtensionAPI,
  PiToolOpts,
  WorkflowToolArgs,
} from "../../packages/workflows/src/extension/index.js";
import type { WorkflowToolResult } from "../../packages/workflows/src/extension/render-result.js";
import { LIFECYCLE_NOTICE_CUSTOM_TYPE } from "../../packages/workflows/src/extension/lifecycle-notifications.js";
import { cancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
import { jobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { killAllRuns } from "../../packages/workflows/src/runs/background/status.js";
import { stageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import { fakeAgentSession } from "./slash-dispatch-utils.js";

interface SentMessage {
  readonly customType?: string;
  readonly content?: string;
  readonly details?: {
    readonly kind?: string;
    readonly runId?: string;
    readonly error?: string;
    readonly status?: string;
    readonly createdAt?: number;
    readonly active?: boolean;
  };
}

interface PersistenceEntry {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

interface Harness {
  readonly tool: PiToolOpts<WorkflowToolArgs, WorkflowToolResult>;
  readonly restartSession: () => Promise<void>;
  readonly sent: SentMessage[];
  readonly entries: PersistenceEntry[];
  readonly events: string[];
  readonly deliveryModes: string[];
  readonly cleanup: () => Promise<void>;
}

const workflowSource = `import { workflow } from "@bastani/workflows";
import { Type } from "typebox";

export default workflow({
  name: "named-lifecycle-e2e",
  description: "Exercise named background lifecycle outcomes",
  inputs: {
    outcome: Type.String(),
    git_worktree_dir: Type.Optional(Type.String()),
  },
  outputs: {
    status: Type.Optional(Type.String()),
    summary: Type.Optional(Type.String()),
    remaining_work: Type.Optional(Type.String()),
    result: Type.Optional(Type.String()),
  },
  worktreeFromInputs: { gitWorktreeDir: "git_worktree_dir" },
  run: async (ctx) => {
    const outcome = ctx.inputs.outcome;
    if (outcome === "exit_blocked") {
      return ctx.exit({ status: "blocked", reason: "approval required" });
    }
    await ctx.stage("worker").prompt(outcome === "recoverable_auth" ? "throw-auth" : "finish");
    if (outcome === "completed") return {};
    if (outcome === "needs_human_empty") return { status: "needs_human" };
    if (outcome === "needs_human_remaining") return { status: "needs_human", remaining_work: "remaining fallback" };
    if (outcome === "needs_human_result") return { status: "needs_human", result: "result fallback" };
    return { status: outcome, summary: \`reason for \${outcome}\` };
  },
});
`;
let durableBackend: InMemoryDurableBackend;

beforeEach(() => {
  durableBackend = new InMemoryDurableBackend();
  setDurableBackend(durableBackend);
});

afterEach(async () => {
  stageControlRegistry.clear();
  killAllRuns({ store, cancellation: cancellationRegistry });
  await Promise.all(jobTracker.runIds().map((runId) => jobTracker.get(runId)?.promise));
  store.clear();
  setDurableBackend(undefined);
});

async function createHarness(
  parentStreaming = false,
  rejectIdleAdmissions = 0,
  rejectIdleTurnAfterAdmission = false,
): Promise<Harness> {
  const previousGuard = process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];
  delete process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];
  const dir = await mkdtemp(join(tmpdir(), "atomic-named-lifecycle-e2e-"));
  const workflowPath = join(dir, "named-lifecycle-e2e.ts");
  await writeFile(workflowPath, workflowSource, "utf8");

  const sent: SentMessage[] = [];
  const entries: PersistenceEntry[] = [];
  const events: string[] = [];
  const deliveryModes: string[] = [];
  const admit = (message: SentMessage, mode: string): void => {
    sent.push(message);
    deliveryModes.push(mode);
    events.push(`send:${message.details?.runId ?? "unknown"}`);
  };
  let idleAdmissionAttempts = 0;
  const promptSurface = {
    agent: {
      prompt(message: SentMessage) {
        if (idleAdmissionAttempts <= rejectIdleAdmissions) throw new Error("main chat admission rejected");
        promptSurface.isStreaming = true;
        admit(message, "idle-prompt");
        return rejectIdleTurnAfterAdmission
          ? Promise.reject(new Error("model turn failed after admission"))
          : Promise.resolve();
      },
    },
    isStreaming: false,
    waitForRetry: async () => {},
    _continueQueuedAgentMessages: async () => {},
    _awaitPendingPostCompactionContinuation: async () => {},
    _systemPromptOverride: undefined,
  };
  const parentChat = {
    _workflowStageAdmission: undefined,
    isStreaming: parentStreaming,
    _pendingNextTurnMessages: [],
    _queueAgentMessage(message: SentMessage, delivery: string) { admit(message, `streaming-${delivery}`); },
    _appendCustomMessage(message: SentMessage) { admit(message, "streaming-persist"); },
    async _enqueueInterruptCustomMessage() {},
    _runAgentPrompt(message: SentMessage, promptStarted?: () => void) {
      idleAdmissionAttempts += 1;
      if (rejectIdleAdmissions > 0 || rejectIdleTurnAfterAdmission) {
        return runAgentPrompt.call(promptSurface as never, message as never, promptStarted);
      }
      admit(message, "idle-prompt");
      promptStarted?.();
      return Promise.resolve();
    },
  };
  const handlers = new Map<string, Array<(event?: unknown, ctx?: unknown) => unknown>>();
  let tool: PiToolOpts<WorkflowToolArgs, WorkflowToolResult> | undefined;
  const pi: ExtensionAPI = {
    disableAsyncDiscovery: false,
    getWorkflowResources: () => [{ path: workflowPath, enabled: true }],
    registerTool(options) {
      tool = options as PiToolOpts<WorkflowToolArgs, WorkflowToolResult>;
    },
    registerCommand() {},
    registerMessageRenderer() {},
    registerFlag() {},
    registerShortcut() {},
    appendEntry(type, payload) {
      entries.push({ type, payload });
      events.push(`persist:${type}`);
      return `${type}-${entries.length}`;
    },
    sendMessage(message, options) {
      return sendCustomMessage.call(parentChat as never, message as never, options as never);
    },
    on(event, handler) {
      const current = handlers.get(event) ?? [];
      current.push(handler as (event?: unknown, ctx?: unknown) => unknown);
      handlers.set(event, current);
    },
    ui: { setWidget() {} },
    async createAgentSession() {
      const session = fakeAgentSession();
      return {
        session: {
          ...session,
          async prompt(text: string): Promise<string> {
            if (text === "throw-auth") {
              throw new Error("No API key for provider: github-copilot");
            }
            return session.prompt(text);
          },
        } as StageSessionRuntime,
      };
    },
  };

  factory(pi);
  for (const handler of handlers.get("session_start") ?? []) {
    await handler({}, { hasUI: true, ui: { notify() {} } });
  }
  assert.ok(tool, "expected workflow tool registration");
  return {
    tool,
    sent,
    entries,
    events,
    deliveryModes,
    restartSession: async () => {
      for (const handler of handlers.get("session_shutdown") ?? []) await handler({ reason: "new" }, {});
      for (const handler of handlers.get("session_start") ?? []) {
        await handler({}, { hasUI: true, ui: { notify() {} } });
      }
    },
    cleanup: async () => {
      for (const handler of handlers.get("session_shutdown") ?? []) await handler({ reason: "new" }, {});
      await rm(dir, { recursive: true, force: true });
      if (previousGuard === undefined) delete process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];
      else process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV] = previousGuard;
    },
  };
}

async function runNamed(harness: Harness, outcome: string) {
  const accepted = await harness.tool.execute(
    `call-${outcome}`,
    { action: "run", workflow: "named-lifecycle-e2e", inputs: { outcome } },
    undefined,
    undefined,
    { hasUI: true } as never,
  );
  assert.equal(accepted.details.action, "run");
  assert.equal(accepted.details.status, "running");
  const runId = accepted.details.runId;
  const job = jobTracker.get(runId);
  assert.ok(job, `expected live job for ${runId}`);
  await job.promise;
  assert.equal(jobTracker.get(runId), undefined, `expected job ${runId} to unregister after settlement`);
  const snapshot = store.runs().find((run) => run.id === runId);
  assert.ok(snapshot, `expected retained snapshot for ${runId}`);
  return snapshot;
}

function noticesFor(harness: Harness, runId: string): SentMessage[] {
  return harness.sent.filter(
    (message) => message.customType === LIFECYCLE_NOTICE_CUSTOM_TYPE && message.details?.runId === runId,
  );
}

describe("named background workflow lifecycle notifications", () => {
  test.serial("returns an invalid in-checkout worktree setup error from the original tool call", async () => {
    const harness = await createHarness();
    try {
      const result = await harness.tool.execute(
        "call-invalid-worktree",
        {
          action: "run",
          workflow: "named-lifecycle-e2e",
          inputs: { outcome: "completed", git_worktree_dir: "packages" },
        },
        undefined,
        undefined,
        { hasUI: true } as never,
      );

      assert.equal(result.details.action, "run");
      assert.equal(result.details.status, "failed");
      assert.ok(result.details.runId);
      assert.match(result.details.error ?? "", /gitWorktreeDir must be outside the invoking checkout/);
      assert.match(JSON.stringify(result.content), /gitWorktreeDir must be outside the invoking checkout/);
      assert.equal(jobTracker.has(result.details.runId), false);
      assert.equal(cancellationRegistry.abort(result.details.runId), false);
      assert.equal(store.runs().some((run) => run.id === result.details.runId), false);
      assert.equal(durableBackend.getWorkflow(result.details.runId), undefined);
      assert.equal(harness.entries.some((entry) => entry.type === "workflow.stage.start"), false);
    } finally {
      await harness.cleanup();
    }
  });

  test.serial("maps returned terminal statuses and ctx.exit through the full extension path exactly once", async () => {
    const harness = await createHarness();
    try {
      const expected = [
        ["completed", "completed", "completed", undefined],
        ["failed", "failed", "failed", false],
        ["blocked", "blocked", "blocked", false],
        ["needs_human", "blocked", "blocked", true],
        ["incomplete", "blocked", "blocked", true],
        ["auth_blocked", "blocked", "blocked", true],
        ["active", "blocked", "blocked", true],
        ["exit_blocked", "blocked", "blocked", false],
        ["needs_human_empty", "blocked", "blocked", true],
        ["needs_human_remaining", "blocked", "blocked", true],
        ["needs_human_result", "blocked", "blocked", true],
      ] as const;

      for (const [outcome, storedStatus, noticeKind, resumable] of expected) {
        const snapshot = await runNamed(harness, outcome);
        assert.equal(snapshot.status, storedStatus, outcome);
        if (resumable !== undefined) assert.equal(snapshot.resumable, resumable, outcome);
        const notices = noticesFor(harness, snapshot.id);
        assert.equal(notices.length, 1, outcome);
        assert.equal(notices[0]?.details?.kind, noticeKind, outcome);
        store.recordNotice({ id: `tick-${outcome}`, level: "info", message: "tick", createdAt: Date.now() });
        assert.equal(noticesFor(harness, snapshot.id).length, 1, `${outcome} duplicate`);
      }
    } finally {
      await harness.cleanup();
    }
  });

  test.serial("surfaces a structured recoverable stage failure from a named background run", async () => {
    const harness = await createHarness();
    try {
      const snapshot = await runNamed(harness, "recoverable_auth");
      assert.equal(snapshot.status, "running");
      assert.equal(snapshot.failureDisposition, "active_blocked");
      assert.equal(snapshot.failureRecoverability, "recoverable");
      assert.equal(snapshot.resumable, true);
      assert.ok(snapshot.blockedAt);
      assert.equal(snapshot.endedAt, undefined);
      assert.equal(
        harness.entries.filter((entry) => entry.type === "workflow.run.blocked").length,
        1,
      );
      const notices = noticesFor(harness, snapshot.id);
      assert.equal(notices.length, 1);
      assert.equal(notices[0]?.details?.kind, "blocked");
      assert.match(notices[0]?.details?.error ?? "", /No API key for provider: github-copilot/u);
      assert.equal(notices[0]?.details?.status, "blocked");
      assert.equal(notices[0]?.details?.active, true);
      assert.equal(notices[0]?.details?.createdAt, snapshot.blockedAt);
      assert.match(notices[0]?.content ?? "", /is blocked/u);
      assert.deepEqual(harness.deliveryModes, ["idle-prompt"]);
      const durable = durableBackend.getWorkflow(snapshot.id);
      assert.equal(durable?.status, "blocked");
      assert.equal(durable?.resumable, true);
      assert.equal(durableBackend.listResumableWorkflows().some((run) => run.workflowId === snapshot.id), true);
      const sendIndex = harness.events.indexOf(`send:${snapshot.id}`);
      const persistIndex = harness.events.indexOf("persist:workflow.run.blocked");
      assert.ok(sendIndex >= 0 && persistIndex > sendIndex, "chat admission must precede blocked persistence and job settlement");
      await harness.restartSession();
      assert.equal(store.runs().some((run) => run.id === snapshot.id), false);
      assert.equal(durableBackend.getWorkflow(snapshot.id)?.status, "blocked");
      assert.equal(durableBackend.listResumableWorkflows().some((run) => run.workflowId === snapshot.id), true);
      assert.equal(noticesFor(harness, snapshot.id).length, 1);
    } finally {
      await harness.cleanup();
    }
  });
  test.serial("returns a headless recoverable block without a duplicate lifecycle message", async () => {
    const harness = await createHarness();
    try {
      const result = await harness.tool.execute(
        "call-headless-recoverable-auth",
        { action: "run", workflow: "named-lifecycle-e2e", inputs: { outcome: "recoverable_auth" } },
        undefined,
        undefined,
        { hasUI: false } as never,
      );
      assert.equal(result.details.action, "run");
      assert.equal(result.details.status, "blocked");
      assert.match(result.details.error ?? "", /required model provider API key is missing/u);
      assert.equal(jobTracker.get(result.details.runId), undefined);
      assert.equal(noticesFor(harness, result.details.runId).length, 0);
    } finally {
      await harness.cleanup();
    }
  });
  test.serial("retries a named blocked notice rejected by main-chat admission", async () => {
    const harness = await createHarness(false, 1);
    try {
      const snapshot = await runNamed(harness, "recoverable_auth");
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(noticesFor(harness, snapshot.id).length, 1);
      assert.deepEqual(harness.deliveryModes, ["idle-prompt"]);
    } finally {
      await harness.cleanup();
    }
  });

  test.serial("does not duplicate a notice admitted before its idle model turn rejects", async () => {
    const harness = await createHarness(false, 0, true);
    try {
      const snapshot = await runNamed(harness, "recoverable_auth");
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(noticesFor(harness, snapshot.id).length, 1);
      assert.deepEqual(harness.deliveryModes, ["idle-prompt"]);
    } finally {
      await harness.cleanup();
    }
  });

  test.serial("persists a recoverable blocked notice to a streaming parent's transcript", async () => {
    const harness = await createHarness(true);
    try {
      const snapshot = await runNamed(harness, "recoverable_auth");
      assert.equal(noticesFor(harness, snapshot.id).length, 1);
      // A streaming parent persists the notice to the transcript (durable/visible)
      // rather than a droppable steer, so it cannot be silently lost.
      assert.deepEqual(harness.deliveryModes, ["streaming-persist"]);
    } finally {
      await harness.cleanup();
    }
  });
});
