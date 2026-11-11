/**
 * A synthetic long-running session for the resume-startup benchmark (#4660): a parent session with a large history
 * across several compactions, a tool loadout, worktree snapshots of its project and of sibling worktrees recorded
 * every few hundred entries, and background subagent children recorded as running. Built straight into the session
 * store, the way the session would have saved it.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSessionHeader } from "../../../packages/coding-agent/src/core/session-manager-entries.ts";
import type { SessionEntry } from "../../../packages/coding-agent/src/core/session-manager-types.ts";
import { resolveSessionStore } from "../../../packages/coding-agent/src/core/session-storage.ts";
import { captureWorktreeSnapshot } from "../../../packages/coding-agent/src/core/worktree-snapshot/capture.ts";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../../../packages/coding-agent/src/core/worktree-snapshot/settings.ts";
import type { WorktreeSnapshot } from "../../../packages/coding-agent/src/core/worktree-snapshot/types.ts";

export interface LargeSessionOptions {
	/** Directory that receives the agent directory, the project and its worktrees. */
	readonly dir: string;
	/** History entries, compactions and snapshot records included. */
	readonly entries: number;
	/** Checkouts the session recorded: the project and `checkouts - 1` sibling worktrees. */
	readonly checkouts: number;
	/** Files in the project. */
	readonly files: number;
	/** Bytes of each tool result, the bulk of a real session's history. */
	readonly toolResultBytes: number;
	readonly compactionEvery: number;
	readonly snapshotEvery: number;
	/** Background subagent children recorded as running when the session stopped. */
	readonly runningChildren: number;
}

export interface LargeSession {
	readonly agentDir: string;
	readonly project: string;
	readonly worktrees: readonly string[];
	readonly sessionId: string;
}

const TOOLS = [
	"read",
	"bash",
	"kill",
	"edit",
	"write",
	"find",
	"search",
	"ask_user_question",
	"todo",
	"subagent",
	"workflow",
	"intercom",
];

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createProject(project: string, files: number): void {
	mkdirSync(project, { recursive: true });
	git(project, "init", "-q", "-b", "main");
	git(project, "config", "user.email", "bench@example.com");
	git(project, "config", "user.name", "bench");
	git(project, "config", "commit.gpgsign", "false");
	git(project, "remote", "add", "origin", "https://example.com/bench/project.git");
	for (let index = 0; index < files; index++) {
		const directory = join(project, "src", `module-${Math.floor(index / 100)}`);
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, `file-${index}.ts`), `export const value${index} = ${index};\n`.repeat(20));
	}
	git(project, "add", "-A");
	git(project, "commit", "-q", "-m", "initial");
}

export async function createLargeSession(options: LargeSessionOptions): Promise<LargeSession> {
	const agentDir = join(options.dir, "agent");
	const project = join(options.dir, "project");
	mkdirSync(agentDir, { recursive: true });
	createProject(project, options.files);
	const worktrees: string[] = [];
	for (let index = 1; index < options.checkouts; index++) {
		const worktree = join(options.dir, `child-worktree-${index}`);
		git(project, "worktree", "add", "-q", "-b", `child-${index}`, worktree);
		writeFileSync(join(worktree, `child-${index}.txt`), "work in progress\n");
		worktrees.push(worktree);
	}
	writeFileSync(join(project, "notes.md"), "uncommitted edit\n");

	const store = await resolveSessionStore(project, { agentDir });
	const roots = [project, ...worktrees];
	const snapshots: WorktreeSnapshot[] = [];
	for (const root of roots) {
		const capture = await captureWorktreeSnapshot(root, {
			settings: DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
			blobs: store.snapshotBlobs,
		});
		if (capture.status !== "captured") throw new Error(`capture of ${root}: ${capture.status}`);
		snapshots.push(capture.snapshot);
	}

	const sessionId = randomUUID();
	const entries: SessionEntry[] = [];
	let parentId: string | null = null;
	let time = Date.now() - options.entries * 1000;
	const output = "o".repeat(options.toolResultBytes);
	const usage = {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const recordedSnapshot = new Set<string>();
	const push = (entry: Omit<SessionEntry, "id" | "parentId" | "timestamp">) => {
		const id = `e${entries.length.toString(36)}`;
		time += 1000;
		entries.push({ ...entry, id, parentId, timestamp: new Date(time).toISOString() } as SessionEntry);
		parentId = id;
	};
	push({
		type: "message",
		message: {
			role: "system",
			content: "",
			sections: {},
			toolsAdded: TOOLS.map((name) => ({ name, description: name, parameters: { type: "object", properties: {} } })),
			timestamp: time,
		},
	} as Omit<SessionEntry, "id" | "parentId" | "timestamp">);
	for (let child = 0; child < options.runningChildren; child++) {
		const worktree = worktrees[child % Math.max(1, worktrees.length)];
		push({
			type: "custom",
			customType: "subagent-child",
			data: {
				version: 1,
				childId: `run-${child}:0`,
				runId: `run-${child}`,
				index: 0,
				agent: "worker",
				state: "running",
				cwd: worktree ?? project,
				owner: { kind: "session", sessionId },
				taskId: `task-${child}`,
				childSessionId: randomUUID(),
				childSessionFile: join(options.dir, "lost-tmp", `child-${child}.jsonl`),
			},
		} as Omit<SessionEntry, "id" | "parentId" | "timestamp">);
	}
	let turn = 0;
	let nextCompaction = options.compactionEvery;
	let nextSnapshot = options.snapshotEvery;
	let snapshotSlot = 0;
	while (entries.length < options.entries) {
		const index = entries.length;
		if (index >= nextCompaction) {
			nextCompaction += options.compactionEvery;
			push({
				type: "compaction",
				summary: "summary ".repeat(200),
				firstKeptEntryId: entries[index - 5]!.id,
				tokensBefore: 150_000,
				details: { strategy: "verbatim-lines", promptVersion: 1, parameters: {}, stats: {}, rung: "planner" },
			} as Omit<SessionEntry, "id" | "parentId" | "timestamp">);
			continue;
		}
		if (index >= nextSnapshot) {
			nextSnapshot += options.snapshotEvery;
			const slot = snapshotSlot++ % roots.length;
			const snapshot = snapshots[slot]!;
			push({
				type: "worktree_snapshot",
				root: roots[slot]!,
				snapshotId: snapshot.id,
				...(recordedSnapshot.has(snapshot.id) ? {} : { snapshot }),
			} as Omit<SessionEntry, "id" | "parentId" | "timestamp">);
			recordedSnapshot.add(snapshot.id);
			continue;
		}
		turn++;
		const callId = `call-${turn}`;
		push({ type: "message", message: { role: "user", content: `request ${turn}`, timestamp: time } } as Omit<
			SessionEntry,
			"id" | "parentId" | "timestamp"
		>);
		push({
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: callId, name: "bash", arguments: { command: `echo ${turn}` } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				usage,
				stopReason: "toolUse",
				timestamp: time,
			},
		} as Omit<SessionEntry, "id" | "parentId" | "timestamp">);
		push({
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: callId,
				toolName: "bash",
				content: [{ type: "text", text: output }],
				isError: false,
				timestamp: time,
			},
		} as Omit<SessionEntry, "id" | "parentId" | "timestamp">);
		push({
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "text", text: `done ${turn}` }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				usage,
				stopReason: "stop",
				timestamp: time,
			},
		} as Omit<SessionEntry, "id" | "parentId" | "timestamp">);
	}

	const { type: _type, ...header } = createSessionHeader(sessionId, project);
	await store.create(header, entries);
	await store.close();

	writeFileSync(join(project, "notes.md"), "merged later\n");
	git(project, "add", "-A");
	git(project, "commit", "-q", "-m", "work merged after the last snapshot");
	return { agentDir, project, worktrees, sessionId };
}
