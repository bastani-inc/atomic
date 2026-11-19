import { isProxy } from "node:util/types";
import type { CustomMessage, StageAdmittedCustomMessage } from "../messages.js";
import type { SessionEntry } from "../session-manager-types.js";
import { cancelReasonText } from "./cancel-reason.js";

// A lookup must not invoke an extension's getter or inspect a proxy. Persisted JSON has own data properties.
function field(record: unknown, key: string): unknown {
	if (!record || typeof record !== "object" || isProxy(record)) return undefined;
	return Object.getOwnPropertyDescriptor(record, key)?.value;
}

const STOP_END =
	/ (?:killed \(non-resumable\)|timed out|stopped(?: \((?:task owner closed|session closed|workflow stage closed|Atomic shut down)\))?)$/u;
const QUOTED_OUTCOME =
	/^(?:(?:paused · awaiting resume|quit · paused, awaiting resume)(?:: |\.$)|released while waiting on (?:a tool call|.+?\))(?:: |\.$))/su;

type Card = Extract<SessionEntry, { type: "custom_message" }>;
export interface LegacyCompletionTarget {
	readonly id: string;
	readonly title: string;
	readonly taskId: string;
}

/** Only the old title collision. Neither a body, a preview, a saved line/result/name, nor a task number is evidence. */
export function legacyCompletionTarget(entry: SessionEntry): LegacyCompletionTarget | undefined {
	return entry.type === "custom_message" ? completionTarget(entry) : undefined;
}

function completionTarget(entry: Card | StageAdmittedCustomMessage): LegacyCompletionTarget | undefined {
	if (entry.customType !== "task-completion" || !entry.display) return undefined;
	const details = field(entry, "details");
	if (!details || typeof details !== "object" || isProxy(details) || "result" in details) return undefined;
	const notice = field(details, "notification");
	if (!notice || typeof notice !== "object" || isProxy(notice) || "line" in notice || "agentName" in notice)
		return undefined;
	const completion = field(details, "completionId");
	const id = field(entry, "stageAdmissionKey") ?? completion;
	if (typeof id !== "string" || !id || (completion !== undefined && id !== completion)) return undefined;
	const taskId = field(notice, "taskId");
	const savedTask = field(details, "taskId");
	if (typeof taskId !== "string" || !taskId || (savedTask !== undefined && taskId !== savedTask)) return undefined;
	if (
		field(notice, "status") !== "cancelled" ||
		field(notice, "preview") !== "" ||
		field(notice, "taskKind") === "command" ||
		field(details, "taskKind") === "command"
	)
		return undefined;
	const title = field(notice, "title");
	const body = field(entry, "content");
	if (typeof title !== "string" || !title.startsWith("Subagent ") || (body !== "" && body !== title)) return undefined;
	const colon = title.indexOf(": ");
	if (colon < 0 || !STOP_END.test(title.slice(0, colon)) || !QUOTED_OUTCOME.test(title.slice(colon + 2)))
		return undefined;
	return { id, title, taskId };
}

interface StopWitness {
	readonly id: string;
	readonly taskId: string;
	readonly ownerId?: string;
	readonly terminalSequence?: string;
	readonly wording: string;
	readonly earlySpelling: boolean;
}

/** Retain the identity and spelling only, not the result, its owner, or a discarded title. */
function stopWitness(intent: unknown): StopWitness | undefined {
	const id = field(intent, "completionId");
	const taskId = field(intent, "taskId");
	const ownerId = field(intent, "ownerId");
	const terminalSequence = field(intent, "terminalSequence");
	if (
		typeof id !== "string" ||
		typeof taskId !== "string" ||
		(ownerId !== undefined && typeof ownerId !== "string") ||
		(terminalSequence !== undefined && typeof terminalSequence !== "string") ||
		field(intent, "taskKind") === "command"
	)
		return undefined;
	const result = field(intent, "result");
	if (field(result, "kind") !== "cancelled" || field(result, "released") !== undefined) return undefined;
	let wording: string;
	const cause = field(result, "cause");
	switch (cause) {
		case "user":
			wording = "killed (non-resumable)";
			break;
		case "execution-timeout":
			wording = "timed out";
			break;
		case "owner-close": {
			const ownerClose = field(result, "ownerClose");
			if (
				ownerClose !== undefined &&
				ownerClose !== "session-close" &&
				ownerClose !== "stage-close" &&
				ownerClose !== "app-shutdown"
			)
				return undefined;
			wording = `stopped (${cancelReasonText({ kind: "cancelled", cause, ownerClose })})`;
			break;
		}
		case "shutdown":
		case "output-limit":
		case "parent-handoff":
			wording = "stopped";
			break;
		default:
			return undefined;
	}
	return {
		id,
		taskId,
		ownerId,
		terminalSequence,
		wording,
		earlySpelling: cause === "execution-timeout" || cause === "owner-close",
	};
}

function stopName(message: CustomMessage, target: LegacyCompletionTarget, witness: StopWitness): string | undefined {
	if (witness.id !== target.id || witness.taskId !== target.taskId) return undefined;
	for (const key of ["ownerId", "terminalSequence"] as const) {
		const saved = field(message.details, key);
		if (saved !== undefined && saved !== witness[key]) return undefined;
	}
	// 0.9.76 wrote bare `stopped` for timeouts and owner closure. A name can itself include an entire stop and
	// description: if two boundaries fit the writer, we know it stopped but cannot claim either name.
	const title = target.title;
	let name: string | undefined;
	for (const status of witness.earlySpelling ? [witness.wording, "stopped"] : [witness.wording]) {
		const delimiter = ` ${status}: `;
		for (
			let at = title.indexOf(delimiter, Math.max(9, title.length - 240 - delimiter.length));
			at >= 0;
			at = title.indexOf(delimiter, at + 1)
		) {
			const tail = title.slice(at + delimiter.length);
			if (!tail || /[\x00-\x1f\x7f-\x9f]/u.test(tail)) continue;
			if (name !== undefined) return "Subagent";
			name = title.slice("Subagent ".length, at).trim() || "Subagent";
		}
		if (title.endsWith(` ${status}.`)) {
			if (name !== undefined) return "Subagent";
			name = title.slice("Subagent ".length, -(status.length + 2)).trim() || "Subagent";
		}
	}
	return name;
}

// Presentation only: neither the durable entry, the model message, nor the shared parsed notice gains a field.
const witnesses = new WeakMap<CustomMessage, StopWitness>();
export function reopenedCompletionName(message: CustomMessage): string | undefined {
	const witness = witnesses.get(message);
	if (!witness) return undefined;
	const target = completionTarget(message);
	return target && stopName(message, target, witness);
}

/** Names learned from an intent preceding the current window, scoped to the saved card (not the process's task ID). */
const earlierWitnesses = new WeakMap<Card, StopWitness>();
export function rememberEarlierCompletion(entry: SessionEntry, target: LegacyCompletionTarget, intent: unknown): void {
	if (entry.type !== "custom_message" || field(intent, "completionId") !== target.id) return;
	const witness = stopWitness(intent);
	if (witness) earlierWitnesses.set(entry, witness);
}

/** One index per projection, built only if it actually contains a damaged legacy card. */
export class ReopenedCompletionHeaders {
	private recorded?: Map<Card, StopWitness>;
	private readonly branch: () => readonly SessionEntry[];
	constructor(branch: () => readonly SessionEntry[]) {
		this.branch = branch;
	}
	apply(entry: Card, message: CustomMessage): void {
		if (!legacyCompletionTarget(entry)) return;
		if (!this.recorded) {
			const intents = new Map<string, unknown>();
			this.recorded = new Map();
			for (const item of this.branch()) {
				if (item.type === "custom" && item.customType === "task-completion-intent") {
					const id = field(item.data, "completionId");
					if (typeof id === "string") intents.set(id, intents.has(id) ? undefined : item.data);
				} else if (item.type === "custom_message") {
					const target = legacyCompletionTarget(item);
					if (!target) continue;
					const witness = intents.has(target.id)
						? stopWitness(intents.get(target.id))
						: earlierWitnesses.get(item);
					if (witness) this.recorded.set(item, witness);
				}
			}
		}
		const witness = this.recorded.get(entry);
		if (witness) witnesses.set(message, witness);
	}
}
