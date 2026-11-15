/**
 * A crash after every journal write of a budgeted run whose child has its own token budget, then a resume in a new
 * process (#5053). Every resume that can reopen its sessions must finish and charge each paid prompt exactly once, to
 * the child and to the root, and the child never spends past its own cap. The fixture's sessions are mocks with no
 * session store: a resume that must reopen a stage's session interrupted mid-prompt ends with "Session not found",
 * which is the only failure the sweep allows.
 */

import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Type } from "typebox";
import { afterEach, describe, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { BUDGET_WRAP_UP_PROMPT } from "../../packages/workflows/src/engine/run-budget.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { JournalTestBackend } from "../helpers/journal-backend.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import {
	type AgentSession,
	type AgentSessionAdapter,
	assistantMessageWithUsage,
	makeMockSession,
} from "./stage-runner-helpers.js";

const TOKENS = 5;
const RUN_ID = "budget-crash-sweep";
const ROOT_BUDGET = { maxTokens: 1_000 };

interface Prompts {
	child: number;
	parent: number;
}

/** Every work prompt spends 5 tokens; a budget wrap-up turn spends nothing. */
function spending(prompts: Prompts): AgentSessionAdapter {
	return {
		async create() {
			const messages: AgentSession["messages"] = [];
			let answer = "";
			return makeMockSession({
				messages,
				async prompt(text) {
					const wrapUp = text === BUDGET_WRAP_UP_PROMPT;
					if (!wrapUp) prompts[text === "child-work" ? "child" : "parent"] += 1;
					answer = wrapUp ? "wrap-up" : "work";
					messages.push(
						assistantMessageWithUsage(answer, {
							input: wrapUp ? 0 : TOKENS,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							cost: 0,
						}),
					);
				},
				getLastAssistantText: () => answer,
			}).session;
		},
	};
}

function definition(childTokens: number) {
	const child = workflow({
		name: "budget-crash-child",
		description: "",
		inputs: {},
		outputs: { done: Type.String() },
		run: async (ctx) => {
			for (let index = 1; index <= 6; index++)
				await ctx.stage(`c${index}`, { model: "test/model" }).prompt("child-work");
			return { done: "child" };
		},
	});
	return workflow({
		name: "budget-crash-parent",
		description: "",
		inputs: {},
		outputs: { result: Type.String() },
		run: async (ctx) => {
			await ctx.stage("p0", { model: "test/model" }).prompt("parent-work");
			await ctx.workflow(child, { stageName: "child", budget: { maxTokens: childTokens } });
			await ctx.stage("p1", { model: "test/model" }).prompt("parent-work");
			return { result: "done" };
		},
	});
}

/** Expire every lease, as a process that crashed long ago would have left it. */
function expireLeases(path: string): void {
	const db = new DatabaseSync(path);
	try {
		const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%lease%'").all() as {
			name: string;
		}[];
		for (const { name } of tables) {
			const columns = (db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]).map((c) => c.name);
			const renewed = columns.find((column) => /renew/i.test(column));
			if (renewed) db.exec(`UPDATE "${name}" SET "${renewed}" = "${renewed}" - 100000000`);
		}
	} finally {
		db.close();
	}
}

interface CrashPoint {
	readonly path: string;
	readonly before: Prompts;
}

/** Run once to completion, copying the journal after each write: each copy is the state a crash there leaves. */
async function crashPoints(directory: string, childTokens: number): Promise<CrashPoint[]> {
	const live = join(directory, "live.sqlite");
	const copies = join(directory, "crashes");
	mkdirSync(copies);
	const prompts: Prompts = { child: 0, parent: 0 };
	const points: CrashPoint[] = [];
	for (const method of ["append", "appendMany", "createRun", "createRunWithEvents"] as const) {
		const original = SqlRunJournal.prototype[method] as (...args: unknown[]) => Promise<unknown>;
		vi.spyOn(SqlRunJournal.prototype, method).mockImplementation(async function (
			this: SqlRunJournal,
			...args: unknown[]
		) {
			const result = await original.apply(this, args);
			const path = join(copies, `${points.length + 1}.sqlite`);
			copyFileSync(live, path);
			if (existsSync(`${live}-wal`)) copyFileSync(`${live}-wal`, `${path}-wal`);
			points.push({ path, before: { ...prompts } });
			return result as never;
		});
	}
	const backend = await JournalTestBackend.create(live);
	try {
		const reference = await run(
			definition(childTokens),
			{},
			{
				runId: RUN_ID,
				store: createStore(),
				durableBackend: backend,
				budget: ROOT_BUDGET,
				adapters: { agentSession: spending(prompts) },
			},
		);
		assert.equal(reference.status, "completed");
	} finally {
		vi.restoreAllMocks();
		await backend.close();
	}
	return points;
}

const directories: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of directories.splice(0)) removeTempDirectory(directory);
});

async function sweep(childTokens: number): Promise<{ completed: number; midChild: number }> {
	const directory = makeTempDirectory("budget-crash-sweep-");
	directories.push(directory);
	const childCap = Math.ceil(childTokens / TOKENS);
	let completed = 0;
	let midChild = 0;
	for (const [index, point] of (await crashPoints(directory, childTokens)).entries()) {
		expireLeases(point.path);
		const backend = await JournalTestBackend.create(point.path);
		try {
			const status = backend.getWorkflow(RUN_ID)?.status;
			if (status === undefined || status === "completed") continue;
			const resumed: Prompts = { child: 0, parent: 0 };
			const store = createStore();
			const result = await run(
				definition(childTokens),
				{},
				{
					runId: RUN_ID,
					store,
					durableBackend: backend,
					budget: ROOT_BUDGET,
					adapters: { agentSession: spending(resumed) },
				},
			);
			const at = `crash after write ${index + 1}`;
			if (result.status !== "completed") {
				assert.match(String(result.error), /Session not found/, `${at}: ${result.status} ${result.error}`);
				continue;
			}
			completed += 1;
			const childPrompts = point.before.child + resumed.child;
			const parentPrompts = point.before.parent + resumed.parent;
			if (point.before.child > 0 && point.before.child < childCap) midChild += 1;
			assert.ok(childPrompts <= childCap, `${at}: the child ran ${childPrompts} paid stages, at most ${childCap}`);
			const root = store.runs().find((candidate) => candidate.id === RUN_ID);
			assert.equal(root?.budgetState?.accounting?.tokens, (childPrompts + parentPrompts) * TOKENS, `${at}: root`);
			const child = store.runs().find((candidate) => candidate.parentRunId === RUN_ID);
			const childCharged = child?.budgetState?.accounting?.tokens;
			// A child the resume replays whole from its cached result is not metered again.
			if (childCharged !== undefined) assert.equal(childCharged, childPrompts * TOKENS, `${at}: child`);
		} finally {
			await backend.close();
		}
	}
	return { completed, midChild };
}

describe("budget crash sweep (#5053)", () => {
	test("a resume after a crash at any write charges every prompt once while the child's budget stops it (#5053)", async () => {
		const { completed, midChild } = await sweep(22);
		assert.ok(completed >= 10, `${completed} resumes finished`);
		assert.ok(midChild >= 3, `${midChild} resumes continued a child stopped mid-run`);
	}, 600_000);

	test("a resume after a crash at any write charges every prompt once while the child runs to completion (#5053)", async () => {
		const { completed, midChild } = await sweep(1_000);
		assert.ok(completed >= 10, `${completed} resumes finished`);
		assert.ok(midChild >= 3, `${midChild} resumes continued a child stopped mid-run`);
	}, 600_000);
});
