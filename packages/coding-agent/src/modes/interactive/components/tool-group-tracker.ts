import type { AssistantMessage } from "@bastani/atomic-ai";
import type { ToolGroupFamily, ToolGroupRole } from "./tool-block.ts";

export type ToolGroupMemberState = "pending" | "done" | "failed" | "background";
/**
 * Takes a call's place in its group. A call folded into a group (`hidden`) also gets what stands for the group's first
 * call, as it was appended or bound, so that it can tell whether that call still stands for it.
 */
export type ToolGroupRoleSink = (role: ToolGroupRole, head?: object) => void;

/** The first call of the group a folded call is in, as the folded call's drawing needs it. */
export interface ToolGroupHead {
	/** Whether the first call is expanded; undefined once it is no longer drawn. */
	isExpanded(): boolean | undefined;
}

/**
 * Whether a call folded into a group is drawn, and takes clicks, on its own: a click left it at another expansion than
 * the group's first call, so that call's summary or rows do not stand for it. A call with no first call to compare
 * with is drawn as its group draws it.
 */
export function drawsApartFromGroup(role: ToolGroupRole, expanded: boolean, head: ToolGroupHead | undefined): boolean {
	if (role.kind !== "hidden" || head === undefined) return false;
	const headExpanded = head.isExpanded();
	return headExpanded === undefined || headExpanded !== expanded;
}

interface ToolGroupMember {
	readonly id: string;
	readonly family: ToolGroupFamily | undefined;
	readonly barrierBefore: boolean;
	state: ToolGroupMemberState;
	role: ToolGroupRole;
	/** The group's first call, for a call folded into it. */
	head: ToolGroupMember | undefined;
	apply: ToolGroupRoleSink;
	/** What stands for the call where it is drawn: its row or its entry. */
	handle: object | undefined;
}

const STANDALONE: ToolGroupRole = { kind: "standalone" };
const HIDDEN: ToolGroupRole = { kind: "hidden" };

export function toolGroupFamily(toolName: string, groupBash: boolean): ToolGroupFamily | undefined {
	switch (toolName) {
		case "read":
			return "read";
		case "search":
		case "grep":
			return "search";
		case "find":
			return "find";
		case "ls":
			return "list";
		case "bash":
			return groupBash ? "bash" : undefined;
		default:
			return undefined;
	}
}

export function toolResultGroupState(result: { readonly details?: unknown }, isError: boolean): ToolGroupMemberState {
	if (isError) return "failed";
	const details = result.details;
	if (typeof details !== "object" || details === null || !("observation" in details)) return "done";
	const observation = details.observation;
	return typeof observation === "object" &&
		observation !== null &&
		"kind" in observation &&
		observation.kind === "yielded"
		? "background"
		: "done";
}

export interface AssistantCallBreaks {
	readonly breakBefore: ReadonlySet<string>;
	readonly trailing: boolean;
}

export function assistantCallBreaks(content: AssistantMessage["content"], carried: boolean): AssistantCallBreaks {
	const breakBefore = new Set<string>();
	let visible = carried;
	for (const item of content) {
		if (item.type === "toolCall") {
			if (visible) breakBefore.add(item.id);
			visible = false;
		} else if (
			(item.type === "text" && item.text.trim().length > 0) ||
			(item.type === "thinking" && item.thinking.trim().length > 0)
		)
			visible = true;
	}
	return { breakBefore, trailing: visible };
}

export function sameToolGroupRole(left: ToolGroupRole | undefined, right: ToolGroupRole | undefined): boolean {
	const a = left ?? STANDALONE;
	const b = right ?? STANDALONE;
	if (a.kind !== b.kind) return false;
	if (a.kind !== "head" || b.kind !== "head") return true;
	return (
		a.clauses.length === b.clauses.length &&
		a.clauses.every(
			(clause, index) => clause.family === b.clauses[index]?.family && clause.count === b.clauses[index]?.count,
		)
	);
}

export function toolGroupRoleKey(role: ToolGroupRole | undefined): string {
	if (role === undefined || role.kind === "standalone") return "standalone";
	if (role.kind === "hidden") return "hidden";
	return `head:${role.clauses.map((clause) => `${clause.family}=${clause.count}`).join(",")}`;
}

export class ToolGroupTracker {
	private readonly groupBash: boolean;
	private run: ToolGroupMember[] = [];
	private readonly members = new Map<string, ToolGroupMember>();
	private barrierPending = false;

	constructor(options: { readonly groupBash?: boolean } = {}) {
		this.groupBash = options.groupBash ?? false;
	}

	append(id: string, toolName: string, state: ToolGroupMemberState, apply: ToolGroupRoleSink, handle?: object): void {
		const existing = this.members.get(id);
		if (existing !== undefined) {
			existing.apply = apply;
			this.rehandle(existing, handle);
			existing.state = state;
			this.reclassify();
			return;
		}
		const member: ToolGroupMember = {
			id,
			family: toolGroupFamily(toolName, this.groupBash),
			barrierBefore: this.barrierPending && this.run.length > 0,
			state,
			role: STANDALONE,
			head: undefined,
			apply,
			handle,
		};
		this.barrierPending = false;
		this.run.push(member);
		this.members.set(id, member);
		this.reclassify();
		this.compact();
	}

	settle(id: string, state: ToolGroupMemberState): void {
		const member = this.members.get(id);
		if (member === undefined || member.state === state) return;
		member.state = state;
		this.reclassify();
		this.compact();
	}

	bind(id: string, apply: ToolGroupRoleSink, handle?: object): void {
		const member = this.members.get(id);
		if (member === undefined) return;
		member.apply = apply;
		this.rehandle(member, handle);
		apply(member.role, member.head?.handle);
	}

	/** What now stands for `member`; the calls folded into its group get it too. */
	private rehandle(member: ToolGroupMember, handle: object | undefined): void {
		if (handle === undefined || member.handle === handle) return;
		member.handle = handle;
		if (member.role.kind !== "head") return;
		for (const folded of this.run) if (folded.head === member) folded.apply(folded.role, handle);
	}

	break(): void {
		if (this.run.length === 0) return;
		if (this.run.every((member) => member.state !== "pending")) this.reset();
		else this.barrierPending = true;
	}

	reset(): void {
		this.run = [];
		this.members.clear();
		this.barrierPending = false;
	}

	private compact(): void {
		let settledPrefix = 0;
		for (let index = 0; index < this.run.length; index += 1) {
			const member = this.run[index];
			if (member === undefined) break;
			if (index > 0 && member.barrierBefore) settledPrefix = index;
			if (member.state === "pending") break;
		}
		for (const member of this.run.splice(0, settledPrefix)) this.members.delete(member.id);
	}

	private reclassify(): void {
		let start = 0;
		for (let index = 0; index <= this.run.length; index += 1) {
			const member = this.run[index];
			if (member?.barrierBefore && index > start) {
				this.assignSegment(start, index);
				start = index;
			}
			if (member !== undefined && member.family !== undefined && member.state === "done") continue;
			this.assignSegment(start, index);
			if (member !== undefined) this.assign(member, STANDALONE);
			start = index + 1;
		}
	}

	private assignSegment(start: number, end: number): void {
		const first = this.run[start];
		if (first === undefined || end <= start) return;
		if (end - start === 1) {
			this.assign(first, STANDALONE);
			return;
		}
		const clauses: { family: ToolGroupFamily; count: number }[] = [];
		for (let index = start; index < end; index += 1) {
			const family = this.run[index]?.family;
			if (family === undefined) continue;
			const clause = clauses.find((candidate) => candidate.family === family);
			if (clause) clause.count += 1;
			else clauses.push({ family, count: 1 });
		}
		this.assign(first, { kind: "head", clauses });
		for (let index = start + 1; index < end; index += 1) {
			const member = this.run[index];
			if (member !== undefined) this.assign(member, HIDDEN, first);
		}
	}

	private assign(member: ToolGroupMember, role: ToolGroupRole, head?: ToolGroupMember): void {
		if (sameToolGroupRole(member.role, role) && member.head === head) return;
		member.role = role;
		member.head = head;
		member.apply(role, head?.handle);
	}
}
