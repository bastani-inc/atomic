import type { ClearedQueue, PromptDisposition } from "../../../core/agent-session-types.js";
import { latestSubagentAttempt } from "../../../core/tasks/completion.js";
import type { TaskId, TaskRecord } from "../../../core/tasks/contracts.js";
import { isTaskMessageError, TaskMessageError } from "../../../core/tasks/message-error.js";
import type { QueuedTaskMessages, TaskMessageLane } from "../../../core/tasks/supervisor.js";
import type { TaskViewResult, TaskViewSource } from "../../../core/tasks/task-view-source.js";
import type { IsolatedInteractiveRuntime } from "../../interactive-engine/isolated-runtime.js";
import type { SteeringLane, SteeringSubmitLane, SteeringTarget } from "../steering-queue-controller.ts";
import type { AgentSteeringPort, AgentViewStatus } from "./contracts.ts";

/** The isolated runtime as the agent-view proxies use it. */
export type AgentViewRuntime = Pick<
	IsolatedInteractiveRuntime,
	"requestAgentView" | "onEngineMessage" | "onGenerationEnded" | "getGeneration"
>;

/** A subagent in this process (or in the engine, for the engine's own port). */
export interface LocalAgentContext {
	readonly source: TaskViewSource;
	/** The latest attempt now. */
	liveTaskId(): TaskId;
	status(): AgentViewStatus;
	onStatus(listener: () => void): () => void;
}

/** A subagent in the isolated engine, reached through view `viewId`. */
export interface RemoteAgentContext {
	readonly runtime: AgentViewRuntime;
	readonly viewId: string;
	status(): AgentViewStatus;
	onStatus(listener: () => void): () => void;
}

function taskRecord(source: TaskViewSource, id: TaskId): TaskRecord | undefined {
	return source.tasks.find((candidate) => candidate.ref.taskId === id);
}

function laneOf(lane: SteeringSubmitLane): TaskMessageLane {
	return lane === "followUp" ? "followUp" : "steer";
}

/**
 * Give `text` to the subagent `taskId` is the latest attempt of, as typed into its chat: queued in `lane` while it
 * works, its next message once it is paused or finished. Resolves once its session took the message.
 *
 * The subagent can change while the message is on its way: a wake or another resume starts it again, so the resume
 * this asked for is refused, or the attempt it went to ends before taking it. Nothing reached it then, so it goes once
 * more to the subagent as it is now, as if typed a moment later: a running attempt takes it, and a finished one is
 * resumed with it. A delivery that may have happened is never sent twice.
 */
export async function sendAgentMessage(
	source: TaskViewSource,
	latest: () => TaskRecord | undefined,
	fallbackId: TaskId,
	text: string,
	lane: TaskMessageLane,
): Promise<void> {
	const send = source.sendTaskMessage;
	const sentTo = latest();
	const taskId = sentTo?.ref.taskId ?? fallbackId;
	if (send === undefined) throw new TaskMessageError("messages-unsupported", { taskId });
	try {
		await send.call(source, taskId, text, lane);
	} catch (error) {
		const now = latest();
		const changed =
			now !== undefined &&
			(now.ref.taskId !== taskId || (now.execution.kind === "settled") !== (sentTo?.execution.kind === "settled"));
		if (
			!changed ||
			!isTaskMessageError(error) ||
			error.code === "delivery-unconfirmed" ||
			source.taskReadOnlyReason?.(now.ref.taskId) !== undefined
		)
			throw error;
		await send.call(source, now.ref.taskId, text, lane);
	}
}

/** Release a paused subagent's hold, so the message sent next starts its turn. */
export async function resumeAgent(source: TaskViewSource, taskId: TaskId): Promise<void> {
	const resume = source.resumeTask;
	if (resume === undefined) return;
	const resumed = await resume.call(source, taskId);
	if (!resumed.ok) throw new Error(resumed.error.message);
}

/** Every message waiting in the subagent's queue, taken back in its own answer. */
export async function takeAgentQueue(source: TaskViewSource, taskId: TaskId): Promise<QueuedTaskMessages> {
	const clear = source.clearTaskQueue;
	if (clear === undefined) return { steering: [], followUp: [] };
	const taken = await clear.call(source, taskId);
	if (!taken.ok) throw new Error(taken.error.message);
	return taken.value;
}

/**
 * Esc: pause the subagent and answer what came back from its queue, steering first. A source that cannot pause ends
 * its turn as an interrupt does, and nothing comes back.
 */
export async function pauseAgent(source: TaskViewSource, taskId: TaskId): Promise<TaskViewResult<QueuedTaskMessages>> {
	const pause = source.pauseTask;
	if (pause !== undefined) return pause.call(source, taskId);
	const interrupt = source.interruptTask;
	if (interrupt === undefined)
		return { ok: false, error: { message: "This task's turn cannot be interrupted from here." } };
	const interrupted = await interrupt.call(source, taskId);
	return interrupted.ok ? { ok: true, value: { steering: [], followUp: [] } } : interrupted;
}

function cleared(taken: QueuedTaskMessages): ClearedQueue {
	return { steering: [...taken.steering], followUp: [...taken.followUp] };
}

/**
 * The steering half of a port on a subagent of `ctx.source`: the target the shared steering controller sends
 * through, as the main chat's goes to its own session, and Esc's pause.
 */
export function createLocalAgentSteering(ctx: LocalAgentContext): AgentSteeringPort {
	const latest = () =>
		latestSubagentAttempt(ctx.source.tasks, ctx.liveTaskId()) ?? taskRecord(ctx.source, ctx.liveTaskId());
	const send = (text: string, lane: TaskMessageLane) =>
		sendAgentMessage(ctx.source, latest, ctx.liveTaskId(), text, lane);
	const steering: SteeringTarget = {
		get busy() {
			return ctx.status().busy;
		},
		get paused() {
			return ctx.status().paused;
		},
		queued: () => ctx.status().queued,
		prompt: (text, options) => send(text, options?.streamingBehavior ?? "steer"),
		resume: async (text, lane) => {
			await resumeAgent(ctx.source, ctx.liveTaskId());
			await send(text, laneOf(lane));
		},
		clearQueue: async () => cleared(await takeAgentQueue(ctx.source, ctx.liveTaskId())),
		subscribeQueue: (listener) => ctx.onStatus(() => listener(ctx.status().queued)),
	};
	return { steering, pause: () => pauseAgent(ctx.source, ctx.liveTaskId()) };
}

/**
 * The same steering for a subagent in the isolated engine: each call is the engine's `agent_view_*` command for view
 * `viewId`, which runs {@link createLocalAgentSteering} on its port there; the queue it lists arrives with the view's
 * status events.
 */
export function createRemoteAgentSteering(ctx: RemoteAgentContext): AgentSteeringPort {
	const { runtime, viewId } = ctx;
	const steering: SteeringTarget = {
		get busy() {
			return ctx.status().busy;
		},
		get paused() {
			return ctx.status().paused;
		},
		queued: () => ctx.status().queued,
		prompt: async (text, options) => {
			const lane: SteeringLane | undefined = options?.streamingBehavior;
			const answer = await runtime.requestAgentView<{ readonly disposition?: PromptDisposition } | undefined>({
				type: "agent_view_prompt",
				viewId,
				message: text,
				...(lane === undefined ? {} : { streamingBehavior: lane }),
			});
			// How the subagent took it, when its session said: the queued copy settles as the main chat's does.
			if (answer?.disposition !== undefined) options?.preflightResult?.(true, answer.disposition);
		},
		resume: async (text, lane) => {
			await runtime.requestAgentView({ type: "agent_view_resume", viewId, message: text, lane });
		},
		clearQueue: () => runtime.requestAgentView<ClearedQueue>({ type: "agent_view_clear_queue", viewId }),
		subscribeQueue: (listener) => ctx.onStatus(() => listener(ctx.status().queued)),
	};
	return {
		steering,
		pause: () => runtime.requestAgentView<TaskViewResult<QueuedTaskMessages>>({ type: "agent_view_pause", viewId }),
	};
}
