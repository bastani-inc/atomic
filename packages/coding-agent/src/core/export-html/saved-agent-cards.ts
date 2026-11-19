import type { AssistantMessage, ToolCall } from "@bastani/atomic-ai/compat";
import type { SessionEntry, SessionManager } from "../session-manager.ts";

/** Entry addresses, not provider call IDs: separate turns and fork receipts may reuse those IDs. */
export interface SavedAgentCard {
	launch: string;
	receipt: string;
	/** Final text block in the last child message when no explicit finalOutput was recorded. */
	answerBlock?: number;
	/** Roots of maximal subtrees that all prove this card; the receipt itself when omitted. */
	branches?: string[];
	/** Selectable prefixes with both a supported and a contradictory continuation. */
	prefixes?: string[];
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

/** A scoped receipt must be readable by the ordinary tool renderer before replacing its fallback. */
function readableResult(content: unknown, nestedCalls: unknown): boolean {
	if (
		!Array.isArray(content) ||
		!content.every((item: unknown) => {
			const block = record(item);
			return (
				(block?.type === "text" && typeof block.text === "string") ||
				(block?.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string")
			);
		})
	)
		return false;
	const calls = record(nestedCalls)?.calls;
	return (
		!Array.isArray(calls) ||
		calls.every((item: unknown) => {
			const call = record(item);
			return (
				call &&
				typeof call.name === "string" &&
				typeof call.status === "string" &&
				(call.error === undefined || typeof call.error === "string") &&
				(call.durationMs === undefined || typeof call.durationMs === "number") &&
				(call.argumentsBytes === undefined || typeof call.argumentsBytes === "number")
			);
		})
	);
}

function marker(entry: SessionEntry | undefined): boolean {
	return entry?.type === "custom" && entry.customType === "subagent-child";
}

type PreviousTurn = (entry: SessionEntry) => SessionEntry | undefined;

/** Resolve only bookkeeping ancestors, once each, including on forks or out-of-order recordings. */
function previousTurns(sm: SessionManager): PreviousTurn {
	let markers: Map<string, SessionEntry | undefined> | undefined;
	return (entry) => {
		let parent = entry.parentId ? sm.getEntry(entry.parentId) : undefined;
		if (!parent || !marker(parent)) return parent;
		markers ??= new Map();
		const path: string[] = [];
		while (parent && marker(parent)) {
			if (markers.has(parent.id)) {
				parent = markers.get(parent.id);
				break;
			}
			path.push(parent.id);
			markers.set(parent.id, undefined); // A cycle cannot prove a launch.
			parent = parent.parentId ? sm.getEntry(parent.parentId) : undefined;
		}
		for (const id of path) markers.set(id, parent);
		return parent;
	};
}

/** The viewer stops at a missing or self parent, but a disconnected parent cycle has no selectable path. */
function rootedLaunches(sm: SessionManager, entries: SessionEntry[]): (id: string) => boolean {
	const checking = 1,
		rooted = 2,
		cyclic = 3;
	let states: Uint8Array | undefined;
	// Sequences in a fully opened session file are its one-based entry positions.
	const parent = (seq: number) => {
		const entry = entries[seq - 1];
		return entry?.parentId && entry.parentId !== entry.id ? (sm.getEntrySeq(entry.parentId) ?? 0) : 0;
	};
	return (id) => {
		const start = sm.getEntrySeq(id);
		if (start === undefined) return false;
		if (!parent(start)) return true;
		// Check each candidate ancestor at most once. No unrelated calls or arguments are indexed.
		states ??= new Uint8Array(entries.length + 1);
		let seq = start;
		while (seq && !states[seq]) {
			states[seq] = checking;
			seq = parent(seq);
		}
		const outcome = !seq || states[seq] === rooted ? rooted : cyclic;
		for (seq = start; seq && states[seq] === checking; seq = parent(seq)) states[seq] = outcome;
		return outcome === rooted;
	};
}

function singleLaunchCall(content: AssistantMessage["content"]): ToolCall | null {
	let call: ToolCall | null = null;
	for (const block of content) {
		if (block?.type !== "toolCall") continue;
		if (call || block.name !== "subagent") return null;
		const args = record(block.arguments);
		if (
			!args ||
			args.action !== undefined ||
			args.tasks !== undefined ||
			typeof args.agent !== "string" ||
			typeof args.task !== "string"
		)
			return null;
		call = block;
	}
	return call;
}

interface SavedReceipt {
	toolCallId: string;
	child?: Record<string, unknown>;
	answerBlock?: number;
}

function savedReceipt(sm: SessionManager, entry: SessionEntry): SavedReceipt | undefined {
	if (entry.type !== "message" || entry.message.role !== "toolResult") return;
	const receipt = entry.message;
	if (receipt.toolName !== "subagent" || receipt.isError || !receipt.toolCallId) return;
	const details = record(receipt.details);
	if (details?.mode !== "single" || !Array.isArray(details.results)) return;
	if (details.ownerSessionId !== undefined && details.ownerSessionId !== sm.getSessionId()) return;
	if (details.results.length === 0) {
		const response = record(details.taskResponse);
		const observation = record(response?.observation);
		if (response?.kind === "admitted" && observation?.kind === "yielded" && typeof observation.taskId === "string") {
			if (readableResult(receipt.content, receipt.nestedCalls)) return { toolCallId: receipt.toolCallId };
		}
		return;
	}
	const child = record(details.results[0]);
	if (
		details.results.length !== 1 ||
		child?.status !== "ok" ||
		child.detached ||
		typeof child.agent !== "string" ||
		typeof child.task !== "string"
	)
		return;
	let answer = child.finalOutput;
	let answerBlock: number | undefined;
	const messages: unknown[] | undefined = Array.isArray(child.messages) ? child.messages : undefined;
	if (answer === undefined && messages) {
		const last = record(messages[messages.length - 1]);
		if (
			last?.role === "assistant" &&
			last.stopReason === "stop" &&
			!last.errorMessage &&
			Array.isArray(last.content)
		) {
			for (let i = last.content.length - 1; i >= 0; i--) {
				const block = record(last.content[i]);
				if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
					answer = block.text;
					answerBlock = i;
					break;
				}
			}
		}
	}
	if (typeof answer !== "string" || !answer.trim()) return;
	const inline = messages?.some((value) => {
		const msg = record(value);
		return (
			msg?.role === "assistant" &&
			Array.isArray(msg.content) &&
			msg.content.some((b: unknown) => {
				const block = record(b);
				return block?.type === "toolCall" && typeof block.name === "string";
			})
		);
	});
	if (
		!inline &&
		!(
			Array.isArray(child.toolCalls) &&
			child.toolCalls.length &&
			child.toolCalls.every((s: unknown) => {
				const summary = record(s);
				const line = summary?.expandedText || summary?.text;
				return typeof line === "string" && line.length > 0;
			})
		)
	)
		return;
	if (readableResult(receipt.content, receipt.nestedCalls))
		return { toolCallId: receipt.toolCallId, child, answerBlock };
}

/** Do not embed viewer code unless a complete recorded branch can show a card. */
export function savedAgentCards(sm: SessionManager, entries: SessionEntry[]): SavedAgentCard[] | undefined {
	if (sm.getEntryCount() !== entries.length) return; // A reused entry address cannot identify its own receipt.
	const previousTurn = previousTurns(sm);
	let calls: Map<SessionEntry, ToolCall | null> | undefined;
	let rooted: ReturnType<typeof rootedLaunches> | undefined;
	let cards: SavedAgentCard[] | undefined;
	for (const entry of entries) {
		const receipt = savedReceipt(sm, entry);
		if (!receipt) continue;
		const launch = previousTurn(entry);
		if (launch?.type !== "message" || launch.message.role !== "assistant" || !Array.isArray(launch.message.content))
			continue;
		// Fork receipts share a launch. Remember even an ambiguous launch, but never scan one for a compacted receipt.
		calls ??= new Map();
		let call = calls.get(launch);
		if (call === undefined) {
			call = singleLaunchCall(launch.message.content);
			calls.set(launch, call);
		}
		if (!call || call.id !== receipt.toolCallId) continue;
		if (receipt.child && (receipt.child.agent !== call.arguments.agent || receipt.child.task !== call.arguments.task))
			continue;
		rooted ??= rootedLaunches(sm, entries);
		if (!rooted(launch.id)) continue;
		cards ??= [];
		cards.push({ launch: launch.id, receipt: entry.id, answerBlock: receipt.answerBlock });
	}
	if (!cards) return;

	// A second result before the next turn makes that path ambiguous. A sibling path may still
	// be eligible. Track only real cards and any intervening child markers, not all session rows.
	const tips = new Map(cards.map((card) => [card.receipt, card]));
	for (const entry of entries) {
		if (!marker(entry)) continue;
		const parent = previousTurn(entry);
		const card = parent && tips.get(parent.id);
		if (card) tips.set(entry.id, card);
	}
	const parents = new Set<string>();
	const supported = new Set<string>();
	const contradicted = new Set<string>();
	for (const entry of entries) {
		if (!entry.parentId || entry.parentId === entry.id || !tips.has(entry.parentId)) continue;
		parents.add(entry.parentId);
		if (marker(entry)) continue;
		const outcomes = entry.type === "message" && entry.message.role === "toolResult" ? contradicted : supported;
		outcomes.add(entry.parentId);
	}
	if (!contradicted.size) return cards;
	for (const id of tips.keys()) if (!parents.has(id)) supported.add(id);
	// A marker prefix is supported only if a complete continuation through *that prefix* is supported.
	for (const outcomes of [supported, contradicted]) {
		for (const id of outcomes) {
			const parent = sm.getEntry(id)?.parentId;
			if (parent && tips.has(parent)) outcomes.add(parent);
		}
	}
	for (const [id, card] of tips) {
		if (!supported.has(id) || !contradicted.has(id)) continue;
		card.prefixes ??= [];
		card.prefixes.push(id);
		card.branches ??= [];
	}
	// Register only the first entry that proves the card permanently on each such branch.
	// A branch with a conflicting receipt never even schedules a card during navigation.
	for (const entry of entries) {
		if (!entry.parentId || !supported.has(entry.parentId) || !contradicted.has(entry.parentId)) continue;
		if (contradicted.has(entry.id) || (entry.type === "message" && entry.message.role === "toolResult")) continue;
		tips.get(entry.parentId)!.branches!.push(entry.id);
	}
	const selected = cards.filter((card) => supported.has(card.receipt));
	return selected.length ? selected : undefined;
}
