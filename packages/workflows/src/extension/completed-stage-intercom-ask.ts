import type {
	EnsurePostMortemStageHandleResult,
	PostMortemUnavailableReason,
} from "../runs/foreground/postmortem-stage-chat.js";
import type { StageControlHandle } from "../runs/foreground/stage-control-registry.js";

const LATE_STAGE_MESSAGE_EVENT = "atomic:workflow-stage-late-message";
const POST_MORTEM_ATTACH_TIMEOUT_MS = 10_000;

interface IntercomAskMessage {
	readonly customType: "intercom_message";
	readonly content: string;
	readonly details?: {
		readonly message?: {
			readonly expectsReply?: boolean;
		};
	};
}

interface CompletedStageAskEvent {
	handled: boolean;
	completion?: Promise<void>;
	readonly batch: boolean;
	readonly workflowRunId?: string;
	readonly workflowStageId?: string;
	readonly messages: readonly IntercomAskMessage[];
}

interface WorkflowEventSurface {
	readonly events?: {
		// `unknown`, not `(() => void) | undefined`: the host ExtensionAPI's `on`
		// returns nothing while our own event bus returns an unsubscribe. The
		// call site narrows with a typeof check.
		on?(event: string, listener: (payload: unknown) => void): unknown;
	};
	on?(event: "session_shutdown", listener: () => void): void;
}

export type CompletedStageHandleResolver = (
	runId: string,
	stageId: string,
) => EnsurePostMortemStageHandleResult | undefined | Promise<EnsurePostMortemStageHandleResult | undefined>;

/**
 * Claims late blocking Intercom asks for completed workflow stages and runs one
 * post-mortem turn in the retained conversation. Ordinary late notifications
 * keep using the existing parent-chat route.
 */
export function registerCompletedStageIntercomAskRouter(
	pi: WorkflowEventSurface,
	resolveHandle: CompletedStageHandleResolver,
): () => void {
	const queues = new Map<string, Promise<void>>();
	let disposed = false;
	const assertActive = (): void => {
		if (disposed) throw new Error("Intercom ask target is unavailable: its owning session has closed.");
	};
	const subscription = pi.events?.on?.(LATE_STAGE_MESSAGE_EVENT, (payload) => {
		if (disposed || !isCompletedStageAskEvent(payload) || payload.handled === true) return;
		payload.handled = true;
		payload.completion = enqueueTargetTurn(queues, `${payload.workflowRunId}:${payload.workflowStageId}`, () =>
			deliverAsPostMortemTurn(payload, resolveHandle, assertActive),
		);
	});
	const dispose = (): void => {
		disposed = true;
		queues.clear();
		if (typeof subscription === "function") subscription();
	};
	pi.on?.("session_shutdown", dispose);
	return dispose;
}

function isCompletedStageAskEvent(payload: unknown): payload is CompletedStageAskEvent & {
	readonly workflowRunId: string;
	readonly workflowStageId: string;
} {
	if (typeof payload !== "object" || payload === null) return false;
	const event = payload as Partial<CompletedStageAskEvent>;
	return (
		typeof event.workflowRunId === "string" &&
		event.workflowRunId.length > 0 &&
		typeof event.workflowStageId === "string" &&
		event.workflowStageId.length > 0 &&
		Array.isArray(event.messages) &&
		event.messages.length > 0 &&
		event.messages.every(
			(message) =>
				message?.customType === "intercom_message" &&
				typeof message.content === "string" &&
				message.details?.message?.expectsReply === true,
		)
	);
}

function enqueueTargetTurn<T>(queues: Map<string, Promise<T>>, key: string, deliver: () => Promise<T>): Promise<T> {
	const previous = queues.get(key) ?? Promise.resolve();
	const current = previous.catch(() => {}).then(deliver);
	queues.set(key, current);
	void current
		.finally(() => {
			if (queues.get(key) === current) queues.delete(key);
		})
		.catch(() => {});
	return current;
}

async function deliverAsPostMortemTurn(
	event: CompletedStageAskEvent & { readonly workflowRunId: string; readonly workflowStageId: string },
	resolveHandle: CompletedStageHandleResolver,
	assertActive: () => void,
): Promise<void> {
	const handle = await reopenCompletedStage(event.workflowRunId, event.workflowStageId, resolveHandle, assertActive);
	for (const message of event.messages) {
		assertActive();
		if (handle.isStreaming) await handle.followUp(message.content);
		else await handle.prompt(message.content);
	}
}

async function reopenCompletedStage(
	runId: string,
	stageId: string,
	resolveHandle: CompletedStageHandleResolver,
	assertActive: () => void,
): Promise<StageControlHandle> {
	assertActive();
	const resolution = await resolveHandle(runId, stageId);
	assertActive();
	if (resolution === undefined) {
		throw new Error(
			`Intercom ask target is unavailable: completed workflow stage ${runId}/${stageId} was deleted or is no longer retained.`,
		);
	}
	if (!resolution.ok) {
		throw new Error(unavailableReason(runId, stageId, resolution.reason));
	}
	const handle = resolution.handle;
	if (handle.status !== "completed" || handle.isDisposed === true) {
		throw new Error(
			`Intercom ask target is not resumable: workflow stage ${runId}/${stageId} has no retained completed conversation.`,
		);
	}
	await attachWithTimeout(handle);
	return handle;
}

function assistantMessageText(message: StageControlHandle["messages"][number]): string | undefined {
	if (message.role !== "assistant") return undefined;
	let text = "";
	for (const block of message.content) if (block.type === "text") text += block.text;
	return text.trim().length > 0 ? text.trim() : undefined;
}

/**
 * Runs one turn and returns its final assistant text, or undefined when the turn said nothing. The reply is taken
 * from the turn's `message_end` events rather than from positions in `messages`, because the SDK may compact the
 * conversation during the turn and move the reply below the length recorded before it.
 */
export async function collectTurnReply(
	handle: Pick<StageControlHandle, "subscribe" | "prompt">,
	content: string,
): Promise<string | undefined> {
	let reply: string | undefined;
	const unsubscribe = handle.subscribe((event) => {
		if (event.type !== "message_end") return;
		reply = assistantMessageText(event.message) ?? reply;
	});
	try {
		await handle.prompt(content);
	} finally {
		unsubscribe();
	}
	return reply;
}

/**
 * Answers one question in a completed stage's saved conversation: reopens it
 * through the post-mortem loader (never rerunning the workflow), runs one turn
 * with `content`, and returns the final assistant text. Turns for one stage run
 * in arrival order.
 */
export type CompletedStageAnswerer = (runId: string, stageId: string, content: string) => Promise<string>;

export function createCompletedStageAnswerer(
	resolveHandle: CompletedStageHandleResolver,
	assertActive: () => void = () => {},
): CompletedStageAnswerer {
	const queues = new Map<string, Promise<string>>();
	return (runId, stageId, content) =>
		enqueueTargetTurn(queues, `${runId}:${stageId}`, async () => {
			const handle = await reopenCompletedStage(runId, stageId, resolveHandle, assertActive);
			if (handle.isStreaming) {
				throw new Error(
					`Completed workflow stage ${runId}/${stageId} is busy with another turn; ask again when it is idle.`,
				);
			}
			const reply = await collectTurnReply(handle, content);
			assertActive();
			return reply ?? `Completed workflow stage ${runId}/${stageId} reopened but produced no text answer.`;
		});
}

async function attachWithTimeout(handle: StageControlHandle): Promise<void> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const bounded = new Promise<never>((_, reject) => {
		timeout = setTimeout(
			() =>
				reject(
					new Error(
						`Intercom ask target failed to resume within ${POST_MORTEM_ATTACH_TIMEOUT_MS}ms: retained stage conversation ${handle.runId}/${handle.stageId}.`,
					),
				),
			POST_MORTEM_ATTACH_TIMEOUT_MS,
		);
	});
	try {
		await Promise.race([handle.ensureAttached(), bounded]);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}

function unavailableReason(runId: string, stageId: string, reason: PostMortemUnavailableReason): string {
	const target = `${runId}/${stageId}`;
	switch (reason) {
		case "closed":
			return `Intercom ask target is unavailable: the owning session for workflow stage ${target} has closed.`;
		case "not_terminal":
			return `Intercom ask target is not resumable: workflow stage ${target} is not a completed stage with a retained conversation.`;
		case "no_session":
			return `Intercom ask target is unavailable: completed workflow stage ${target} has no retained conversation.`;
		case "invalid_session":
			return `Intercom ask target is unavailable: retained conversation for completed workflow stage ${target} is missing, deleted, or invalid.`;
		case "no_adapter":
			return `Intercom ask target is not resumable: no workflow stage session adapter can reopen ${target}.`;
	}
}
