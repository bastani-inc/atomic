import type { AssistantMessage } from "@bastani/atomic-ai";
import type { ToolGroupFamily, ToolGroupRole } from "./tool-block.ts";

export type ToolGroupMemberState = "pending" | "done" | "failed" | "background";
export type ToolGroupRoleSink = (role: ToolGroupRole) => void;

interface ToolGroupMember {
	readonly id: string;
	readonly family: ToolGroupFamily | undefined;
	readonly barrierBefore: boolean;
	state: ToolGroupMemberState;
	role: ToolGroupRole;
	apply: ToolGroupRoleSink;
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

	append(id: string, toolName: string, state: ToolGroupMemberState, apply: ToolGroupRoleSink): void {
		const existing = this.members.get(id);
		if (existing !== undefined) {
			existing.apply = apply;
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
			apply,
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

	bind(id: string, apply: ToolGroupRoleSink): void {
		const member = this.members.get(id);
		if (member === undefined) return;
		member.apply = apply;
		apply(member.role);
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
			if (member !== undefined) this.assign(member, HIDDEN);
		}
	}

	private assign(member: ToolGroupMember, role: ToolGroupRole): void {
		if (sameToolGroupRole(member.role, role)) return;
		member.role = role;
		member.apply(role);
	}
}
