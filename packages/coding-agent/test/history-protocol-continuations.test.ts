import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "vitest";
import type {
	WorkflowRunDetail,
	WorkflowRunStageSummary,
	WorkflowRunSummary,
} from "../src/core/extensions/workflow-run-control.js";
import type { SessionEntry } from "../src/core/session-manager-types.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import {
	SESSION_FORMAT_VERSION,
	type SessionListQuery,
	type SessionRecordHeader,
	type SessionStore,
	type SessionSummary,
} from "../src/core/storage/session/types.js";
import { createHistoryRouter, type WorkflowRunHistory } from "../src/core/tools/history-protocol.js";
import type { InternalReadSelection, InternalSearchRequest } from "../src/core/tools/resource-selectors.js";

const PROJECT = resolve("/projects/history-continuations");
const BASE = Date.parse("2026-11-01T00:00:00.000Z");
const STORE_WAIT_BUDGET_MS = 50;
const CALL_LIMIT = 200;
const OVERSIZE_DIAGNOSTIC = "[History response cannot fit its byte budget";

interface Gate {
	readonly opened: Promise<void>;
	readonly open: () => void;
}

class Gates {
	private readonly waiting: Gate[] = [];

	next(): Promise<void> {
		let open = () => {};
		const opened = new Promise<void>((resolve) => {
			open = resolve;
		});
		this.waiting.push({ opened, open });
		return opened;
	}

	openAll(): void {
		for (const gate of this.waiting.splice(0)) gate.open();
	}
}

function message(id: string, text: string, at: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(at).toISOString(),
		message: { role: "user", content: text, timestamp: at },
	};
}

async function storeWith(count: number, entries: (session: number) => SessionEntry[]): Promise<MemorySessionStore> {
	const store = new MemorySessionStore();
	for (let index = 0; index < count; index++) {
		await store.create(
			{
				id: `s${index + 1}`,
				version: SESSION_FORMAT_VERSION,
				createdAt: new Date(BASE + index * 60_000).toISOString(),
				cwd: PROJECT,
			},
			entries(index + 1),
		);
	}
	return store;
}

function listingWaitsAfterFirst(store: SessionStore, gates: Gates): SessionStore {
	return new Proxy(store, {
		get(target, key) {
			if (key === "list")
				return (query: SessionListQuery) => {
					const inner = target.list(query);
					return (async function* () {
						let yielded = 0;
						for await (const summary of inner as AsyncIterable<SessionSummary>) {
							if (yielded === 1) await gates.next();
							yielded++;
							yield summary;
						}
					})();
				};
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

function headerWaitsOnce(store: SessionStore, sessionId: string, gates: Gates): SessionStore {
	let waited = false;
	return new Proxy(store, {
		get(target, key) {
			if (key === "readHeader")
				return async (id: string): Promise<SessionRecordHeader | undefined> => {
					if (id === sessionId && !waited) {
						waited = true;
						await gates.next();
					}
					return target.readHeader(id);
				};
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

function continuation(text: string): string | undefined {
	return /continue with (history:\/\/\S+?)\]?$/m.exec(text)?.[1];
}

function request(pattern: string, ranges?: InternalSearchRequest["ranges"]): InternalSearchRequest {
	return {
		pattern,
		ignoreCase: false,
		literal: false,
		contextBefore: 0,
		contextAfter: 0,
		...(ranges === undefined ? {} : { ranges }),
	};
}

function summary(runId: string, startedAt: number): WorkflowRunSummary {
	return {
		runId,
		name: `flow ${startedAt - BASE}`,
		status: "completed",
		startedAt,
		elapsedMs: 1,
		activeStages: [],
		awaitingInput: [],
		awaitingInputCount: 0,
	};
}

function detail(
	runId: string,
	startedAt: number,
	text: string,
	stages: readonly WorkflowRunStageSummary[] = [],
): WorkflowRunDetail {
	return {
		runId,
		name: `flow ${startedAt - BASE}`,
		status: "completed",
		startedAt,
		endedAt: startedAt + 1000,
		summary: text,
		inputs: {},
		stages,
	};
}

function runHistory(runs: WorkflowRunSummary[], getRun: (runId: string) => Promise<WorkflowRunDetail>) {
	const history: WorkflowRunHistory = {
		listRuns: async () => runs,
		listProjectRuns: async () => runs,
		getRun,
	};
	return history;
}

interface SearchChain {
	readonly outputs: string[];
	readonly urls: string[];
	readonly matches: string[];
	readonly finished: boolean;
}

async function followSearch(
	search: (url: string, call: number) => Promise<string>,
	first: string,
	match: RegExp,
	afterCall: (call: number) => void = () => {},
): Promise<SearchChain> {
	const outputs: string[] = [];
	const urls: string[] = [];
	const matches: string[] = [];
	let url: string | undefined = first;
	for (let call = 0; url !== undefined && call < CALL_LIMIT; call++) {
		urls.push(url);
		const output = await search(url, call);
		outputs.push(output);
		for (const found of output.matchAll(match)) matches.push(found[1]!);
		url = continuation(output);
		afterCall(call);
	}
	return { outputs, urls, matches, finished: url === undefined };
}

function assertEachOnce(chain: SearchChain, expected: readonly string[]): void {
	const trail = `urls:\n${chain.urls.slice(0, 24).join("\n")}`;
	assert.ok(chain.finished, `the search never finished; ${trail}`);
	assert.deepEqual(
		chain.matches.filter((found, index) => chain.matches.indexOf(found) !== index),
		[],
		`matches returned twice; ${trail}`,
	);
	assert.deepEqual([...chain.matches].sort(), [...expected].sort(), trail);
}

describe("history:// continuations resume where a call stopped (#5250)", () => {
	it("a session listing that stops while listing sessions keeps the requested lines in its continuation (#5250)", async () => {
		const store = await storeWith(8, (n) => [message(`e${n}`, `hello ${n}`, BASE + n)]);
		const reads: readonly { readonly url: string; readonly selection: InternalReadSelection }[] = [
			{ url: "history://sessions", selection: { ranges: [{ start: 2, end: 3 }] } },
			{ url: "history://sessions", selection: { ranges: [{ start: 2, end: 3 }], raw: true } },
			{ url: "history://sessions", selection: { ranges: [{ start: 2, end: 2 }, { start: 8 }] } },
			{ url: "history://sessions", selection: { offset: 3, limit: 2 } },
			{ url: "history://sessions", selection: { offset: 6 } },
			{ url: "history://sessions?cursor=3.5:3-6", selection: {} },
		];
		const whole = createHistoryRouter({ cwd: PROJECT, sessionStore: () => store, workflows: () => undefined });
		const expected: string[] = [];
		for (const { url, selection } of reads) expected.push((await whole.readSelected!(url, selection)) ?? "");
		const budgeted = createHistoryRouter({
			cwd: PROJECT,
			sessionStore: () => store,
			workflows: () => undefined,
			budget: { rows: 3 },
		});
		for (const [index, { url, selection }] of reads.entries()) {
			let output = (await budgeted.readSelected!(url, selection)) ?? "";
			const first = output;
			for (let call = 0; call < CALL_LIMIT; call++) {
				const next = continuation(output);
				if (next === undefined) break;
				output = (await budgeted.readSelected!(next, {})) ?? "";
			}
			assert.match(first, /scanned \d+ sessions so far/, "the listing should stop while listing sessions");
			assert.equal(output, expected[index], `${url} ${JSON.stringify(selection)}; first page:\n${first}`);
		}
	});

	it("a read whose store wait ran out of time continues with the lines or entries it was asked for (#5250)", async () => {
		const store = await storeWith(1, () =>
			Array.from({ length: 6 }, (_, index) => message(`e${index}`, `entry ${index + 1}`, BASE + index)),
		);
		const runs = [summary("run-a", BASE)];
		const text = Array.from({ length: 12 }, (_, index) => `result line ${index + 1}`).join("\n");
		const reads: readonly { readonly url: string; readonly selection: InternalReadSelection }[] = [
			{ url: "history://workflows/run-a", selection: { ranges: [{ start: 7, end: 8 }] } },
			{ url: "history://workflows/run-a", selection: { offset: 9, limit: 2 } },
			{ url: "history://sessions/s1", selection: { ranges: [{ start: 3, end: 4 }] } },
			{ url: "history://sessions/s1", selection: { offset: 5 } },
		];
		const wholeRuns = runHistory(runs, async (runId) => detail(runId, BASE, text));
		const whole = createHistoryRouter({ cwd: PROJECT, sessionStore: () => store, workflows: () => wholeRuns });
		for (const { url, selection } of reads) {
			const expected = (await whole.readSelected!(url, selection)) ?? "";
			const gates = new Gates();
			const slowRuns: WorkflowRunHistory = {
				listRuns: async () => runs,
				listProjectRuns: async () => {
					await gates.next();
					return runs;
				},
				getRun: async (runId) => detail(runId, BASE, text),
			};
			const slowStore = headerWaitsOnce(store, "s1", gates);
			const router = createHistoryRouter({
				cwd: PROJECT,
				sessionStore: () => slowStore,
				workflows: () => slowRuns,
				budget: { timeMs: STORE_WAIT_BUDGET_MS },
			});
			const stopped = (await router.readSelected!(url, selection)) ?? "";
			gates.openAll();
			const next = continuation(stopped);
			assert.ok(next !== undefined, stopped);
			assert.equal(
				(await whole.readSelected!(next, {})) ?? "",
				expected,
				`${url} ${JSON.stringify(selection)}: ${next}`,
			);
		}
	});

	it("a run search whose store wait ran out of time continues with the lines it was asked to search (#5250)", async () => {
		const gates = new Gates();
		const runs = [summary("run-a", BASE)];
		const text = Array.from({ length: 12 }, (_, index) => `needle ${index + 1}`).join("\n");
		const workflows: WorkflowRunHistory = {
			listRuns: async () => runs,
			listProjectRuns: async () => {
				await gates.next();
				return runs;
			},
			getRun: async (runId) => detail(runId, BASE, text),
		};
		const router = createHistoryRouter({
			cwd: PROJECT,
			sessionStore: () => undefined,
			workflows: () => workflows,
			budget: { timeMs: STORE_WAIT_BUDGET_MS },
		});
		const stopped =
			(await router.search!("history://workflows/run-a", request("needle", [{ start: 7, end: 8 }]))) ?? "";
		gates.openAll();
		assert.equal(continuation(stopped), "history://workflows/run-a:7-8", stopped);
	});

	it("a multi-session search that stops inside a session resumes there when listing sessions takes more than one call (#5250)", async () => {
		const gates = new Gates();
		const store = await storeWith(4, (n) =>
			Array.from({ length: 6 }, (_, index) => message(`e${n}-${index}`, `needle s${n} e${index + 1}`, BASE + n)),
		);
		const listed = listingWaitsAfterFirst(store, gates);
		const router = createHistoryRouter({
			cwd: PROJECT,
			sessionStore: () => listed,
			workflows: () => undefined,
			budget: { timeMs: STORE_WAIT_BUDGET_MS, bytes: 400 },
		});
		const chain = await followSearch(
			async (url) => (await router.search!(url, request("needle"))) ?? "",
			"history://sessions",
			/: (needle s\d+ e\d+)/g,
			() => gates.openAll(),
		);
		assert.ok(
			chain.urls.some((url) => url.includes("session=")),
			`the search should stop inside a session at least once; urls:\n${chain.urls.join("\n")}`,
		);
		assertEachOnce(
			chain,
			Array.from({ length: 24 }, (_, index) => `needle s${Math.floor(index / 6) + 1} e${(index % 6) + 1}`),
		);
	});

	it("a workflow search resumes a run whose details took longer than the time budget instead of skipping it (#5250)", async () => {
		const gates = new Gates();
		let waited = false;
		const runs = [summary("run-a", BASE + 2000), summary("run-b", BASE + 1000)];
		const workflows = runHistory(runs, async (runId) => {
			if (runId === "run-a" && !waited) {
				waited = true;
				await gates.next();
			}
			return detail(runId, runId === "run-a" ? BASE + 2000 : BASE + 1000, `needle-token ${runId}`);
		});
		const router = createHistoryRouter({
			cwd: PROJECT,
			sessionStore: () => undefined,
			workflows: () => workflows,
			budget: { timeMs: STORE_WAIT_BUDGET_MS },
		});
		const chain = await followSearch(
			async (url) => (await router.search!(url, request("needle-token"))) ?? "",
			"history://workflows",
			/needle-token (run-\w)/g,
			() => gates.openAll(),
		);
		assert.ok(waited, "run-a's details should have been read once while the gate was closed");
		assertEachOnce(chain, ["run-a", "run-b"]);
	});

	it("a workflow search resumes a stage whose transcript took longer than the time budget instead of skipping it (#5250)", async () => {
		const gates = new Gates();
		const store = new MemorySessionStore();
		for (const stage of ["st1", "st2"])
			await store.create(
				{ id: stage, version: SESSION_FORMAT_VERSION, createdAt: new Date(BASE).toISOString(), cwd: PROJECT },
				[message(`${stage}-e`, `needle-token ${stage}`, BASE)],
			);
		const slowStage = headerWaitsOnce(store, "st1", gates);
		const stages: WorkflowRunStageSummary[] = [
			{ id: "one", name: "one", status: "completed", sessionId: "st1" },
			{ id: "two", name: "two", status: "completed", sessionId: "st2" },
		];
		const workflows = runHistory([summary("run-a", BASE)], async (runId) => detail(runId, BASE, "none", stages));
		const router = createHistoryRouter({
			cwd: PROJECT,
			sessionStore: () => slowStage,
			workflows: () => workflows,
			budget: { timeMs: STORE_WAIT_BUDGET_MS },
		});
		const chain = await followSearch(
			async (url) => (await router.search!(url, request("needle-token"))) ?? "",
			"history://workflows",
			/needle-token (st\d)/g,
			() => gates.openAll(),
		);
		assertEachOnce(chain, ["st1", "st2"]);
	});

	it("a history:// search continues a domain whose store wait ran out of time (#5250)", async () => {
		const gates = new Gates();
		let waited = false;
		const store = await storeWith(1, (n) => [message(`e${n}`, `needle session ${n}`, BASE)]);
		const runs = [summary("run-a", BASE)];
		const workflows: WorkflowRunHistory = {
			listRuns: async () => runs,
			listProjectRuns: async () => {
				if (!waited) {
					waited = true;
					await gates.next();
				}
				return runs;
			},
			getRun: async (runId) => detail(runId, BASE, `needle ${runId}`),
		};
		const router = createHistoryRouter({
			cwd: PROJECT,
			sessionStore: () => store,
			workflows: () => workflows,
			budget: { timeMs: STORE_WAIT_BUDGET_MS },
		});
		const output = (await router.search!("history://?limit=5", request("needle"))) ?? "";
		gates.openAll();
		assert.match(output, /needle session 1/);
		const next = /^history:\/\/workflows[^\n]*continue with (history:\/\/workflows\S*?)\]$/m.exec(output)?.[1];
		assert.equal(next, "history://workflows?limit=5", output);
		const resumed = (await router.search!(next, request("needle"))) ?? "";
		assert.match(resumed, /^history:\/\/workflows\/run-a:\d+: summary: needle run-a$/m, resumed);
	});

	it("a history:// search with no session history still continues workflow runs whose store wait ran out of time (#5250)", async () => {
		const gates = new Gates();
		const runs = [summary("run-a", BASE)];
		const workflows: WorkflowRunHistory = {
			listRuns: async () => runs,
			listProjectRuns: async () => {
				await gates.next();
				return runs;
			},
			getRun: async (runId) => detail(runId, BASE, `needle ${runId}`),
		};
		const router = createHistoryRouter({
			cwd: PROJECT,
			sessionStore: () => undefined,
			workflows: () => workflows,
			budget: { timeMs: STORE_WAIT_BUDGET_MS },
		});
		const output = (await router.search!("history://", request("needle"))) ?? "";
		gates.openAll();
		assert.match(output, /^history:\/\/sessions:0: \[sessions not searched: Session history is unavailable/m);
		assert.match(
			output,
			/^history:\/\/workflows:0: \[workflow runs not searched: [^\n]*continue with history:\/\/workflows\]$/m,
		);
	});

	it("a multi-run workflow search resumes in the run it stopped in after a newer run starts, within a small byte budget (#5250)", async () => {
		const longId = `run/2 ünïcödé&mode=${"x".repeat(60)}`;
		const texts: Record<string, string> = {
			"run-0": "nothing here",
			"run-1": "nothing here either",
			[longId]: Array.from({ length: 40 }, (_, index) => `needle line ${index + 1}`).join("\n"),
		};
		const bytes = 1200;
		const cases = [
			{ ranges: undefined, expected: 40 },
			{ ranges: [{ start: 6, end: 25 }], expected: 20 },
		];
		for (const { ranges, expected } of cases) {
			const runs = [summary("run-1", BASE + 2000), summary(longId, BASE + 1000)];
			const workflows = runHistory(runs, async (runId) => detail(runId, BASE, texts[runId]!));
			const router = createHistoryRouter({
				cwd: PROJECT,
				sessionStore: () => undefined,
				workflows: () => workflows,
				budget: { bytes },
			});
			const chain = await followSearch(
				async (url, call) =>
					(await router.search!(url, request("needle line", call === 0 ? ranges : undefined))) ?? "",
				"history://workflows",
				/(needle line \d+)$/gm,
				(call) => {
					if (call === 0) runs.unshift(summary("run-0", BASE + 3000));
				},
			);
			for (const output of chain.outputs) {
				assert.ok(Buffer.byteLength(output) <= bytes, `${Buffer.byteLength(output)} bytes:\n${output}`);
				assert.ok(!output.startsWith(OVERSIZE_DIAGNOSTIC), output);
			}
			assert.ok(chain.urls.length > 2, `the search should need several calls; urls:\n${chain.urls.join("\n")}`);
			assertEachOnce(
				chain,
				Array.from({ length: expected }, (_, index) => `needle line ${index + 1}`),
			);
		}
	});
});
