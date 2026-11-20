/**
 * A subagent of the isolated engine, as the host's single chat screen shows it. The engine runs the subagent's port
 * (`LocalAgentViewPort`) and draws its transcript as a remote component the host paints where its main transcript is;
 * this proxy carries the status the engine reports for the view, and the view's commands.
 */
import type { TuiMouseEvent, TuiMouseEventResult } from "@bastani/atomic-tui";
import type { TaskId } from "../../../core/tasks/contracts.js";
import { type RemoteTranscriptMount, remoteTranscriptMount } from "../../interactive-engine/remote-component.ts";
import { type PlacedTranscriptFrame, placeTranscriptFrame } from "../../interactive-engine/transcript-frame-layout.ts";
import type { AgentViewOpenData } from "../../rpc/agent-view-rpc-types.ts";
import { remoteAgentCommands } from "./agent-commands.ts";
import { remoteAgentPrompts } from "./agent-prompts.ts";
import { type AgentViewRuntime, createRemoteAgentSteering } from "./agent-steering.ts";
import type {
	AgentSteeringPort,
	AgentTranscriptComponent,
	AgentViewCommands,
	AgentViewPort,
	AgentViewStatus,
} from "./contracts.ts";

/** How long an open waits for the transcript's first frame before it shows the subagent anyway. */
export const FIRST_FRAME_TIMEOUT_MS = 2_000;

/** The engine's transcript component, in the rows the transcript area gives it. */
export class RemoteAgentTranscript implements AgentTranscriptComponent {
	private readonly mount: RemoteTranscriptMount;
	private readonly heldPrompt: () => boolean;
	/** How the frame painted last was placed in the rows shown (`PlacedTranscriptFrame`). */
	private frameRows: PlacedTranscriptFrame["frameRows"];
	private hidden = 0;

	constructor(mount: RemoteTranscriptMount, heldPrompt: () => boolean) {
		this.mount = mount;
		this.heldPrompt = heldPrompt;
	}

	renderSized(width: number, height: number): string[] {
		this.mount.rows = Math.max(1, height);
		const component = this.mount.component;
		const lines = component.render(width);
		// A frame drawn for another height until the next one is here: its rows go where that frame will put them.
		const placed = placeTranscriptFrame(lines, component.paintedLayout(), width, height);
		this.frameRows = placed.frameRows;
		this.hidden = placed.hidden;
		return placed.lines;
	}

	render(width: number): string[] {
		return this.renderSized(width, this.mount.rows);
	}

	handleViewKey(data: string): boolean {
		void this.mount.component.handleInput(data);
		return true;
	}

	capturesInput(): boolean {
		return this.heldPrompt();
	}

	handleInput(data: string): void {
		void this.mount.component.handleInput(data);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const row = this.frameRow(event.y);
		return row === undefined ? undefined : this.mount.component.handleMouse({ ...event, y: row });
	}

	paintedRowKey(row: number): string | undefined {
		const frameRow = this.frameRow(row);
		return frameRow === undefined ? undefined : this.mount.component.paintedRowKey(frameRow);
	}

	/** The frame row painted at `row`: a row the host left blank until the next frame takes no click. */
	private frameRow(row: number): number | undefined {
		const frameRows = this.frameRows;
		if (frameRows === undefined) return row + this.hidden;
		const index = Math.floor(row);
		return index >= 0 && index < frameRows.length ? frameRows[index] : undefined;
	}

	invalidate(): void {
		this.mount.component.invalidate();
	}
}

/** View `viewId` of the engine: its status as last reported, its transcript, and its steering. */
export class RemoteAgentViewPort implements AgentViewPort {
	readonly agentKey: string;
	readonly viewId: string;
	readonly transcript: RemoteAgentTranscript;
	readonly steering: AgentSteeringPort["steering"];
	private readonly steeringPort: AgentSteeringPort;
	private readonly runtime: AgentViewRuntime;
	private readonly generation: number;
	private readonly listeners = new Set<() => void>();
	private current: AgentViewStatus;
	private retained = 0;
	private disposed = false;
	private readonly unsubscribe: (() => void)[] = [];

	constructor(runtime: AgentViewRuntime, data: AgentViewOpenData, mount: RemoteTranscriptMount) {
		this.runtime = runtime;
		this.viewId = data.viewId;
		this.agentKey = data.status.agentKey;
		this.current = data.status;
		this.generation = runtime.getGeneration();
		this.transcript = new RemoteAgentTranscript(mount, () => this.current.heldPrompt);
		this.steeringPort = createRemoteAgentSteering({
			runtime,
			viewId: data.viewId,
			status: () => this.status(),
			onStatus: (listener) => this.subscribe(listener),
		});
		this.steering = this.steeringPort.steering;
		this.unsubscribe.push(
			runtime.onEngineMessage((message) => {
				if (message.type === "engine_agent_view_status" && message.viewId === this.viewId)
					this.setStatus(message.status);
			}),
			// The engine is gone, and its subagents with it: the screen shows main.
			runtime.onGenerationEnded(() => this.setStatus({ ...this.current, gone: true })),
			mount.onClose(() => this.setStatus({ ...this.current, gone: true })),
		);
	}

	status(): AgentViewStatus {
		return this.current;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	pause() {
		return this.steeringPort.pause();
	}

	prompts(): Promise<readonly string[]> {
		return remoteAgentPrompts(this.runtime, this.current.taskId);
	}

	commands(): Promise<AgentViewCommands | undefined> {
		return remoteAgentCommands(this.runtime, this.viewId);
	}

	async lastAgentMessageText(): Promise<string | undefined> {
		const answer = await this.runtime.requestAgentView<{ text?: string }>({
			type: "agent_view_last_message",
			viewId: this.viewId,
		});
		return answer.text;
	}

	retain(): () => void {
		this.retained++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			if (--this.retained === 0) this.dispose();
		};
	}

	private setStatus(status: AgentViewStatus): void {
		if (this.disposed) return;
		// Once gone, the view stays gone: a late report of the closed view changes nothing.
		this.current = this.current.gone ? { ...status, gone: true } : status;
		for (const listener of [...this.listeners]) {
			try {
				listener();
			} catch {
				// A listener's failure must not stop the others.
			}
		}
	}

	private dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
		this.listeners.clear();
		if (this.runtime.getGeneration() !== this.generation) return;
		void this.runtime.requestAgentView({ type: "agent_view_close", viewId: this.viewId }).catch(() => {
			// The engine closes its views with it.
		});
	}
}

/**
 * Open view of the subagent `taskId` is an attempt of in the engine, once its transcript's first frame is here (or
 * after `FIRST_FRAME_TIMEOUT_MS`): the screen never shows the subagent before there is something to draw.
 */
export async function openRemoteAgentViewPort(
	runtime: AgentViewRuntime,
	taskId: TaskId,
	frame: { readonly width: number; readonly rows: number; readonly colorDepth?: number },
): Promise<RemoteAgentViewPort | undefined> {
	const data = await runtime.requestAgentView<AgentViewOpenData>({ type: "agent_view_open", taskId });
	const mount = remoteTranscriptMount(runtime, data.viewId);
	if (mount === undefined || mount.closed) {
		void runtime.requestAgentView({ type: "agent_view_close", viewId: data.viewId }).catch(() => {});
		throw new Error("The subagent's transcript did not open.");
	}
	const port = new RemoteAgentViewPort(runtime, data, mount);
	if (frame.colorDepth !== undefined) mount.component.hostColorDepth = frame.colorDepth;
	mount.rows = Math.max(1, frame.rows);
	mount.component.prime(Math.max(1, frame.width), mount.rows);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const framed = await Promise.race([
		mount.firstFrame(),
		new Promise<boolean>((resolve) => {
			timer = setTimeout(() => resolve(true), FIRST_FRAME_TIMEOUT_MS);
			timer.unref?.();
		}),
	]);
	clearTimeout(timer);
	if (!framed) {
		port.retain()();
		return undefined;
	}
	return port;
}
