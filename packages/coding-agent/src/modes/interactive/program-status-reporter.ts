import type { ProgramStatus, Terminal } from "@earendil-works/pi-tui";
import { APP_NAME } from "../../config.js";
import type { AgentSessionEvent } from "../../core/agent-session.js";
import type { WorkflowActivityFrame, WorkflowRootActivity } from "../../core/extensions/workflow-events.js";
import type { JsonAgentSessionEvent } from "../json-event.ts";

export type BlockedStatus = { kind: NonNullable<ProgramStatus["kind"]>; message: string };

function firstLine(text: string | undefined): string {
	return text?.split(/\r?\n/, 1)[0]?.trim() || "Error";
}

/** A root whose run ended failed (or blocked) and awaits inspection; no execution or open prompt remains. */
function isSettledFailure(root: WorkflowRootActivity): boolean {
	return root.state === "idle" && root.actionableBlockCount === 0 && root.needsAttention;
}

export class ProgramStatusReporter {
	private runActive = false;
	private compacting = false;
	private runResult: ProgramStatus = { state: "done" };
	private restingStatus: ProgramStatus = { state: "idle" };
	private readonly blocked = new Map<string, BlockedStatus>();
	private lastReport: string | undefined;
	private readonly roots = new Map<string, WorkflowRootActivity>();
	/** Roots that failed while this session watched; held until the user's next input. */
	private readonly failedRoots = new Set<string>();
	/** A ready snapshot is the baseline; frames before it describe history, not new outcomes. */
	private workflowsReady = false;

	private readonly getTerminal: () => Terminal;
	private readonly getSessionName: () => string | undefined;

	constructor(getTerminal: () => Terminal, getSessionName: () => string | undefined) {
		this.getTerminal = getTerminal;
		this.getSessionName = getSessionName;
	}

	handleEvent(event: AgentSessionEvent | JsonAgentSessionEvent): void {
		switch (event.type) {
			case "agent_start":
				this.runActive = true;
				this.runResult = { state: "done" };
				break;
			case "message_start":
				// The user's next message answers a held workflow failure; lifecycle notices are custom messages.
				if (event.message.role !== "user" || this.failedRoots.size === 0) return;
				this.failedRoots.clear();
				break;
			case "message_end":
				if (event.message.role !== "assistant") return;
				this.runResult =
					event.message.stopReason === "error"
						? { state: "error", message: firstLine(event.message.errorMessage) }
						: { state: "done" };
				break;
			case "compaction_start":
				this.compacting = true;
				break;
			case "compaction_end":
				this.compacting = false;
				if (this.runActive) {
					if (event.aborted) this.runResult = { state: "idle" };
					else if (event.errorMessage) this.runResult = { state: "error", message: firstLine(event.errorMessage) };
				} else if (event.aborted) {
					this.restingStatus = { state: "idle" };
				} else if (event.reason === "manual") {
					this.restingStatus = event.errorMessage
						? { state: "error", message: firstLine(event.errorMessage) }
						: { state: "done" };
				}
				break;
			case "agent_settled":
				this.runActive = false;
				this.restingStatus = event.aborted ? { state: "idle" } : this.runResult;
				break;
			case "session_info_changed":
				break;
			default:
				return;
		}
		this.report();
	}

	handleWorkflowActivity(frame: WorkflowActivityFrame): void {
		if (frame.kind === "snapshot") {
			this.roots.clear();
			this.workflowsReady = frame.availability === "ready";
			if (frame.availability === "ready") {
				for (const root of frame.roots) this.roots.set(root.rootRunId, root);
				for (const id of this.failedRoots) {
					const root = this.roots.get(id);
					if (!root || !isSettledFailure(root)) this.failedRoots.delete(id);
				}
			}
		} else if (frame.kind === "changed") {
			const previous = this.roots.get(frame.root.rootRunId);
			this.roots.set(frame.root.rootRunId, frame.root);
			if (this.workflowsReady) this.recordOutcome(previous, frame.root);
		} else {
			this.roots.delete(frame.rootRunId);
			this.failedRoots.delete(frame.rootRunId);
		}
		this.report();
	}

	private recordOutcome(previous: WorkflowRootActivity | undefined, root: WorkflowRootActivity): void {
		if (isSettledFailure(root)) {
			if (!previous || !isSettledFailure(previous)) this.failedRoots.add(root.rootRunId);
			return;
		}
		this.failedRoots.delete(root.rootRunId);
		const finished =
			previous !== undefined &&
			previous.state !== "idle" &&
			previous.reason !== "stopping" &&
			root.state === "idle" &&
			root.reason !== "paused" &&
			!root.needsAttention;
		if (finished && this.restingStatus.state === "idle") this.restingStatus = { state: "done" };
	}

	setBlocked(source: string, status: BlockedStatus | undefined): void {
		this.blocked.delete(source);
		if (status) this.blocked.set(source, status);
		this.report();
	}

	reset(): void {
		this.runActive = false;
		this.compacting = false;
		this.runResult = { state: "done" };
		this.restingStatus = { state: "idle" };
		this.report();
	}

	report(): void {
		const status: ProgramStatus = { ...this.currentStatus(), app: APP_NAME };
		const key = JSON.stringify(status);
		if (key === this.lastReport) return;
		this.lastReport = key;
		this.getTerminal().setProgramStatus(status);
	}

	private currentStatus(): ProgramStatus {
		const blocked = [...this.blocked.values()].at(-1);
		if (blocked) return { state: "blocked", ...blocked };
		const workflowBlocked = this.workflowBlockedStatus();
		if (workflowBlocked) return workflowBlocked;
		if (this.compacting) return { state: "working", message: "Compacting context" };
		const workflowWorking = [...this.roots.values()].some((root) => root.state === "working");
		if (!this.runActive && !workflowWorking && this.failedRoots.size > 0) {
			return { state: "error", message: "Workflow failed" };
		}
		const status = this.runActive || workflowWorking ? { state: "working" as const } : this.restingStatus;
		if (status.state === "working" || status.state === "done") return { ...status, message: this.getSessionName() };
		return status;
	}

	/**
	 * A root waits for the user when it is blocked, or when a wait is open beside executing work: the
	 * projection reports such a root as `working`. Fixed text only: prompts raised by workflows never
	 * reach the terminal.
	 */
	private workflowBlockedStatus(): ProgramStatus | undefined {
		const waiting = [...this.roots.values()].filter(
			(root) => root.state === "blocked" || root.actionableBlockCount > 0,
		);
		if (waiting.length === 0) return undefined;
		// A root that is still working cannot say whether its wait is a prompt or a manual decision.
		const needsDecision = waiting.every((root) => root.reason === "manual_intervention");
		return {
			state: "blocked",
			kind: "question",
			message: needsDecision ? "Workflow needs attention" : "Workflow waiting for input",
		};
	}
}
