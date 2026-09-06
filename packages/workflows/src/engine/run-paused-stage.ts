import type { StageContext } from "../shared/types.js";

/** ctx.stage is synchronous. While the executor is paused, defer its real
 * registration (including cached hydration) until an asynchronous stage call.
 * No placeholder graph node or replacement executor is created.
 */
export function deferStageUntilRunRelease(input: {
	readonly name: string;
	readonly create: () => StageContext;
	readonly isPaused: () => boolean;
	readonly waitForRelease: () => Promise<void>;
	readonly signal: AbortSignal;
}): StageContext {
	let stage: StageContext | undefined;
	const current = (): StageContext => {
		input.signal.throwIfAborted();
		if (input.isPaused())
			throw new Error(`Workflow is paused; resume before synchronous access to stage ${input.name}`);
		stage ??= input.create();
		return stage;
	};
	const invoke = async <T>(call: (stage: StageContext) => Promise<T>): Promise<T> => {
		while (input.isPaused()) await input.waitForRelease();
		return call(current());
	};
	return {
		name: input.name,
		prompt: (...args) => invoke((stage) => stage.prompt(...args)),
		complete: (...args) => invoke((stage) => stage.complete(...args)),
		sendUserMessage: (...args) => invoke((stage) => stage.sendUserMessage(...args)),
		steer: (...args) => invoke((stage) => stage.steer(...args)),
		followUp: (...args) => invoke((stage) => stage.followUp(...args)),
		subscribe: (...args) => current().subscribe(...args),
		get sessionFile() {
			return current().sessionFile;
		},
		get sessionId() {
			return current().sessionId;
		},
		setModel: (...args) => invoke((stage) => stage.setModel(...args)),
		setThinkingLevel: (...args) => current().setThinkingLevel(...args),
		cycleModel: () => invoke((stage) => stage.cycleModel()),
		cycleThinkingLevel: () => current().cycleThinkingLevel(),
		get agent() {
			return current().agent;
		},
		get model() {
			return current().model;
		},
		get thinkingLevel() {
			return current().thinkingLevel;
		},
		get messages() {
			return current().messages;
		},
		get isStreaming() {
			return current().isStreaming;
		},
		navigateTree: (...args) => invoke((stage) => stage.navigateTree(...args)),
		compact: () => invoke((stage) => stage.compact()),
		abortCompaction: () => current().abortCompaction(),
		abort: () => invoke((stage) => stage.abort()),
	};
}
