import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it, vi } from "vitest";
import type {
	WorkflowRunDetail,
	WorkflowRunStageSummary,
	WorkflowRunSummary,
} from "../src/core/extensions/workflow-run-control.js";
import type { SessionEntry } from "../src/core/session-manager-types.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { SESSION_FORMAT_VERSION } from "../src/core/storage/session/types.js";
import { createHistoryRouter, type WorkflowRunHistory } from "../src/core/tools/history-protocol.js";

/** Session project checks that have finished: they resolve both directories off the event loop. */
const projectChecks = vi.hoisted(() => ({ settled: 0 }));

vi.mock("../src/utils/canonical-path.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/utils/canonical-path.ts")>();
	return {
		...actual,
		createSessionCwdMatcherAsync(cwd: string) {
			const matches = actual.createSessionCwdMatcherAsync(cwd);
			return async (candidate: string | undefined) => {
				try {
					return await matches(candidate);
				} finally {
					projectChecks.settled++;
				}
			};
		},
	};
});

import { MULTILINE_WINDOW_NOTE } from "../src/core/tools/history-session.js";
import type { InternalReadSelection, InternalSearchRequest } from "../src/core/tools/resource-selectors.js";

const PROJECT = resolve("/projects/history-resume");
const BASE = Date.parse("2026-11-01T00:00:00.000Z");
const CALL_LIMIT = 200;
const SLOW_TIME_MS = 40;
const SLOW_LISTING_MS = 400;
const LATER_RUN_TIME_MS = 100;
const LATE_DETAILS_MS = 175;
const CUT_ONLY_BYTES = 910;
const LONG_WAIT_MS = 1_500;
const SETTLE_TURNS = 20;
const PARKED_LISTING_TTL_MS = 60_000;

async function untilProjectChecked(checksBefore: number): Promise<void> {
	while (projectChecks.settled === checksBefore) await new Promise((resolve) => setImmediate(resolve));
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

async function addSession(store: MemorySessionStore, id: string, at: number, texts: readonly string[]): Promise<void> {
	await store.create(
		{ id, version: SESSION_FORMAT_VERSION, createdAt: new Date(at).toISOString(), cwd: PROJECT },
		texts.map((text, index) => message(`${id}-e${index + 1}`, text, at + index)),
	);
}

function request(pattern: string): InternalSearchRequest {
	return { pattern, ignoreCase: false, literal: false, contextBefore: 0, contextAfter: 0 };
}

function summary(runId: string, startedAt: number): WorkflowRunSummary {
	return {
		runId,
		name: `flow ${runId}`,
		status: "completed",
		startedAt,
		elapsedMs: 1,
		activeStages: [],
		awaitingInput: [],
		awaitingInputCount: 0,
	};
}

function detail(runId: string, startedAt: number, text: string, stages: readonly WorkflowRunStageSummary[] = []) {
	const run: WorkflowRunDetail = {
		runId,
		name: `flow ${runId}`,
		status: "completed",
		startedAt,
		endedAt: startedAt + 1000,
		summary: text,
		inputs: {},
		stages,
	};
	return run;
}

function pendingListings(
	runs: readonly WorkflowRunSummary[],
	listings: ((listed: readonly WorkflowRunSummary[]) => void)[],
): WorkflowRunHistory {
	return {
		listRuns: async () => runs,
		listProjectRuns: () =>
			new Promise((resolve) => {
				listings.push(resolve);
			}),
		getRun: async (runId) => detail(runId, BASE, "run summary"),
	};
}

function routerOver(workflows: WorkflowRunHistory, timeMs: number) {
	return createHistoryRouter({
		cwd: PROJECT,
		sessionStore: () => undefined,
		workflows: () => workflows,
		budget: { timeMs },
	});
}

async function until(ready: () => boolean): Promise<void> {
	while (!ready()) await new Promise((resolve) => setImmediate(resolve));
}

function continuation(text: string): string | undefined {
	return /continue with (history:\/\/\S+?)\]?$/m.exec(text)?.[1];
}

async function follow(search: (url: string) => Promise<string>, first: string, maxCalls = CALL_LIMIT) {
	const outputs: string[] = [];
	const urls: string[] = [];
	let url: string | undefined = first;
	for (let call = 0; url !== undefined && call < maxCalls; call++) {
		urls.push(url);
		const output = await search(url);
		outputs.push(output);
		url = continuation(output);
	}
	return { outputs, urls, finished: url === undefined };
}

function gated() {
	let open = () => {};
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { opened, open };
}

function found(outputs: readonly string[], pattern: RegExp): string[] {
	return outputs.flatMap((output) => [...output.matchAll(pattern)].map((match) => match[1]!));
}

function assertEachOnce(rows: readonly string[], expected: readonly string[], trail: string): void {
	assert.deepEqual(
		rows.filter((row, index) => rows.indexOf(row) !== index),
		[],
		`returned twice; ${trail}`,
	);
	assert.deepEqual([...rows].sort(), [...expected].sort(), trail);
}

function footersPastSessionEnd(outputs: readonly string[]): string[] {
	return outputs.flatMap((output) =>
		output.split("\n").filter((line) => {
			const at = / at entry (\d+) of (\d+) in /.exec(line);
			return at !== null && Number(at[1]) > Number(at[2]);
		}),
	);
}

function matchRows(outputs: readonly string[]): string[] {
	return outputs.flatMap((output) =>
		output.split("\n").filter((line) => /^history:\/\/sessions\/[^:]+:\d+: /.test(line)),
	);
}

describe("history:// continuations keep whole records and positions (#5250)", () => {
	it("a multi-session search resumed in a session after newer sessions appear does not search earlier sessions again (#5250)", async () => {
		for (const added of [1, 2, 3]) {
			const store = new MemorySessionStore();
			for (let n = 1; n <= 6; n++)
				await addSession(
					store,
					`s${n}`,
					BASE + n * 60_000,
					Array.from({ length: 8 }, (_, index) => `needle s${n} e${index + 1}`),
				);
			const router = createHistoryRouter({
				cwd: PROJECT,
				sessionStore: () => store,
				workflows: () => undefined,
				budget: { bytes: 900 },
			});
			let newer = 0;
			const chain = await follow(async (url) => {
				const output = (await router.search!(url, request("needle"))) ?? "";
				for (let i = 0; i < added; i++) {
					newer++;
					await addSession(store, `new${newer}`, BASE + (100 + newer) * 60_000, ["nothing to find"]);
				}
				return output;
			}, "history://sessions");
			const found = chain.outputs.flatMap((output) =>
				[...output.matchAll(/: (needle s\d+ e\d+)$/gm)].map((m) => m[1]!),
			);
			const trail = `${added} added per call; urls:\n${chain.urls.join("\n")}`;
			assert.ok(
				chain.urls.some((url) => url.includes("session=")),
				trail,
			);
			assert.ok(chain.finished, trail);
			assert.deepEqual(
				found.filter((row, index) => found.indexOf(row) !== index),
				[],
				`matches returned twice; ${trail}`,
			);
		}
	});

	it("a workflow search makes progress when listing runs and reading the run together take longer than the time budget (#5250)", async () => {
		const delay = () => new Promise((resolve) => setTimeout(resolve, SLOW_TIME_MS));
		const runs = [summary("run-a", BASE)];
		const workflows: WorkflowRunHistory = {
			listRuns: async () => runs,
			listProjectRuns: async () => {
				await delay();
				return runs;
			},
			getRun: async (runId) => {
				await delay();
				return detail(runId, BASE, "needle in the run summary");
			},
		};
		const router = createHistoryRouter({
			cwd: PROJECT,
			sessionStore: () => undefined,
			workflows: () => workflows,
			budget: { timeMs: SLOW_TIME_MS * 1.5 },
		});
		for (const first of ["history://workflows", "history://workflows?run=run-a", "history://workflows/run-a"]) {
			const chain = await follow(async (url) => (await router.search!(url, request("needle"))) ?? "", first, 20);
			const trail = `${first}: urls:\n${chain.urls.join("\n")}\n${chain.outputs.at(-1)}`;
			assert.ok(chain.finished, trail);
			assert.equal(chain.outputs.join("\n").match(/summary: needle in the run summary$/gm)?.length, 1, trail);
		}
		const read = await follow(async (url) => (await router.read!(url)) ?? "", "history://workflows/run-a", 20);
		assert.ok(read.finished, read.urls.join("\n"));
		assert.equal(
			read.outputs.join("\n").match(/^summary: needle in the run summary$/gm)?.length,
			1,
			read.urls.join("\n"),
		);
	});

	it("a workflow read or search finishes when listing runs takes longer than many time budgets, also through a new router per call (#5250)", async () => {
		const runs = [summary("run-a", BASE)];
		const workflows: WorkflowRunHistory = {
			listRuns: async () => runs,
			listProjectRuns: async () => {
				await new Promise((resolve) => setTimeout(resolve, SLOW_LISTING_MS));
				return runs;
			},
			getRun: async (runId) => detail(runId, BASE, "needle in the run summary"),
		};
		const newRouter = () =>
			createHistoryRouter({
				cwd: PROJECT,
				sessionStore: () => undefined,
				workflows: () => workflows,
				budget: { timeMs: SLOW_TIME_MS },
			});
		const router = newRouter();
		const maxCalls = Math.ceil(SLOW_LISTING_MS / SLOW_TIME_MS) * 4;
		for (const first of ["history://workflows", "history://workflows/run-a"]) {
			const search = await follow(
				async (url) => (await router.search!(url, request("needle"))) ?? "",
				first,
				maxCalls,
			);
			const read = await follow(async (url) => (await router.read!(url)) ?? "", first, maxCalls);
			const perCall = await follow(
				async (url) => (await newRouter().search!(url, request("needle"))) ?? "",
				first,
				maxCalls,
			);
			const summaryMatch = /: summary: needle in the run summary$/gm;
			for (const [kind, chain, row] of [
				["search", search, summaryMatch],
				["search with a new router per call", perCall, summaryMatch],
				[
					"read",
					read,
					first.endsWith("run-a")
						? /^summary: needle in the run summary$/gm
						: /^history:\/\/workflows\/run-a \|/gm,
				],
			] as const) {
				const trail = `${kind} ${first}: ${chain.urls.length} calls\n${chain.outputs.at(-1)}`;
				assert.ok(chain.urls.length > 1, `the first call should run out of time; ${trail}`);
				assert.ok(chain.finished, trail);
				assert.equal(chain.outputs.join("\n").match(row)?.length, 1, trail);
			}
		}
	});

	it("a slow run listing that a call parked is not replaced by a younger listing from an overlapping call (#5250)", async () => {
		const runs = [summary("run-a", BASE)];
		const listings: ((listed: readonly WorkflowRunSummary[]) => void)[] = [];
		const workflows: WorkflowRunHistory = {
			listRuns: async () => runs,
			listProjectRuns: () =>
				new Promise((resolve) => {
					listings.push(resolve);
				}),
			getRun: async (runId) => detail(runId, BASE, "run summary"),
		};
		const routerWith = (timeMs: number) =>
			createHistoryRouter({
				cwd: PROJECT,
				sessionStore: () => undefined,
				workflows: () => workflows,
				budget: { timeMs },
			});
		const older = routerWith(SLOW_TIME_MS).read!("history://workflows");
		const younger = routerWith(2 * SLOW_TIME_MS).read!("history://workflows");
		for (const output of await Promise.all([older, younger]))
			assert.match(output ?? "", /the time budget ran out waiting for the store/, output);
		assert.equal(listings.length, 2);
		listings[0]!(runs);
		const next = (await routerWith(SLOW_TIME_MS).read!("history://workflows")) ?? "";
		listings[1]!(runs);
		assert.equal(listings.length, 2);
		assert.match(next, /^history:\/\/workflows\/run-a \|/m, next);
	});

	it("an older run listing replaces a younger parked one when its own call runs out of time later (#5250)", async () => {
		const runs = [summary("run-a", BASE)];
		const listings: ((listed: readonly WorkflowRunSummary[]) => void)[] = [];
		const workflows = pendingListings(runs, listings);
		const older = routerOver(workflows, LONG_WAIT_MS).read!("history://workflows");
		await until(() => listings.length === 1);
		const younger = routerOver(workflows, SLOW_TIME_MS).read!("history://workflows");
		for (const output of await Promise.all([older, younger]))
			assert.match(output ?? "", /the time budget ran out waiting for the store/, output);
		assert.equal(listings.length, 2);
		listings[0]!(runs);
		const next = (await routerOver(workflows, SLOW_TIME_MS).read!("history://workflows")) ?? "";
		listings[1]!(runs);
		assert.equal(listings.length, 2);
		assert.match(next, /^history:\/\/workflows\/run-a \|/m, next);
	});

	it("a parked run listing keeps its start time when a call takes it over and parks it again (#5250)", async () => {
		const runs = [summary("run-a", BASE)];
		const listings: ((listed: readonly WorkflowRunSummary[]) => void)[] = [];
		const workflows = pendingListings(runs, listings);
		const first = routerOver(workflows, SLOW_TIME_MS).read!("history://workflows");
		await until(() => listings.length === 1);
		const overlapping = routerOver(workflows, LONG_WAIT_MS).read!("history://workflows");
		await until(() => listings.length === 2);
		assert.match((await first) ?? "", /the time budget ran out waiting for the store/);
		const adopted = (await routerOver(workflows, SLOW_TIME_MS).read!("history://workflows")) ?? "";
		assert.match(adopted, /the time budget ran out waiting for the store/, adopted);
		assert.match((await overlapping) ?? "", /the time budget ran out waiting for the store/);
		listings[0]!(runs);
		const next = (await routerOver(workflows, SLOW_TIME_MS).read!("history://workflows")) ?? "";
		listings[1]!(runs);
		assert.equal(listings.length, 2);
		assert.match(next, /^history:\/\/workflows\/run-a \|/m, next);
	});

	it("a run listing that failed is not handed to the next call (#5250)", async () => {
		const runs = [summary("run-a", BASE)];
		let calls = 0;
		const workflows: WorkflowRunHistory = {
			listRuns: async () => runs,
			listProjectRuns: async () => {
				calls++;
				if (calls === 1) throw new Error("run listing failed");
				return runs;
			},
			getRun: async (runId) => detail(runId, BASE, "run summary"),
		};
		await assert.rejects(routerOver(workflows, SLOW_TIME_MS).read!("history://workflows"), /run listing failed/);
		const next = (await routerOver(workflows, SLOW_TIME_MS).read!("history://workflows")) ?? "";
		assert.equal(calls, 2);
		assert.match(next, /^history:\/\/workflows\/run-a \|/m, next);
	});

	it("a parked run listing expires a fixed time after it was last parked (#5250)", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const runs = [summary("run-a", BASE)];
			const listings: ((listed: readonly WorkflowRunSummary[]) => void)[] = [];
			const workflows = pendingListings(runs, listings);
			const read = () => routerOver(workflows, SLOW_TIME_MS).read!("history://workflows");
			assert.match((await read()) ?? "", /the time budget ran out waiting for the store/);
			vi.advanceTimersByTime(PARKED_LISTING_TTL_MS / 2);
			assert.match((await read()) ?? "", /the time budget ran out waiting for the store/);
			assert.equal(vi.getTimerCount(), 1);
			vi.advanceTimersByTime(PARKED_LISTING_TTL_MS * 0.75);
			assert.match((await read()) ?? "", /the time budget ran out waiting for the store/);
			assert.equal(listings.length, 1);
			vi.advanceTimersByTime(PARKED_LISTING_TTL_MS);
			const fresh = read();
			await until(() => listings.length === 2);
			listings[1]!(runs);
			assert.match((await fresh) ?? "", /^history:\/\/workflows\/run-a \|/m);
		} finally {
			vi.useRealTimers();
		}
	});

	it("a younger parked run listing that an older one replaces leaves no expiry behind (#5250)", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const runs = [summary("run-a", BASE)];
			const listings: ((listed: readonly WorkflowRunSummary[]) => void)[] = [];
			const workflows = pendingListings(runs, listings);
			const older = routerOver(workflows, LONG_WAIT_MS).read!("history://workflows");
			await until(() => listings.length === 1);
			const younger = routerOver(workflows, SLOW_TIME_MS).read!("history://workflows");
			await Promise.all([older, younger]);
			assert.equal(vi.getTimerCount(), 1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("a parked run listing that has not finished long after it started is replaced by a fresh one (#5250)", async () => {
		const runs = [summary("run-a", BASE)];
		let calls = 0;
		const workflows: WorkflowRunHistory = {
			listRuns: async () => runs,
			listProjectRuns: () => (++calls === 1 ? new Promise<never>(() => {}) : Promise.resolve(runs)),
			getRun: async (runId) => detail(runId, BASE, "run summary"),
		};
		const read = () => routerOver(workflows, SLOW_TIME_MS).read!("history://workflows");
		assert.match((await read()) ?? "", /the time budget ran out waiting for the store/);
		const now = performance.now.bind(performance);
		const later = vi.spyOn(performance, "now").mockImplementation(() => now() + PARKED_LISTING_TTL_MS);
		try {
			const next = (await read()) ?? "";
			assert.equal(calls, 2);
			assert.match(next, /^history:\/\/workflows\/run-a \|/m, next);
		} finally {
			later.mockRestore();
		}
	});

	it("a run or stage session that started after a parked run listing began is found when a call takes that listing over (#5250)", async () => {
		const before = [summary("run-a", BASE)];
		const after = [summary("run-b", BASE + 1000), ...before];
		for (const url of ["history://workflows/run-b", "history://sessions/stage-b"]) {
			const store = new MemorySessionStore();
			await store.create(
				{
					id: "stage-b",
					version: SESSION_FORMAT_VERSION,
					createdAt: new Date(BASE + 1000).toISOString(),
					cwd: resolve("/projects/history-resume-worktree"),
					internal: true,
					workflow: { runId: "run-b", stageId: "s1", stageName: "build" },
				},
				[message("stage-b-e1", "stage work", BASE + 1001)],
			);
			const gate = gated();
			let calls = 0;
			const workflows: WorkflowRunHistory = {
				listRuns: async () => after,
				listProjectRuns: async () => {
					calls++;
					if (calls > 1) return after;
					await gate.opened;
					return before;
				},
				getRun: async (runId) => detail(runId, BASE, "run summary"),
			};
			const sources = { cwd: PROJECT, sessionStore: () => store, workflows: () => workflows };
			const first = (await createHistoryRouter({ ...sources, budget: { timeMs: SLOW_TIME_MS } }).read!(url)) ?? "";
			assert.match(first, /the time budget ran out waiting for the store/, first);
			gate.open();
			// Only the first call's time should run out. The continuation has the default time budget: for a stage session it
			// resolves both project paths before it takes the listing over, and a loaded machine can take more than 40 ms to
			// schedule that file-system work (#5621).
			const next = (await createHistoryRouter(sources).read!(continuation(first)!)) ?? "";
			assert.match(next, url.includes("workflows") ? /^# workflow run run-b$/m : /stage work/, next);
		}
	});

	it("a call that takes over a parked run listing lacking its run lists runs afresh rather than taking over another parked listing (#5250)", async () => {
		const before = [summary("run-a", BASE)];
		const after = [summary("run-b", BASE + 1000), ...before];
		for (const url of ["history://workflows/run-b", "history://sessions/stage-b"]) {
			const store = new MemorySessionStore();
			await store.create(
				{
					id: "stage-b",
					version: SESSION_FORMAT_VERSION,
					createdAt: new Date(BASE + 1000).toISOString(),
					cwd: resolve("/projects/history-resume-worktree"),
					internal: true,
					workflow: { runId: "run-b", stageId: "s1", stageName: "build" },
				},
				[message("stage-b-e1", "stage work", BASE + 1001)],
			);
			const listings: ((listed: readonly WorkflowRunSummary[]) => void)[] = [];
			let calls = 0;
			const workflows: WorkflowRunHistory = {
				listRuns: async () => after,
				listProjectRuns: () => {
					calls++;
					if (calls > 2) return Promise.resolve(after);
					return new Promise((resolve) => {
						listings.push(resolve);
					});
				},
				getRun: async (runId) => detail(runId, BASE, "run summary"),
			};
			const routerWith = (timeMs?: number) =>
				createHistoryRouter({
					cwd: PROJECT,
					sessionStore: () => store,
					workflows: () => workflows,
					...(timeMs === undefined ? {} : { budget: { timeMs } }),
				});
			const first = (await routerWith(SLOW_TIME_MS).read!(url)) ?? "";
			assert.match(first, /the time budget ran out waiting for the store/, first);
			const checksBefore = projectChecks.settled;
			// The call that takes the listing over has the default time budget: for a stage session it first resolves both
			// project paths, which a loaded machine can take over a second to schedule, and it must still be waiting after
			// the overlapping call below (#5621).
			const adopting = routerWith().read!(url);
			// A stage session's read checks its project before it asks for the run listing it takes over.
			if (url.includes("sessions")) await untilProjectChecked(checksBefore);
			for (let turn = 0; turn < SETTLE_TURNS; turn++) await new Promise((resolve) => setImmediate(resolve));
			const overlapping = (await routerWith(SLOW_TIME_MS).read!("history://workflows")) ?? "";
			assert.match(overlapping, /the time budget ran out waiting for the store/, overlapping);
			assert.equal(listings.length, 2);
			for (const resolveListing of listings) resolveListing(before);
			const next = (await adopting) ?? "";
			assert.equal(calls, 3, `${url}: ${next}`);
			assert.match(next, url.includes("workflows") ? /^# workflow run run-b$/m : /stage work/, next);
		}
	});

	it("a workflow search does not wait past its time budget for a later run's details and resumes in that run (#5250)", async () => {
		const runs = [summary("run-a", BASE + 2000), summary("run-b", BASE + 1000)];
		const workflows: WorkflowRunHistory = {
			listRuns: async () => runs,
			listProjectRuns: async () => runs,
			getRun: async (runId) => {
				if (runId === "run-b") await new Promise((resolve) => setTimeout(resolve, LATE_DETAILS_MS));
				return detail(runId, BASE, `needle ${runId}`);
			},
		};
		const router = createHistoryRouter({
			cwd: PROJECT,
			sessionStore: () => undefined,
			workflows: () => workflows,
			budget: { timeMs: LATER_RUN_TIME_MS },
		});
		const chain = await follow(
			async (url) => (await router.search!(url, request("needle"))) ?? "",
			"history://workflows",
		);
		const trail = `urls:\n${chain.urls.join("\n")}\n${chain.outputs.join("\n---\n")}`;
		assert.match(chain.outputs[0]!, /: summary: needle run-a$/m, trail);
		assert.doesNotMatch(chain.outputs[0]!, /needle run-b/, trail);
		assert.match(
			chain.outputs[0]!,
			/the time budget ran out[^\n]*continue with history:\/\/workflows\?\S*run=run-b/,
			trail,
		);
		assert.ok(chain.finished, trail);
		assertEachOnce(found(chain.outputs, /: summary: (needle run-\w)$/gm), ["needle run-a", "needle run-b"], trail);
	});

	it("a run read whose details arrive after the time budget ran out stops after its first line (#5250)", async () => {
		const runs = [summary("run-a", BASE)];
		const workflows: WorkflowRunHistory = {
			listRuns: async () => runs,
			listProjectRuns: async () => runs,
			getRun: async (runId) => {
				await new Promise((resolve) => setTimeout(resolve, 2 * SLOW_TIME_MS));
				return detail(runId, BASE, "run summary");
			},
		};
		const router = createHistoryRouter({
			cwd: PROJECT,
			sessionStore: () => undefined,
			workflows: () => workflows,
			budget: { timeMs: SLOW_TIME_MS },
		});
		const output = (await router.read!("history://workflows/run-a")) ?? "";
		assert.match(
			output,
			/^# workflow run run-a\n\[read lines 1-1; the time budget ran out; continue with history:\/\/workflows\/run-a\?cursor=2:2-\]$/,
		);
	});

	it("a session listing read with a line cursor lists sessions afresh instead of taking over another call's unfinished listing (#5250)", async () => {
		const store = new MemorySessionStore();
		for (let n = 1; n <= 8; n++) await addSession(store, `s${n}`, BASE + n * 60_000, [`hello ${n}`]);
		const budgeted = createHistoryRouter({
			cwd: PROJECT,
			sessionStore: () => store,
			workflows: () => undefined,
			budget: { rows: 3 },
		});
		const stopped = (await budgeted.read!("history://sessions")) ?? "";
		assert.match(stopped, /scanned \d+ sessions so far/);
		await store.delete("s1");
		const whole = createHistoryRouter({ cwd: PROJECT, sessionStore: () => store, workflows: () => undefined });
		const fromLine = (await whole.read!("history://sessions?cursor=1")) ?? "";
		const fresh = (await whole.read!("history://sessions")) ?? "";
		assert.doesNotMatch(fresh, /history:\/\/sessions\/s1 /);
		assert.equal(fromLine, fresh);
	});

	it("a read continued after its store wait ran out of time names the line that was asked for when it is past the end (#5250)", async () => {
		const store = new MemorySessionStore();
		for (let n = 1; n <= 8; n++) await addSession(store, `s${n}`, BASE + n * 60_000, [`hello ${n}`]);
		const runs = [summary("run-a", BASE)];
		const text = Array.from({ length: 12 }, (_, index) => `result line ${index + 1}`).join("\n");
		let open = () => {};
		let gate = Promise.resolve();
		const workflows: WorkflowRunHistory = {
			listRuns: async () => runs,
			listProjectRuns: async () => {
				await gate;
				return runs;
			},
			getRun: async (runId) => detail(runId, BASE, text),
		};
		const whole = createHistoryRouter({ cwd: PROJECT, sessionStore: () => store, workflows: () => workflows });
		const budgeted = createHistoryRouter({
			cwd: PROJECT,
			sessionStore: () => store,
			workflows: () => workflows,
			budget: { timeMs: SLOW_TIME_MS, rows: 3 },
		});
		const selections: InternalReadSelection[] = [
			{ ranges: [{ start: 40, end: 42 }] },
			{ ranges: [{ start: 40, end: 42 }], raw: true },
			{ ranges: [{ start: 2, end: 3 }] },
			{ offset: 3, limit: 2 },
		];
		const failures: string[] = [];
		for (const url of ["history://workflows/run-a", "history://sessions"])
			for (const selection of selections) {
				const expected = (await whole.readSelected!(url, selection)) ?? "";
				gate = new Promise<void>((resolve) => {
					open = resolve;
				});
				let output = (await budgeted.readSelected!(url, selection)) ?? "";
				open();
				const urls: string[] = [];
				for (let next = continuation(output); next !== undefined && urls.length < 20; next = continuation(output)) {
					urls.push(next);
					output = (await budgeted.readSelected!(next, {})) ?? "";
				}
				if (urls.length === 0 || output !== expected)
					failures.push(
						`${url} ${JSON.stringify(selection)} via ${urls.join(" -> ")}:\n${output}\nexpected:\n${expected}`,
					);
			}
		assert.deepEqual(failures, []);
	});

	it("a multi-session search stops before a later session's first match row that does not fit, instead of cutting it (#5250)", async () => {
		const store = new MemorySessionStore();
		for (let n = 1; n <= 3; n++)
			await addSession(store, `s${n}`, BASE + n * 60_000, [
				`needle in session ${n}: ${"words that make the match row long ".repeat(3)}end ${n}`,
				`needle again in session ${n}: ${"more words for the second match row ".repeat(2)}end ${n}`,
			]);
		const whole = createHistoryRouter({ cwd: PROJECT, sessionStore: () => store, workflows: () => undefined });
		const expected = matchRows([(await whole.search!("history://sessions", request("needle"))) ?? ""]).sort();
		assert.equal(expected.length, 6);
		const widest = Math.max(...expected.map((row) => Buffer.byteLength(row) + 1));
		const failures: string[] = [];
		for (let bytes = widest + 700; bytes <= widest + 1300; bytes += 3) {
			const router = createHistoryRouter({
				cwd: PROJECT,
				sessionStore: () => store,
				workflows: () => undefined,
				budget: { bytes },
			});
			const chain = await follow(
				async (url) => (await router.search!(url, request("needle"))) ?? "",
				"history://sessions",
			);
			const rows = matchRows(chain.outputs).sort();
			if (!chain.finished || JSON.stringify(rows) !== JSON.stringify(expected))
				failures.push(`${bytes} bytes: ${chain.urls.join(" -> ")}\n${rows.join("\n")}`);
			failures.push(...footersPastSessionEnd(chain.outputs).map((line) => `${bytes} bytes: ${line}`));
		}
		assert.deepEqual(failures, []);
	});

	it("a multi-session search that stops after a session's last match continues with the next session, never past its last entry, and says when it cut that row (#5250)", async () => {
		const store = new MemorySessionStore();
		for (let n = 1; n <= 3; n++)
			await addSession(store, `s${n}`, BASE + n * 60_000, [
				"nothing to find",
				`needle at the end of s${n} ${"z".repeat(300)}`,
			]);
		const failures: string[] = [];
		for (let bytes = 500; bytes <= 1_300; bytes += 2) {
			const router = createHistoryRouter({
				cwd: PROJECT,
				sessionStore: () => store,
				workflows: () => undefined,
				budget: { bytes },
			});
			const chain = await follow(
				async (url) => (await router.search!(url, request("needle"))) ?? "",
				"history://sessions",
			);
			const rows = found(chain.outputs, /: needle at the end of (s\d) z+$/gm);
			if (!chain.finished || JSON.stringify([...rows].sort()) !== JSON.stringify(["s1", "s2", "s3"]))
				failures.push(`${bytes} bytes: ${rows.join(",")}; urls:\n${chain.urls.join("\n")}`);
			failures.push(...footersPastSessionEnd(chain.outputs).map((line) => `${bytes} bytes: ${line}`));
		}
		const single = new MemorySessionStore();
		await addSession(single, "s1", BASE, ["nothing to find", `needle at the end of s1 ${"z".repeat(300)}`]);
		const fullRow = `history://sessions/s1:2: needle at the end of s1 ${"z".repeat(300)}`;
		let cutSeen = 0;
		for (let bytes = 150; bytes <= 450; bytes += 10) {
			const router = createHistoryRouter({
				cwd: PROJECT,
				sessionStore: () => single,
				workflows: () => undefined,
				budget: { bytes },
			});
			const output = (await router.search!("history://sessions", request("needle"))) ?? "";
			if (output.startsWith("[History response cannot fit")) continue;
			const lines = output.split("\n");
			const cut = lines.some((line) => line !== fullRow && line.startsWith("history://sessions/s1:2: needle"));
			if (cut) cutSeen++;
			if (
				Buffer.byteLength(output) > bytes ||
				(cut && !lines.some((line) => line.includes("the byte budget ran out")))
			)
				failures.push(`one session, ${bytes} bytes: ${output}`);
			failures.push(...footersPastSessionEnd([output]).map((line) => `one session, ${bytes} bytes: ${line}`));
		}
		const runs = [summary("run-a", BASE)];
		const quiet: WorkflowRunHistory = {
			listRuns: async () => runs,
			listProjectRuns: async () => runs,
			getRun: async (runId) => detail(runId, BASE, "nothing to find"),
		};
		for (let bytes = 500; bytes <= 900; bytes += 10) {
			const router = createHistoryRouter({
				cwd: PROJECT,
				sessionStore: () => single,
				workflows: () => quiet,
				budget: { bytes },
			});
			const output = (await router.search!("history://", request("needle"))) ?? "";
			if (Buffer.byteLength(output) > bytes || !output.split("\n").includes(fullRow))
				failures.push(`history://, ${bytes} bytes: ${output}`);
			failures.push(...footersPastSessionEnd([output]).map((line) => `history://, ${bytes} bytes: ${line}`));
		}
		assert.deepEqual(failures, []);
		assert.ok(cutSeen > 0, "some budget should cut the only match row");
	});

	it("a workflow search stops before a later stage's first match row that does not fit, instead of cutting it (#5250)", async () => {
		const store = new MemorySessionStore();
		const stages: WorkflowRunStageSummary[] = [];
		for (let n = 1; n <= 3; n++) {
			await addSession(store, `st${n}`, BASE + n * 60_000, [
				`needle in stage ${n}: ${"words that make the match row long ".repeat(3)}end ${n}`,
				`needle again in stage ${n}: ${"more words for the second match row ".repeat(2)}end ${n}`,
			]);
			stages.push({ id: `stage-${n}`, name: `stage ${n}`, status: "completed", sessionId: `st${n}` });
		}
		const workflows: WorkflowRunHistory = {
			listRuns: async () => [summary("run-a", BASE)],
			listProjectRuns: async () => [summary("run-a", BASE)],
			getRun: async (runId) => detail(runId, BASE, "nothing to find", stages),
		};
		const whole = createHistoryRouter({ cwd: PROJECT, sessionStore: () => store, workflows: () => workflows });
		const expected = matchRows([(await whole.search!("history://workflows", request("needle"))) ?? ""]).sort();
		assert.equal(expected.length, 6);
		const widest = Math.max(...expected.map((row) => Buffer.byteLength(row) + 1));
		const failures: string[] = [];
		for (const first of ["history://workflows", "history://workflows/run-a"])
			for (let bytes = widest + 700; bytes <= widest + 1300; bytes += 3) {
				const router = createHistoryRouter({
					cwd: PROJECT,
					sessionStore: () => store,
					workflows: () => workflows,
					budget: { bytes },
				});
				const chain = await follow(async (url) => (await router.search!(url, request("needle"))) ?? "", first);
				const rows = matchRows(chain.outputs).sort();
				if (!chain.finished || JSON.stringify(rows) !== JSON.stringify(expected))
					failures.push(`${bytes} bytes: ${chain.urls.join(" -> ")}\n${rows.join("\n")}`);
			}
		assert.deepEqual(failures, []);
	});

	it("a multi-session search keeps its place when the session it stopped in gets newer activity and newer sessions appear in the same chain (#5250)", async () => {
		for (const { bytes, slowListing } of [
			{ bytes: 500, slowListing: false },
			{ bytes: 900, slowListing: false },
			{ bytes: 500, slowListing: true },
		]) {
			const store = new MemorySessionStore();
			const lastSeq = new Map<string, number>();
			for (let n = 1; n <= 6; n++) {
				await addSession(
					store,
					`s${n}`,
					BASE + n * 60_000,
					Array.from({ length: 10 }, (_, index) => `needle s${n} e${index + 1}`),
				);
				lastSeq.set(`s${n}`, 10);
			}
			let gate = gated();
			const sessions = slowListing
				? new Proxy(store, {
						get(target, key) {
							if (key === "list")
								return (query: Parameters<MemorySessionStore["list"]>[0]) =>
									(async function* () {
										let listed = 0;
										for await (const summary of target.list(query)) {
											if (listed++ === 1) await gate.opened;
											yield summary;
										}
									})();
							const value = Reflect.get(target, key, target);
							return typeof value === "function" ? value.bind(target) : value;
						},
					})
				: store;
			const router = createHistoryRouter({
				cwd: PROJECT,
				sessionStore: () => sessions,
				workflows: () => undefined,
				budget: { bytes, ...(slowListing ? { timeMs: SLOW_TIME_MS } : {}) },
			});
			let clock = BASE + 1_000 * 60_000;
			let newer = 0;
			const chain = await follow(async (url) => {
				const output = (await router.search!(url, request("needle"))) ?? "";
				gate.open();
				gate = gated();
				const pinned = /continue with history:\/\/sessions\?\S*session=(s\d+)/.exec(output)?.[1];
				if (pinned !== undefined) {
					clock += 60_000;
					const seq = lastSeq.get(pinned)!;
					await store.append(pinned, [message(`${pinned}-late-${seq}`, "nothing to find", clock)], {
						expectSeq: seq,
					});
					lastSeq.set(pinned, seq + 1);
				}
				clock += 60_000;
				newer++;
				await addSession(store, `new${newer}`, clock, ["nothing to find"]);
				return output;
			}, "history://sessions");
			gate.open();
			const trail = `${bytes} bytes${slowListing ? ", slow listing" : ""}: urls:\n${chain.urls.join("\n")}`;
			assert.ok(
				chain.urls.some((url) => url.includes("session=")),
				trail,
			);
			assert.ok(chain.finished, trail);
			assertEachOnce(
				found(chain.outputs, /: (needle s\d+ e\d+)$/gm),
				Array.from({ length: 60 }, (_, index) => `needle s${Math.floor(index / 10) + 1} e${(index % 10) + 1}`),
				trail,
			);
		}
	});

	it("a session search continued after a finished session or page keeps its place when searched sessions get newer activity and newer sessions appear (#5250)", async () => {
		for (const { first, slowReads } of [
			{ first: "history://sessions?limit=2", slowReads: false },
			{ first: "history://sessions", slowReads: true },
		]) {
			const store = new MemorySessionStore();
			const lastSeq = new Map<string, number>();
			for (let n = 1; n <= 6; n++) {
				await addSession(store, `s${n}`, BASE + n * 60_000, [`needle s${n}`]);
				lastSeq.set(`s${n}`, 1);
			}
			const sessions = slowReads
				? new Proxy(store, {
						get(target, key) {
							if (key === "readEntryRange")
								return async (...args: Parameters<MemorySessionStore["readEntryRange"]>) => {
									await new Promise((resolve) => setTimeout(resolve, 2 * SLOW_TIME_MS));
									return target.readEntryRange(...args);
								};
							const value = Reflect.get(target, key, target);
							return typeof value === "function" ? value.bind(target) : value;
						},
					})
				: store;
			const router = createHistoryRouter({
				cwd: PROJECT,
				sessionStore: () => sessions,
				workflows: () => undefined,
				...(slowReads ? { budget: { timeMs: SLOW_TIME_MS } } : {}),
			});
			let clock = BASE + 1_000 * 60_000;
			let newer = 0;
			const chain = await follow(
				async (url) => {
					const output = (await router.search!(url, request("needle"))) ?? "";
					for (const searched of output.matchAll(/^history:\/\/sessions\/(s\d+):\d+: /gm)) {
						clock += 60_000;
						const id = searched[1]!;
						const seq = lastSeq.get(id)!;
						await store.append(id, [message(`${id}-late-${seq}`, "nothing to find", clock)], { expectSeq: seq });
						lastSeq.set(id, seq + 1);
					}
					clock += 60_000;
					newer++;
					await addSession(store, `new${newer}`, clock, ["nothing to find"]);
					return output;
				},
				first,
				30,
			);
			const trail = `${first}: urls:\n${chain.urls.join("\n")}`;
			assert.ok(chain.urls.length > 2, trail);
			assert.ok(chain.finished, trail);
			assertEachOnce(
				found(chain.outputs, /: (needle s\d+)$/gm),
				["needle s1", "needle s2", "needle s3", "needle s4", "needle s5", "needle s6"],
				trail,
			);
		}
	});

	it("a session search over sessions with the same activity time pages through each of them once as newer sessions appear (#5250)", async () => {
		const store = new MemorySessionStore();
		for (const id of ["s-c", "s-a", "s-e", "s-b", "s-d"])
			await store.create(
				{ id, version: SESSION_FORMAT_VERSION, createdAt: new Date(BASE).toISOString(), cwd: PROJECT },
				[message(`${id}-e1`, `needle ${id} one`, BASE), message(`${id}-e2`, `needle ${id} two`, BASE)],
			);
		const router = createHistoryRouter({
			cwd: PROJECT,
			sessionStore: () => store,
			workflows: () => undefined,
			budget: { bytes: 700 },
		});
		let newer = 0;
		const chain = await follow(async (url) => {
			const output = (await router.search!(url, request("needle"))) ?? "";
			newer++;
			await addSession(store, `new${newer}`, BASE + newer * 60_000, ["nothing to find"]);
			return output;
		}, "history://sessions?limit=1");
		const trail = `urls:\n${chain.urls.join("\n")}`;
		assert.ok(chain.finished, trail);
		assertEachOnce(
			found(chain.outputs, /: (needle s-\w \w+)$/gm),
			["s-a", "s-b", "s-c", "s-d", "s-e"].flatMap((id) => [`needle ${id} one`, `needle ${id} two`]),
			trail,
		);
	});

	it("a session search URL pinned without a position resumes after the pinned session when newer sessions appear or the pinned one moves up (#5250)", async () => {
		for (const change of ["newer sessions", "pinned activity"] as const) {
			const store = new MemorySessionStore();
			for (let n = 1; n <= 4; n++)
				await addSession(store, `s${n}`, BASE + n * 60_000, [`needle s${n} one`, `needle s${n} two`]);
			if (change === "newer sessions") {
				await addSession(store, "new1", BASE + 100 * 60_000, ["nothing to find"]);
				await addSession(store, "new2", BASE + 101 * 60_000, ["nothing to find"]);
			} else
				await store.append("s3", [message("s3-late", "nothing to find", BASE + 100 * 60_000)], { expectSeq: 2 });
			const router = createHistoryRouter({ cwd: PROJECT, sessionStore: () => store, workflows: () => undefined });
			const output =
				(await router.search!("history://sessions?offset=1&session=s3&cursor=2", request("needle"))) ?? "";
			assert.deepEqual(
				found([output], /: (needle s\d \w+)$/gm),
				["needle s3 two", "needle s2 one", "needle s2 two", "needle s1 one", "needle s1 two"],
				`${change}:\n${output}`,
			);
		}
	});

	it("a session search rejects a position it did not give (#5250)", async () => {
		const store = new MemorySessionStore();
		await addSession(store, "s1", BASE, ["needle"]);
		const router = createHistoryRouter({ cwd: PROJECT, sessionStore: () => store, workflows: () => undefined });
		for (const url of [
			"history://sessions?after=soon",
			"history://sessions?after=12.34",
			"history://sessions?after=1.x.s1",
		])
			await assert.rejects(
				router.search!(url, request("needle")),
				/history after must be the position a session search gave/,
			);
		assert.match(
			(await router.search!("history://sessions?session=s1&cursor=1&after=12.34", request("needle"))) ?? "",
			/^history:\/\/sessions\/s1:1: needle$/m,
		);
	});

	it("a multi-session search that pins sessions with long ids stays within a small byte budget (#5250)", async () => {
		const bytes = 1800;
		const failures: string[] = [];
		for (const limit of [1, 2, 25]) {
			const store = new MemorySessionStore();
			for (let n = 1; n <= 4; n++)
				await addSession(store, `session-${n}-${"ü".repeat(70)}`, BASE + n * 60_000, [
					`needle ${n} one`,
					`needle ${n} two`,
					`needle ${n} three`,
				]);
			const router = createHistoryRouter({
				cwd: PROJECT,
				sessionStore: () => store,
				workflows: () => undefined,
				budget: { bytes },
			});
			const chain = await follow(
				async (url) => (await router.search!(url, request("needle"))) ?? "",
				`history://sessions?limit=${limit}`,
			);
			for (const output of chain.outputs)
				if (Buffer.byteLength(output) > bytes || output.startsWith("[History response cannot fit"))
					failures.push(`limit ${limit}, ${Buffer.byteLength(output)} bytes:\n${output}`);
			const rows = found(chain.outputs, /: (needle \d \w+)$/gm);
			if (!chain.finished || rows.length !== 12 || new Set(rows).size !== 12)
				failures.push(`limit ${limit}: ${rows.length} rows; urls:\n${chain.urls.join("\n")}`);
			failures.push(...footersPastSessionEnd(chain.outputs).map((line) => `limit ${limit}: ${line}`));
		}
		assert.deepEqual(failures, []);
	});

	it("a session search continued from a long pinned session id stays within the byte budget that returned the continuation (#5250)", async () => {
		const store = new MemorySessionStore();
		for (const x of ["a", "b", "c", "d"]) {
			const id = `${x}.dot.${"ü😀.".repeat(6)}`;
			await store.create(
				{ id, version: SESSION_FORMAT_VERSION, createdAt: new Date(BASE).toISOString(), cwd: PROJECT },
				Array.from({ length: 3 }, (_, index) => message(`${id}-${index}`, `needle ${x} ${index + 1}`, BASE)),
			);
		}
		const failures: string[] = [];
		for (const bytes of [700, 701, 720, 750, 800, 1100]) {
			const router = createHistoryRouter({
				cwd: PROJECT,
				sessionStore: () => store,
				workflows: () => undefined,
				budget: { bytes },
			});
			const chain = await follow(
				async (url) => (await router.search!(url, { ...request("needle"), literal: true })) ?? "",
				"history://sessions",
				40,
			);
			const oversize = chain.outputs.filter(
				(output) => Buffer.byteLength(output) > bytes || output.startsWith("[History response cannot fit"),
			);
			const rows = found(chain.outputs, /: (needle \w \d)$/gm);
			const wholePage = rows.length === 12 && Buffer.byteLength(chain.outputs.join("\n")) <= bytes;
			if (
				!chain.finished ||
				oversize.length > 0 ||
				rows.length !== 12 ||
				new Set(rows).size !== 12 ||
				(bytes >= 1_100 && !wholePage)
			)
				failures.push(
					`${bytes} bytes: ${rows.length} rows, ${oversize.length} oversize; urls:\n${chain.urls.join("\n")}`,
				);
			failures.push(...footersPastSessionEnd(chain.outputs).map((line) => `${bytes} bytes: ${line}`));
		}
		assert.deepEqual(failures, []);
	});

	it("a multi-line session search that notes its match window stays within each byte budget (#5250)", async () => {
		const store = new MemorySessionStore();
		for (let n = 1; n <= 6; n++)
			await addSession(store, `s${n}`, BASE + n * 60_000, [
				`needle ${n}a`,
				"x".repeat(17_000),
				`needle ${n}b`,
				"x".repeat(17_000),
				`needle ${n}c`,
			]);
		const failures: string[] = [];
		for (let bytes = 600; bytes <= 1_000; bytes += 7) {
			const router = createHistoryRouter({
				cwd: PROJECT,
				sessionStore: () => store,
				workflows: () => undefined,
				budget: { bytes },
			});
			const chain = await follow(
				async (url) => (await router.search!(url, request("(?s)needle \\d."))) ?? "",
				"history://sessions",
				40,
			);
			const oversize = chain.outputs.filter(
				(output) => Buffer.byteLength(output) > bytes || output.startsWith("[History response cannot fit"),
			);
			const rows = found(chain.outputs, /: (needle \d\w)$/gm);
			if (!chain.finished || oversize.length > 0 || rows.length !== 18 || new Set(rows).size !== 18)
				failures.push(
					`${bytes} bytes: ${rows.length} rows, ${oversize.length} oversize; urls:\n${chain.urls.join("\n")}`,
				);
			failures.push(...footersPastSessionEnd(chain.outputs).map((line) => `${bytes} bytes: ${line}`));
			if (!chain.outputs[0]!.split("\n").includes(`history://sessions:0: [${MULTILINE_WINDOW_NOTE}]`))
				failures.push(`${bytes} bytes: the first page does not note its match window:\n${chain.outputs[0]}`);
		}
		assert.deepEqual(failures, []);
	});

	it("a session search that cannot fit a whole match row cuts only its text, never the session label (#5250)", async () => {
		const store = new MemorySessionStore();
		const id = `long.${"ü😀.".repeat(20)}`;
		await addSession(store, id, BASE, [`needle one ${"y".repeat(600)}`, "needle two"]);
		await addSession(store, "s-other", BASE - 60_000, ["needle other"]);
		const label = `history://sessions/${id}:`;
		const whole = createHistoryRouter({ cwd: PROJECT, sessionStore: () => store, workflows: () => undefined });
		const fullRow = ((await whole.search!("history://sessions", request("needle"))) ?? "")
			.split("\n")
			.find((line) => line.startsWith(`${label}1: `));
		assert.ok(fullRow !== undefined);
		const failures: string[] = [];
		const cutAt: number[] = [];
		let firstShown: number | undefined;
		for (let bytes = 300; bytes <= 1_400; bytes += 2) {
			const router = createHistoryRouter({
				cwd: PROJECT,
				sessionStore: () => store,
				workflows: () => undefined,
				budget: { bytes },
			});
			const output = (await router.search!("history://sessions", request("needle"))) ?? "";
			if (Buffer.byteLength(output) > bytes) failures.push(`${bytes} bytes: ${Buffer.byteLength(output)} returned`);
			if (output.startsWith("[History response cannot fit")) {
				if (firstShown !== undefined)
					failures.push(`${bytes} bytes: no rows, although ${firstShown} bytes showed the first match`);
				continue;
			}
			firstShown ??= bytes;
			const rows = output
				.split("\n")
				.filter((line) => line.startsWith("history://sessions/") && !line.includes(":0: ["));
			for (const row of rows)
				if (!row.startsWith("history://sessions/s-other:") && !/^:\d+: \S/.test(row.slice(label.length - 1)))
					failures.push(`${bytes} bytes: ${row}`);
			const first = rows.find((row) => row.startsWith(`${label}1: `));
			if (first === undefined) failures.push(`${bytes} bytes: the first match row is missing`);
			else if (first !== fullRow) {
				if (!fullRow.startsWith(first)) failures.push(`${bytes} bytes: ${first}`);
				cutAt.push(bytes);
			}
		}
		assert.deepEqual(failures, []);
		assert.ok(cutAt.length > 0, "some budget should show the long first row cut");
		assert.equal(cutAt[0], firstShown, "the smallest budget that shows a row should show the first row cut");
		const cutOnly = createHistoryRouter({
			cwd: PROJECT,
			sessionStore: () => store,
			workflows: () => undefined,
			budget: { bytes: CUT_ONLY_BYTES },
		});
		const output = (await cutOnly.search!("history://sessions", request("needle"))) ?? "";
		assert.ok(!output.startsWith("[History response cannot fit"), output);
		const cutRow = output.split("\n").find((line) => line.startsWith(`${label}1: needle`));
		assert.ok(cutRow !== undefined && cutRow !== fullRow && fullRow.startsWith(cutRow), output);
		assert.match(output, /^history:\/\/sessions:0: \[searched sessions 1-1 of 2; the byte budget ran out /m);
	});

	it("a history:// search fits its session rows beside the workflow lines and continues both (#5250)", async () => {
		const store = new MemorySessionStore();
		for (let n = 1; n <= 3; n++)
			await addSession(
				store,
				`s${n}`,
				BASE + n * 60_000,
				Array.from({ length: 6 }, (_, index) => `needle s${n} e${index + 1} ${"x".repeat(30)}`),
			);
		const runs = [summary("run-a", BASE)];
		const workflows: WorkflowRunHistory = {
			listRuns: async () => runs,
			listProjectRuns: async () => runs,
			getRun: async (runId) =>
				detail(runId, BASE, Array.from({ length: 6 }, (_, i) => `needle run ${i + 1}`).join("\n")),
		};
		const failures: string[] = [];
		for (const bytes of [700, 900, 1_200]) {
			const router = createHistoryRouter({
				cwd: PROJECT,
				sessionStore: () => store,
				workflows: () => workflows,
				budget: { bytes },
			});
			const output = (await router.search!("history://", request("needle"))) ?? "";
			if (Buffer.byteLength(output) > bytes || output.startsWith("[History response cannot fit")) {
				failures.push(`${bytes} bytes: ${Buffer.byteLength(output)}\n${output}`);
				continue;
			}
			const seen = [...output.matchAll(/: (needle s\d e\d)/g)].map((m) => m[1]!);
			const runSeen = [...output.matchAll(/: summary: (needle run \d)$|: (needle run \d)$/gm)].map(
				(m) => m[1] ?? m[2]!,
			);
			for (const domain of ["sessions", "workflows"]) {
				const next = new RegExp(
					`^history://${domain}[^\\n]*continue with (history://${domain}\\S*?)\\]$`,
					"m",
				).exec(output)?.[1];
				const chain = await follow(
					async (url) => (await router.search!(url, request("needle"))) ?? "",
					next ?? "",
					40,
				);
				if (next !== undefined) {
					for (const page of chain.outputs) {
						if (Buffer.byteLength(page) > bytes) failures.push(`${bytes} bytes: ${domain} page too large`);
						seen.push(...[...page.matchAll(/: (needle s\d e\d)/g)].map((m) => m[1]!));
						runSeen.push(
							...[...page.matchAll(/: summary: (needle run \d)$|: (needle run \d)$/gm)].map(
								(m) => m[1] ?? m[2]!,
							),
						);
					}
					if (!chain.finished) failures.push(`${bytes} bytes: ${domain} chain did not finish`);
				}
			}
			const expected = Array.from({ length: 18 }, (_, i) => `needle s${Math.floor(i / 6) + 1} e${(i % 6) + 1}`);
			if (JSON.stringify([...seen].sort()) !== JSON.stringify([...expected].sort()))
				failures.push(`${bytes} bytes: sessions ${seen.length}/${new Set(seen).size}`);
			if (
				JSON.stringify([...runSeen].sort()) !==
				JSON.stringify(Array.from({ length: 6 }, (_, i) => `needle run ${i + 1}`))
			)
				failures.push(`${bytes} bytes: runs ${runSeen.join(",")}`);
		}
		assert.deepEqual(failures, []);
	});

	it("a history:// search keeps whole session rows and its workflow rows when sessions finish first (#5250)", async () => {
		const failures: string[] = [];
		for (const texts of [
			[`needle last ${"z".repeat(400)}`],
			Array.from({ length: 3 }, (_, i) => `needle ${i} ${"z".repeat(290)}`),
		]) {
			const store = new MemorySessionStore();
			await addSession(store, "s1", BASE, texts);
			let sessionsDone = () => {};
			const sessionsFinished = new Promise<void>((resolve) => {
				sessionsDone = resolve;
			});
			const watched = new Proxy(store, {
				get(target, key) {
					if (key === "readEntryRange")
						return async (...args: Parameters<MemorySessionStore["readEntryRange"]>) => {
							const page = await target.readEntryRange(...args);
							if (page.entries.length > 0) setTimeout(sessionsDone, 50);
							return page;
						};
					const value = Reflect.get(target, key, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			const runs = [summary("run-a", BASE)];
			const workflows: WorkflowRunHistory = {
				listRuns: async () => runs,
				listProjectRuns: async () => runs,
				getRun: async (runId) => {
					await sessionsFinished;
					return detail(runId, BASE, "needle run summary");
				},
			};
			const rows = texts.map((text, index) => `history://sessions/s1:${index + 1}: ${text}`);
			const router = createHistoryRouter({
				cwd: PROJECT,
				sessionStore: () => watched,
				workflows: () => workflows,
				budget: { bytes: 700 },
			});
			const output = (await router.search!("history://", request("needle"))) ?? "";
			const next = /^history:\/\/sessions[^\n]*continue with (history:\/\/sessions\S*?)\]$/m.exec(output)?.[1];
			const chain =
				next === undefined
					? { outputs: [], finished: true }
					: await follow(async (url) => (await router.search!(url, request("needle"))) ?? "", next, 10);
			const shown = [output, ...chain.outputs].flatMap((page) => page.split("\n"));
			const trail = `${texts.length} rows:\n${[output, ...chain.outputs].join("\n---\n").replaceAll(/z{20,}/g, "z…")}`;
			if (
				[output, ...chain.outputs].some((page) => Buffer.byteLength(page) > 700) ||
				!output.split("\n").some((line) => line.endsWith(": summary: needle run summary")) ||
				rows.some((row) => shown.filter((line) => line === row).length !== 1) ||
				!chain.finished ||
				(texts.length === 1 && next !== undefined)
			)
				failures.push(trail);
		}
		assert.deepEqual(failures, []);
	});

	it("a history:// search with a one- or zero-entry budget does not read more entries than it allows (#5250)", async () => {
		const store = new MemorySessionStore();
		await addSession(store, "s1", BASE, ["needle in session"]);
		const failures: string[] = [];
		for (const rows of [0, 1]) {
			const calls: string[] = [];
			const counted = new Proxy(store, {
				get(target, key) {
					if (key === "list")
						return (...args: Parameters<MemorySessionStore["list"]>) => {
							calls.push("sessions.list");
							return target.list(...args);
						};
					if (key === "readEntryRange")
						return (...args: Parameters<MemorySessionStore["readEntryRange"]>) => {
							calls.push("sessions.readEntryRange");
							return target.readEntryRange(...args);
						};
					if (key === "readHeader")
						return (...args: Parameters<MemorySessionStore["readHeader"]>) => {
							calls.push("sessions.readHeader");
							return target.readHeader(...args);
						};
					const value = Reflect.get(target, key, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			const runs = [summary("run-a", BASE)];
			const workflows: WorkflowRunHistory = {
				listRuns: async () => {
					calls.push("workflows.listRuns");
					return runs;
				},
				listProjectRuns: async () => {
					calls.push("workflows.listProjectRuns");
					return runs;
				},
				getRun: async (runId) => {
					calls.push("workflows.getRun");
					return detail(runId, BASE, "needle in run");
				},
			};
			const router = createHistoryRouter({
				cwd: PROJECT,
				sessionStore: () => counted,
				workflows: () => workflows,
				budget: { rows },
			});
			const output = (await router.search!("history://", request("needle"))) ?? "";
			const sessionCalls = calls.filter((call) => call.startsWith("sessions.")).length;
			const workflowCalls = calls.filter((call) => call.startsWith("workflows.")).length;
			const workflowsSkipped =
				/^history:\/\/workflows:0: \[workflow runs not searched: the row budget ran out; continue with history:\/\/workflows\]$/m.test(
					output,
				);
			const sessionsSkipped =
				/^history:\/\/sessions:0: \[sessions not searched: the row budget ran out; continue with history:\/\/sessions\]$/m.test(
					output,
				);
			if (workflowCalls > 0 || !workflowsSkipped || (rows === 0 && (sessionCalls > 0 || !sessionsSkipped)))
				failures.push(`rows ${rows}: ${calls.join(", ")}\n${output}`);
			const sessionsNext = /^history:\/\/sessions[^\n]*continue with (history:\/\/sessions\S*?)\]$/m.exec(
				output,
			)?.[1];
			const sessionChain =
				sessionsNext === undefined
					? undefined
					: await follow(async (url) => (await router.search!(url, request("needle"))) ?? "", sessionsNext, 10);
			if (
				!/^history:\/\/sessions\/s1:1: needle in session$/m.test(
					[output, ...(sessionChain?.outputs ?? [])].join("\n"),
				) ||
				(rows === 1 && sessionCalls === 0)
			)
				failures.push(`rows ${rows}: the session match is not reached\n${output}`);
			const resumed = (await router.search!("history://workflows", request("needle"))) ?? "";
			if (!/: summary: needle in run$/m.test(resumed))
				failures.push(`rows ${rows}: workflows continuation\n${resumed}`);
		}
		assert.deepEqual(failures, []);
	});

	it("a workflow search pinned to a run that is no longer listed says so and searches the runs at its offset from their start (#5250)", async () => {
		const runs = [summary("run-b", BASE + 2000), summary("run-c", BASE + 1000)];
		const workflows: WorkflowRunHistory = {
			listRuns: async () => runs,
			listProjectRuns: async () => runs,
			getRun: async (runId) => detail(runId, BASE, `needle ${runId} one\nneedle ${runId} two`),
		};
		const router = createHistoryRouter({ cwd: PROJECT, sessionStore: () => undefined, workflows: () => workflows });
		const output = (await router.search!("history://workflows?run=run-gone&cursor=0.40", request("needle"))) ?? "";
		assert.match(
			output,
			/^history:\/\/workflows:0: \[run run-gone is no longer listed, so the search could not resume in it; it continued with the runs after it\]$/m,
		);
		assertEachOnce(
			found([output], /(needle run-\w \w+)$/gm),
			["needle run-b one", "needle run-b two", "needle run-c one", "needle run-c two"],
			output,
		);
	});

	it("a session search pinned to a session that is no longer listed says so and searches the sessions at its offset from their start (#5250)", async () => {
		const store = new MemorySessionStore();
		for (let n = 1; n <= 2; n++)
			await addSession(store, `s${n}`, BASE + n * 60_000, [`needle s${n} e1`, `needle s${n} e2`, `needle s${n} e3`]);
		const router = createHistoryRouter({ cwd: PROJECT, sessionStore: () => store, workflows: () => undefined });
		const output = (await router.search!("history://sessions?session=gone&cursor=3", request("needle"))) ?? "";
		assert.match(
			output,
			/^history:\/\/sessions:0: \[session gone is no longer listed, so the search could not resume in it; it continued with the sessions after it\]$/m,
		);
		assertEachOnce(
			found([output], /: (needle s\d e\d)$/gm),
			["needle s1 e1", "needle s1 e2", "needle s1 e3", "needle s2 e1", "needle s2 e2", "needle s2 e3"],
			output,
		);
	});

	it("a workflow search continued on its next page after a newer run starts does not search earlier runs again (#5250)", async () => {
		const runs = [summary("run-a", BASE + 2000), summary("run-b", BASE + 1000)];
		const workflows: WorkflowRunHistory = {
			listRuns: async () => runs,
			listProjectRuns: async () => runs,
			getRun: async (runId) => detail(runId, BASE, `needle ${runId}`),
		};
		const router = createHistoryRouter({ cwd: PROJECT, sessionStore: () => undefined, workflows: () => workflows });
		let newer = 0;
		const chain = await follow(async (url) => {
			const output = (await router.search!(url, request("needle"))) ?? "";
			newer++;
			runs.unshift(summary(`new-${newer}`, BASE + 10_000 * newer));
			return output;
		}, "history://workflows?limit=1");
		const trail = `urls:\n${chain.urls.join("\n")}`;
		assert.ok(chain.finished, trail);
		assertEachOnce(found(chain.outputs, /summary: (needle run-\w)$/gm), ["needle run-a", "needle run-b"], trail);
	});

	it("a resumed workflow search whose run takes longer than the time budget to read continues where it was (#5250)", async () => {
		const runs = [summary("run-a", BASE)];
		const lines = Array.from({ length: 30 }, (_, index) => `needle line ${index + 1}`).join("\n");
		let gate: ReturnType<typeof gated> | undefined;
		const workflows: WorkflowRunHistory = {
			listRuns: async () => runs,
			listProjectRuns: async () => runs,
			getRun: async (runId) => {
				await gate?.opened;
				return detail(runId, BASE, lines);
			},
		};
		const router = createHistoryRouter({
			cwd: PROJECT,
			sessionStore: () => undefined,
			workflows: () => workflows,
			budget: { bytes: 1200, timeMs: SLOW_TIME_MS },
		});
		let call = 0;
		const chain = await follow(async (url) => {
			call++;
			gate = call === 2 ? gated() : undefined;
			const pending = router.search!(url, request("needle line"));
			const output = (await pending) ?? "";
			gate?.open();
			return output;
		}, "history://workflows");
		const trail = `urls:\n${chain.urls.join("\n")}`;
		assert.match(chain.outputs[1]!, /the time budget ran out/, trail);
		assert.ok(chain.finished, trail);
		assertEachOnce(
			found(chain.outputs, /(needle line \d+)$/gm),
			Array.from({ length: 30 }, (_, index) => `needle line ${index + 1}`),
			trail,
		);
	});

	it("a workflow search resumed inside a stage whose transcript takes longer than the time budget to open continues where it was (#5250)", async () => {
		const store = new MemorySessionStore();
		await addSession(
			store,
			"st1",
			BASE,
			Array.from({ length: 8 }, (_, index) => `needle stage entry ${index + 1} ${"x".repeat(80)}`),
		);
		let gate: ReturnType<typeof gated> | undefined;
		const slow = new Proxy(store, {
			get(target, key) {
				if (key === "readHeader")
					return async (id: string) => {
						await gate?.opened;
						return target.readHeader(id);
					};
				const value = Reflect.get(target, key, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const stages: WorkflowRunStageSummary[] = [{ id: "one", name: "one", status: "completed", sessionId: "st1" }];
		const workflows: WorkflowRunHistory = {
			listRuns: async () => [summary("run-a", BASE)],
			listProjectRuns: async () => [summary("run-a", BASE)],
			getRun: async (runId) => detail(runId, BASE, "nothing to find", stages),
		};
		const router = createHistoryRouter({
			cwd: PROJECT,
			sessionStore: () => slow,
			workflows: () => workflows,
			budget: { bytes: 1200, timeMs: SLOW_TIME_MS },
		});
		let call = 0;
		const chain = await follow(async (url) => {
			call++;
			gate = call === 2 ? gated() : undefined;
			const output = (await router.search!(url, request("needle stage"))) ?? "";
			gate?.open();
			return output;
		}, "history://workflows");
		const trail = `urls:\n${chain.urls.join("\n")}`;
		assert.match(chain.urls[1]!, /cursor=1\.\d+/, trail);
		assert.match(chain.outputs[1]!, /the time budget ran out/, trail);
		assert.ok(chain.finished, trail);
		assertEachOnce(
			found(chain.outputs, /: (needle stage entry \d+) x+$/gm),
			Array.from({ length: 8 }, (_, index) => `needle stage entry ${index + 1}`),
			trail,
		);
	});

	it("a read whose store wait ran out of time continues with the same cursor or raw selection (#5250)", async () => {
		const store = new MemorySessionStore();
		await addSession(
			store,
			"s1",
			BASE,
			Array.from({ length: 6 }, (_, index) => `entry ${index + 1}`),
		);
		const runs = [summary("run-a", BASE)];
		const text = Array.from({ length: 12 }, (_, index) => `result line ${index + 1} ${"x".repeat(index)}`).join("\n");
		let gate: ReturnType<typeof gated> | undefined;
		const slowStore = new Proxy(store, {
			get(target, key) {
				if (key === "readHeader")
					return async (id: string) => {
						await gate?.opened;
						return target.readHeader(id);
					};
				const value = Reflect.get(target, key, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const workflows: WorkflowRunHistory = {
			listRuns: async () => runs,
			listProjectRuns: async () => {
				await gate?.opened;
				return runs;
			},
			getRun: async (runId) => detail(runId, BASE, text),
		};
		const whole = createHistoryRouter({ cwd: PROJECT, sessionStore: () => store, workflows: () => workflows });
		const budgeted = createHistoryRouter({
			cwd: PROJECT,
			sessionStore: () => slowStore,
			workflows: () => workflows,
			budget: { timeMs: SLOW_TIME_MS },
		});
		const reads: readonly { readonly url: string; readonly selection: InternalReadSelection }[] = [
			{ url: "history://workflows/run-a?cursor=9", selection: {} },
			{ url: "history://workflows/run-a?cursor=9.4:9-11", selection: {} },
			{ url: "history://sessions/s1", selection: { ranges: [{ start: 3, end: 4 }], raw: true } },
			{ url: "history://sessions/s1:2-5:raw", selection: {} },
		];
		const failures: string[] = [];
		for (const { url, selection } of reads) {
			const expected = (await whole.readSelected!(url, selection)) ?? "";
			gate = gated();
			const stopped = (await budgeted.readSelected!(url, selection)) ?? "";
			gate.open();
			gate = undefined;
			const next = continuation(stopped);
			const output = next === undefined ? stopped : ((await whole.readSelected!(next, {})) ?? "");
			if (next === undefined || output !== expected)
				failures.push(`${url} ${JSON.stringify(selection)} -> ${next}:\n${output}\nexpected:\n${expected}`);
		}
		assert.deepEqual(failures, []);
	});

	it("reading or searching a workflow stage session in its own worktree continues when listing runs exceeds the time budget (#5250)", async () => {
		const runs = [summary("run-a", BASE)];
		for (const mode of ["read", "search"] as const) {
			const store = new MemorySessionStore();
			await store.create(
				{
					id: "stage-s",
					version: SESSION_FORMAT_VERSION,
					createdAt: new Date(BASE).toISOString(),
					cwd: resolve("/projects/history-resume-worktree"),
					internal: true,
					workflow: { runId: "run-a", stageId: "s1", stageName: "build" },
				},
				[message("stage-s-e1", "needle in stage worktree", BASE + 1)],
			);
			const gate = gated();
			const workflows: WorkflowRunHistory = {
				listRuns: async () => runs,
				listProjectRuns: async () => {
					await gate.opened;
					return runs;
				},
				getRun: async (runId) => detail(runId, BASE, "run summary"),
			};
			const call = (url: string, budget?: { readonly timeMs: number }) => {
				const router = createHistoryRouter({
					cwd: PROJECT,
					sessionStore: () => store,
					workflows: () => workflows,
					...(budget === undefined ? {} : { budget }),
				});
				return mode === "read" ? router.read!(url) : router.search!(url, request("needle in stage worktree"));
			};
			const first = (await call("history://sessions/stage-s", { timeMs: SLOW_TIME_MS })) ?? "";
			assert.match(
				first,
				/the time budget ran out waiting for the store; continue with history:\/\/sessions\/stage-s/,
				first,
			);
			gate.open();
			const next = continuation(first);
			assert.equal(next, "history://sessions/stage-s");
			// Only the first call's time should run out. The continuation has the default time budget: it resolves both project
			// paths before it takes the listing over, and a loaded machine can take more than 40 ms to schedule that (#5621).
			const second = (await call(next!)) ?? "";
			assert.match(second, /needle in stage worktree/, second);
		}
	});
});
