/**
 * Isolated process-restart fixture for issue #3085.
 *
 * The parent integration test drives a fabricated rate-limit + expired-OAuth
 * block through a real AgentSession and closes its journal before spawning
 * this file. The child reopens that journal, asserts blocked/resumable metadata,
 * after simulated provider recovery, and proves the completed prefix is not
 * executed again.
 *
 * Resume still constructs a recovered AgentSession (primary 429, fallback,
 * successful OAuth refresh). It must not import coding-agent `test/utilities.ts`
 * or `src/index.ts`: those pull createCodingTools and dominate cold jiti.
 * The session factory inlines a stub resource loader instead.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonlSessionStore } from "../../../packages/coding-agent/src/core/storage/session/jsonl-session-store.js";
import { workflow } from "../../../packages/workflows/src/authoring/workflow.js";
import { setDurableBackend } from "../../../packages/workflows/src/durable/factory.js";
import { JournalDurableBackend } from "../../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlRunJournal } from "../../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import { createExtensionRuntime } from "../../../packages/workflows/src/extension/runtime.js";
import { createJobTracker } from "../../../packages/workflows/src/runs/background/job-tracker.js";
import { effectiveRunStatus } from "../../../packages/workflows/src/shared/returned-run-status.js";
import { createStore } from "../../../packages/workflows/src/shared/store.js";
import { createRegistry } from "../../../packages/workflows/src/workflows/registry.js";
import { sleep } from "../../helpers/runtime.js";
import { createIssue3085StageSession } from "./issue-3085-provider-auth-block-session.js";

export const ISSUE_3085_WORKFLOW_NAME = "provider-auth-block-3085";
export const ISSUE_3085_PERSIST_FILE = "persist.json";
export const ISSUE_3085_PREFIX_FILE = "prefix.txt";
export const ISSUE_3085_RESULT_FILE = "resume-result.json";

export type Issue3085PersistedState = {
	readonly runId: string;
	readonly journalPath: string;
};

export type Issue3085ResumeResult = {
	readonly status: string;
	readonly prefix: number;
	readonly failureKind?: string;
	readonly failureCode?: string;
	readonly failureDisposition?: string;
	readonly failureRecoverability?: string;
	readonly resumable?: boolean;
};

export function prefixPath(dir: string): string {
	return join(dir, ISSUE_3085_PREFIX_FILE);
}

export function persistPath(dir: string): string {
	return join(dir, ISSUE_3085_PERSIST_FILE);
}

export function resultPath(dir: string): string {
	return join(dir, ISSUE_3085_RESULT_FILE);
}

export function readPrefix(dir: string): number {
	const path = prefixPath(dir);
	return existsSync(path) ? Number(readFileSync(path, "utf8")) : 0;
}

export function bumpPrefix(dir: string): number {
	const next = readPrefix(dir) + 1;
	writeFileSync(prefixPath(dir), String(next));
	return next;
}

export function createIssue3085Definition(dir: string) {
	return workflow({
		name: ISSUE_3085_WORKFLOW_NAME,
		description: "isolated provider recovery",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.tool("prefix", {}, async () => bumpPrefix(dir));
			await ctx.stage("provider", { model: "primary/m", fallbackModels: ["probe/m"] }).prompt("go");
			return {};
		},
	});
}

export async function resumeIssue3085FromPersistedState(dir: string): Promise<Issue3085ResumeResult> {
	const persisted = JSON.parse(readFileSync(persistPath(dir), "utf8")) as Issue3085PersistedState;
	const backend = await JournalDurableBackend.open(await openSqlRunJournal(persisted.journalPath));
	setDurableBackend(backend);
	try {
		await backend.hydrateWorkflow(persisted.runId);
		const hydrated = backend.getWorkflow(persisted.runId);
		assert.ok(hydrated, "blocked workflow must remain discoverable after an isolated process restart");
		assert.equal(hydrated.status, "blocked");
		assert.equal(hydrated.resumable, true);
		// Blocked durable records persist status and resumability. Failure kind
		// lives on the live store and is asserted in the parent before restart.
		assert.equal(readPrefix(dir), 1, "prefix must already be persisted before resume");

		const store = createStore();
		const jobs = createJobTracker();
		const definition = createIssue3085Definition(dir);
		const runtime = createExtensionRuntime({
			store,
			jobs,
			cwd: dir,
			registry: createRegistry([definition]),
			adapters: {
				sessionStore: await JsonlSessionStore.open(join(dir, "parent-sessions"), { exactDirectory: true }),
				agentSession: {
					create: async (options) => {
						assert.ok(options.sessionManager);
						return createIssue3085StageSession({
							dir,
							sessionManager: options.sessionManager,
							model: options.model,
							fallbackModels: options.fallbackModels,
							recovered: true,
						});
					},
				},
			},
		});
		const resumed = await runtime.resumeDurableWorkflow(persisted.runId);
		assert.equal(resumed.ok, true, resumed.ok ? undefined : resumed.message);
		assert.ok(resumed.ok && resumed.runId);
		const runId = resumed.runId;
		const deadline = Date.now() + 20_000;
		while (Date.now() < deadline) {
			const snapshot = store.runs().find((run) => run.id === runId);
			if (snapshot !== undefined && effectiveRunStatus(snapshot) === "completed") break;
			await sleep(25);
		}
		const continuation = store.runs().find((run) => run.id === runId);
		assert.ok(continuation, "resumed run must appear in the fresh process store");
		assert.equal(effectiveRunStatus(continuation), "completed", JSON.stringify(continuation));
		assert.equal(readPrefix(dir), 1, "completed prefix must not execute twice");
		const result: Issue3085ResumeResult = {
			status: effectiveRunStatus(continuation),
			prefix: readPrefix(dir),
			failureKind: hydrated.failureKind,
			failureCode: hydrated.failureCode,
			failureDisposition: hydrated.failureDisposition,
			failureRecoverability: hydrated.failureRecoverability,
			resumable: hydrated.resumable,
		};
		writeFileSync(resultPath(dir), `${JSON.stringify(result)}\n`);
		return result;
	} finally {
		await backend.close();
		setDurableBackend(undefined);
	}
}

const invokedDirectly = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (
	(invokedDirectly || process.argv[1]?.includes("issue-3085-provider-auth-block.ts") === true) &&
	process.argv[2] === "resume"
) {
	const dir = process.argv[3];
	assert.ok(dir, "resume child requires the persisted-state directory");
	void resumeIssue3085FromPersistedState(dir).catch((error: unknown) => {
		console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
		process.exitCode = 1;
	});
}
