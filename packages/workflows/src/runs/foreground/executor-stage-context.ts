import { formatModelLabel } from "@bastani/atomic";
import type { DurableReleasedStageResume } from "../../durable/types.js";
import type { TrackedStageCaller } from "./executor-stage-call.js";
import type { LiveStageRuntime, StageContextWithMeta, StageNoticeInput } from "./executor-stage-types.js";
import type { InternalStageContext, LiveInternalStageContext } from "./stage-runner.js";

function noticeValue(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === undefined || value === null) return "";
	if (typeof value === "object") {
		const candidate = value as { provider?: unknown; id?: unknown; name?: unknown; label?: unknown };
		// A model reads as its raw provider/id, never its display name (#4269).
		if (typeof candidate.provider === "string" && typeof candidate.id === "string")
			return formatModelLabel({ provider: candidate.provider, id: candidate.id });
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

function recordedText(recorded: DurableReleasedStageResume["recorded"]): string {
	if (recorded === undefined) return "";
	if (recorded.result !== undefined) return recorded.result;
	return typeof recorded.output === "string" ? recorded.output : JSON.stringify(recorded.output);
}

export function createStageContext(input: {
	readonly runtime: LiveStageRuntime;
	readonly runTrackedStageCall: TrackedStageCaller;
}): StageContextWithMeta {
	const { runtime } = input;
	const recordStageNotice = (notice: StageNoticeInput): void => {
		runtime.activeStore.recordStageNotice(runtime.runId, runtime.stageId, {
			id: crypto.randomUUID(),
			ts: Date.now(),
			...notice,
		});
	};

	const innerCtx: LiveInternalStageContext = runtime.innerCtx;
	const sendStreamingUserMessage: InternalStageContext["sendUserMessage"] = async (text, options) => {
		runtime.mcpScope.apply();
		try {
			await innerCtx.sendUserMessage(text, options);
		} finally {
			try {
				runtime.mcpScope.clear();
			} finally {
				void runtime.captureStageSessionMeta();
				runtime.applyModelFallbackMeta(innerCtx.__modelFallbackMeta());
			}
		}
	};
	return {
		name: innerCtx.name,
		prompt: (text, promptOptions) => {
			runtime.throwIfStageMutationBlocked();
			// A call the previous process already finished is answered from the run's record, never the model.
			const replayed = runtime.replayRecordedCall();
			if (replayed !== undefined) return replayed.then((recorded) => recorded?.output as never);
			return input.runTrackedStageCall(() => innerCtx.prompt(text, promptOptions), true);
		},
		complete: (text, completeOptions) => {
			runtime.throwIfStageMutationBlocked();
			const replayed = runtime.replayRecordedCall();
			if (replayed !== undefined) return replayed.then((recorded) => recordedText(recorded));
			return input.runTrackedStageCall(() => innerCtx.complete(text, completeOptions));
		},
		sendUserMessage: (text, options) => {
			runtime.throwIfStageMutationBlocked();
			const replayed = runtime.replayRecordedCall();
			if (replayed !== undefined) return replayed.then(() => undefined);
			// A stage released on a tool wait holds the message for the turn its results continue, as a streaming stage
			// takes it into its running turn; neither is a call of its own that would finish the stage (#4309).
			if (innerCtx.isStreaming || innerCtx.__holdsInput() === true) return sendStreamingUserMessage(text, options);
			return input.runTrackedStageCall(() => innerCtx.sendUserMessage(text, options), { allowFinalized: true });
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
		get sessionFile() {
			return innerCtx.sessionFile;
		},
		get sessionId() {
			return innerCtx.sessionId;
		},
		setModel: async (model) => {
			runtime.throwIfStageMutationBlocked();
			await innerCtx.__ensureSession();
			runtime.throwIfStageMutationBlocked();
			recordStageNotice({ kind: "model", from: noticeValue(innerCtx.model), to: noticeValue(model) });
			await innerCtx.setModel(model);
		},
		setThinkingLevel: async (level) => {
			runtime.throwIfStageMutationBlocked();
			const from = noticeValue(innerCtx.thinkingLevel);
			await innerCtx.setThinkingLevel(level);
			recordStageNotice({ kind: "thinking", from, to: noticeValue(level) });
		},
		cycleModel: async () => {
			runtime.throwIfStageMutationBlocked();
			const from = noticeValue(innerCtx.model);
			const result = await innerCtx.cycleModel();
			recordStageNotice({ kind: "model", from, to: noticeValue(innerCtx.model) });
			return result;
		},
		cycleThinkingLevel: async () => {
			runtime.throwIfStageMutationBlocked();
			const from = noticeValue(innerCtx.thinkingLevel);
			const result = await innerCtx.cycleThinkingLevel();
			recordStageNotice({ kind: "thinking", from, to: noticeValue(innerCtx.thinkingLevel) });
			return result;
		},
		get agent() {
			return innerCtx.agent;
		},
		get model() {
			return innerCtx.model;
		},
		get thinkingLevel() {
			return innerCtx.thinkingLevel;
		},
		get messages() {
			return innerCtx.messages;
		},
		get isStreaming() {
			return innerCtx.isStreaming;
		},
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
		release: async () => {
			runtime.throwIfStageMutationBlocked();
			await innerCtx.release();
		},
		rehydrate: async () => {
			runtime.throwIfStageMutationBlocked();
			await innerCtx.rehydrate();
		},
		__modelFallbackMeta: () => innerCtx.__modelFallbackMeta(),
		__releaseIfIdle: () => {
			// The caller keeps no further use of the stage: it is released for good, never held idle.
			runtime.stopIdleWatch();
			return runtime.stageRegistry.releaseIdle(runtime.runId, runtime.stageId);
		},
		__resumeReleased: (resume) => runtime.resumeReleased(resume),
	};
}
