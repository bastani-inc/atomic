import type { CustomMessage, StageAdmittedCustomMessage } from "../messages.ts";
import type { SessionEntry } from "../session-manager-types.ts";
import type { SessionRecoveryState } from "../storage/session/types.js";
import { cancelReasonText } from "./cancel-reason.js";

// Stores read decoded JSON. Hosts that also see extension objects supply their native proxy check before reflection.
export type CompletionProxyCheck = (value: object) => boolean;
function readable(value: unknown, isProxy?: CompletionProxyCheck): value is object {
	return value !== null && typeof value === "object" && !isProxy?.(value);
}
function field(record: object, key: string): unknown {
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
export function legacyCompletionTarget(
	entry: SessionEntry,
	isProxy?: CompletionProxyCheck,
): LegacyCompletionTarget | undefined {
	return entry.type === "custom_message" ? completionTarget(entry, isProxy) : undefined;
}

function completionTarget(
	entry: Card | StageAdmittedCustomMessage,
	isProxy?: CompletionProxyCheck,
): LegacyCompletionTarget | undefined {
	if (!readable(entry, isProxy) || entry.customType !== "task-completion" || !entry.display) return undefined;
	const details = field(entry, "details");
	if (!readable(details, isProxy) || "result" in details) return undefined;
	const notice = field(details, "notification");
	if (!readable(notice, isProxy) || "line" in notice || "agentName" in notice) return undefined;
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
function stopWitness(intent: unknown, isProxy?: CompletionProxyCheck): StopWitness | undefined {
	if (!readable(intent, isProxy)) return undefined;
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
	if (!readable(result, isProxy) || field(result, "kind") !== "cancelled" || field(result, "released") !== undefined)
		return undefined;
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
			// Results stored by earlier releases may name a workflow stage's close, which reads as the session's.
			wording = `stopped (${cancelReasonText({ kind: "cancelled", cause, ownerClose: ownerClose === "stage-close" ? "session-close" : ownerClose })})`;
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

function stopName(details: object, target: LegacyCompletionTarget, witness: StopWitness): string | undefined {
	if (witness.id !== target.id || witness.taskId !== target.taskId) return undefined;
	for (const key of ["ownerId", "terminalSequence"] as const) {
		const saved = field(details, key);
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
export function reopenedCompletionName(message: CustomMessage, isProxy: CompletionProxyCheck): string | undefined {
	const witness = witnesses.get(message);
	if (!witness) return undefined;
	const target = completionTarget(message, isProxy);
	const details = target && field(message, "details");
	return target && readable(details, isProxy) ? stopName(details, target, witness) : undefined;
}

/** An SDK caller can copy the same entry object into a different session. Evidence outside the window belongs to
 * the store snapshot that supplied it, not to that entry on its own. Neither weak key keeps a session alive. */
const earlierWitnesses = new WeakMap<SessionRecoveryState, WeakMap<Card, StopWitness>>();
export function rememberEarlierCompletion(
	scope: SessionRecoveryState,
	entry: SessionEntry,
	target: LegacyCompletionTarget,
	intent: unknown,
	isProxy?: CompletionProxyCheck,
): void {
	if (entry.type !== "custom_message") return;
	const witness = stopWitness(intent, isProxy);
	if (witness?.id !== target.id) return;
	let cards = earlierWitnesses.get(scope);
	if (!cards) {
		cards = new WeakMap();
		earlierWitnesses.set(scope, cards);
	}
	cards.set(entry, witness);
}

type RecordedBranch = { readonly entries: readonly SessionEntry[]; readonly recovery?: SessionRecoveryState };

/** One index per projection, built only if it actually contains a damaged legacy card. */
export class ReopenedCompletionHeaders {
	private recorded?: Map<Card, StopWitness>;
	private readonly branch: () => RecordedBranch;
	private readonly isProxy: CompletionProxyCheck;
	constructor(branch: () => RecordedBranch, isProxy: CompletionProxyCheck) {
		this.branch = branch;
		this.isProxy = isProxy;
	}
	apply(entry: Card, message: CustomMessage): void {
		if (!legacyCompletionTarget(entry, this.isProxy)) return;
		if (!this.recorded) {
			const { entries, recovery } = this.branch();
			const earlier = recovery && earlierWitnesses.get(recovery);
			const intents = new Map<string, unknown>();
			this.recorded = new Map();
			for (const item of entries) {
				if (item.type === "custom" && item.customType === "task-completion-intent") {
					const data = item.data;
					const id = readable(data, this.isProxy) ? field(data, "completionId") : undefined;
					if (typeof id === "string") intents.set(id, intents.has(id) ? undefined : data);
				} else if (item.type === "custom_message") {
					const target = legacyCompletionTarget(item, this.isProxy);
					if (!target) continue;
					const witness = intents.has(target.id)
						? stopWitness(intents.get(target.id), this.isProxy)
						: earlier?.get(item);
					if (witness) this.recorded.set(item, witness);
				}
			}
		}
		const witness = this.recorded.get(entry);
		if (witness) witnesses.set(message, witness);
	}
}
