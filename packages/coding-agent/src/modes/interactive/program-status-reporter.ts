import type { ProgramStatus, Terminal } from "@bastani/atomic-tui";
import { APP_NAME } from "../../config.js";
import type { AgentSessionEvent } from "../../core/agent-session.js";
import type { UIPromptEndEvent, UIPromptStartEvent } from "../../core/extensions/agent-events.ts";
import type { JsonAgentSessionEvent } from "../json-event.ts";

export type BlockedStatus = { kind: NonNullable<ProgramStatus["kind"]>; message: string };

function firstLine(text: string | undefined): string {
	return text?.split(/\r?\n/, 1)[0]?.trim() || "Error";
}

export class ProgramStatusReporter {
	private runActive = false;
	private compacting = false;
	private runResult: ProgramStatus = { state: "done" };
	private restingStatus: ProgramStatus = { state: "idle" };
	private readonly blocked = new Map<string, BlockedStatus>();
	private lastReport: string | undefined;

	private readonly getTerminal: () => Terminal;
	private readonly getSessionName: () => string | undefined;
	private readonly canReport: () => boolean;

	constructor(
		getTerminal: () => Terminal,
		getSessionName: () => string | undefined,
		canReport: () => boolean = () => true,
	) {
		this.getTerminal = getTerminal;
		this.getSessionName = getSessionName;
		this.canReport = canReport;
	}

	handleEvent(event: AgentSessionEvent | JsonAgentSessionEvent): void {
		switch (event.type) {
			case "agent_start":
				this.runActive = true;
				this.runResult = { state: "done" };
				break;
			case "message_start":
				if (event.message.role !== "user") return;
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

	handleUIPrompt(event: UIPromptStartEvent | UIPromptEndEvent | undefined): void {
		if (event?.reason === "project_trust") return;
		this.setBlocked(
			"ui-prompt",
			event?.type === "ui_prompt_start"
				? {
						kind: event.kind === "confirm" ? "permission" : "question",
						message: event.kind === "confirm" ? "Waiting for approval" : "Waiting for input",
					}
				: undefined,
		);
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
		if (!this.canReport()) return;
		const status: ProgramStatus = { ...this.currentStatus(), app: APP_NAME };
		const key = JSON.stringify(status);
		if (key === this.lastReport) return;
		this.lastReport = key;
		this.getTerminal().setProgramStatus(status);
	}

	private currentStatus(): ProgramStatus {
		const blocked = [...this.blocked.values()].at(-1);
		if (blocked) return { state: "blocked", ...blocked };
		if (this.compacting) return { state: "working", message: "Compacting context" };
		const status = this.runActive ? { state: "working" as const } : this.restingStatus;
		if (status.state === "working" || status.state === "done") return { ...status, message: this.getSessionName() };
		return status;
	}
}
