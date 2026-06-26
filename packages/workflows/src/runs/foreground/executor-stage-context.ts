import type { StageContextWithMeta, StageNoticeInput, LiveStageRuntime } from "./executor-stage-types.js";
import type { InternalStageContext } from "./stage-runner.js";

function noticeValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  if (typeof value === "object") {
    const candidate = value as { id?: unknown; name?: unknown; label?: unknown };
    if (typeof candidate.id === "string") return candidate.id;
    if (typeof candidate.name === "string") return candidate.name;
    if (typeof candidate.label === "string") return candidate.label;
  }
  return String(value);
}

function compactionMeta(result: unknown): string | undefined {
  if (result === undefined || result === null || typeof result !== "object") return undefined;
  const compaction = result as {
    stats?: { tokensBefore?: unknown; tokensAfter?: unknown };
    tokensBefore?: unknown;
    tokensAfter?: unknown;
    tokensKept?: unknown;
  };
  const beforeRaw = compaction.stats?.tokensBefore ?? compaction.tokensBefore;
  const keptRaw = compaction.stats?.tokensAfter ?? compaction.tokensKept ?? compaction.tokensAfter;
  const before = typeof beforeRaw === "number" ? beforeRaw : undefined;
  const kept = typeof keptRaw === "number" ? keptRaw : undefined;
  if (before === undefined || kept === undefined) return undefined;
  return `${(before / 1000).toFixed(1)}k → ${(kept / 1000).toFixed(1)}k`;
}

export function createStageContext(input: {
  readonly runtime: LiveStageRuntime;
  readonly runTrackedStageCall: <T>(call: () => Promise<T>, eagerSession?: boolean) => Promise<T>;
}): StageContextWithMeta {
  const { runtime } = input;
  const recordStageNotice = (notice: StageNoticeInput): void => {
    runtime.activeStore.recordStageNotice(runtime.runId, runtime.stageId, {
      id: crypto.randomUUID(),
      ts: Date.now(),
      ...notice,
    });
  };

  const innerCtx: InternalStageContext = runtime.innerCtx;
  const sendScopedUserMessage: InternalStageContext["sendUserMessage"] = async (text, options) => {
    runtime.mcpScope.apply();
    try {
      await innerCtx.sendUserMessage(text, options);
    } finally {
      try {
        runtime.mcpScope.clear();
      } finally {
        runtime.captureStageSessionMeta();
        runtime.applyModelFallbackMeta(innerCtx.__modelFallbackMeta());
      }
    }
  };
  return {
    name: innerCtx.name,
    prompt: (text, promptOptions) => {
      runtime.throwIfStageMutationBlocked();
      return input.runTrackedStageCall(() => innerCtx.prompt(text, promptOptions), true);
    },
    complete: (text, completeOptions) => {
      runtime.throwIfStageMutationBlocked();
      return input.runTrackedStageCall(() => innerCtx.complete(text, completeOptions));
    },
    sendUserMessage: (text, options) => {
      runtime.throwIfStageMutationBlocked();
      return sendScopedUserMessage(text, options);
    },
    steer: (text) => {
      runtime.throwIfStageMutationBlocked();
      return innerCtx.steer(text);
    },
    followUp: (text) => {
      runtime.throwIfStageMutationBlocked();
      return innerCtx.followUp(text);
    },
    subscribe: (listener) => innerCtx.subscribe(listener),
    get sessionFile() { return innerCtx.sessionFile; },
    get sessionId() { return innerCtx.sessionId; },
    setModel: async (model) => {
      runtime.throwIfStageMutationBlocked();
      await innerCtx.__ensureSession();
      runtime.throwIfStageMutationBlocked();
      recordStageNotice({ kind: "model", from: noticeValue(innerCtx.model), to: noticeValue(model) });
      await innerCtx.setModel(model);
    },
    setThinkingLevel: (level) => {
      runtime.throwIfStageMutationBlocked();
      recordStageNotice({ kind: "thinking", from: noticeValue(innerCtx.thinkingLevel), to: noticeValue(level) });
      innerCtx.setThinkingLevel(level);
    },
    cycleModel: async () => {
      runtime.throwIfStageMutationBlocked();
      const from = noticeValue(innerCtx.model);
      const result = await innerCtx.cycleModel();
      recordStageNotice({ kind: "model", from, to: noticeValue(innerCtx.model) });
      return result;
    },
    cycleThinkingLevel: () => {
      runtime.throwIfStageMutationBlocked();
      const from = noticeValue(innerCtx.thinkingLevel);
      const result = innerCtx.cycleThinkingLevel();
      recordStageNotice({ kind: "thinking", from, to: noticeValue(innerCtx.thinkingLevel) });
      return result;
    },
    get agent() { return innerCtx.agent; },
    get model() { return innerCtx.model; },
    get thinkingLevel() { return innerCtx.thinkingLevel; },
    get messages() { return innerCtx.messages; },
    get isStreaming() { return innerCtx.isStreaming; },
    navigateTree: async (targetId, treeOptions) => {
      runtime.throwIfStageMutationBlocked();
      recordStageNotice({ kind: "tree", to: targetId });
      return innerCtx.navigateTree(targetId, treeOptions);
    },
    compact: async () => {
      runtime.throwIfStageMutationBlocked();
      const result = await innerCtx.compact();
      recordStageNotice({ kind: "compaction", to: "compacted", meta: compactionMeta(result) });
      return result;
    },
    abortCompaction: () => {
      runtime.throwIfStageMutationBlocked();
      innerCtx.abortCompaction();
    },
    abort: async () => {
      runtime.throwIfStageMutationBlocked();
      recordStageNotice({ kind: "abort", to: "interrupted" });
      await innerCtx.abort();
    },
    __modelFallbackMeta: () => innerCtx.__modelFallbackMeta(),
  };
}
