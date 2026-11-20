import type { TaskId } from "../../src/core/tasks/contracts.js";
import type { TaskViewResult } from "../../src/core/tasks/task-view-source.js";
import type {
	AgentTranscriptComponent,
	AgentViewCommands,
	AgentViewPort,
	AgentViewStatus,
	PausedTaskMessages,
} from "../../src/modes/interactive/agent-view/contracts.ts";
import type { SteeringPromptOptions, SteeringTarget } from "../../src/modes/interactive/steering-queue-controller.ts";

/** What a fake port's subagent was sent, in order. */
export interface FakePortCall {
	readonly kind: "prompt" | "resume" | "clearQueue" | "pause";
	readonly text?: string;
	readonly lane?: string;
}

/** A subagent port with no subagent behind it: its status is set by the test, and every call is recorded. */
export class FakeAgentViewPort implements AgentViewPort {
	readonly agentKey: string;
	readonly calls: FakePortCall[] = [];
	retained = 0;
	disposed = false;
	private current: AgentViewStatus;
	private readonly listeners = new Set<() => void>();
	transcriptLines: string[] = [];
	readonly transcript: AgentTranscriptComponent;
	readonly steering: SteeringTarget;
	promptAnswer: (text: string, options?: SteeringPromptOptions) => Promise<void> = async (_text, options) => {
		options?.preflightResult?.(true, options.streamingBehavior === undefined ? "started" : "queued");
	};
	pauseAnswer: TaskViewResult<PausedTaskMessages> = { ok: true, value: { steering: [], followUp: [] } };
	delivered: readonly string[] = [];
	commandCatalog: AgentViewCommands | undefined;
	lastMessage: string | undefined;

	constructor(status: Partial<AgentViewStatus> & { readonly taskId: TaskId }) {
		this.current = fakeAgentViewStatus(status);
		this.agentKey = this.current.agentKey;
		const port = this;
		this.transcript = {
			render: () => [...port.transcriptLines],
			handleViewKey: () => false,
			capturesInput: () => false,
			handleInput: () => {},
			invalidate: () => {},
		};
		this.steering = {
			get busy() {
				return port.current.busy;
			},
			get paused() {
				return port.current.paused;
			},
			queued: () => port.current.queued,
			prompt: (text, options) => {
				port.calls.push({
					kind: "prompt",
					text,
					...(options?.streamingBehavior ? { lane: options.streamingBehavior } : {}),
				});
				return port.promptAnswer(text, options);
			},
			clearQueue: () => {
				port.calls.push({ kind: "clearQueue" });
				const { steering, followUp } = port.current.queued;
				port.setStatus({ queued: { steering: [], followUp: [] } });
				return { steering: [...steering], followUp: [...followUp] };
			},
			resume: async (text, lane) => {
				port.calls.push({ kind: "resume", text, lane });
			},
		};
	}

	status(): AgentViewStatus {
		return this.current;
	}

	setStatus(change: Partial<AgentViewStatus>): void {
		this.current = { ...this.current, ...change };
		for (const listener of [...this.listeners]) listener();
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async pause(): Promise<TaskViewResult<PausedTaskMessages>> {
		this.calls.push({ kind: "pause" });
		return this.pauseAnswer;
	}

	async prompts(): Promise<readonly string[]> {
		return this.delivered;
	}

	async commands(): Promise<AgentViewCommands | undefined> {
		return this.commandCatalog;
	}

	async lastAgentMessageText(): Promise<string | undefined> {
		return this.lastMessage;
	}

	retain(): () => void {
		this.retained++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.retained--;
			if (this.retained === 0) this.disposed = true;
		};
	}
}

/** A status with every field filled in: a running, idle subagent named "worker". */
export function fakeAgentViewStatus(status: Partial<AgentViewStatus> & { readonly taskId: TaskId }): AgentViewStatus {
	const name = status.name ?? "worker";
	return {
		agentKey: status.taskId,
		name,
		ruleLabel: `${name} · running`,
		placeholder: `Message @${name}…`,
		state: "running",
		busy: false,
		paused: false,
		retrying: false,
		queued: { steering: [], followUp: [] },
		heldPrompt: false,
		gone: false,
		...status,
	};
}
