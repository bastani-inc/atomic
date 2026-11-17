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
import { SESSION_FORMAT_VERSION } from "../src/core/storage/session/types.js";
import { createHistoryRouter, type WorkflowRunHistory } from "../src/core/tools/history-protocol.js";
import type { InternalReadSelection, InternalSearchRequest } from "../src/core/tools/resource-selectors.js";

const PROJECT = resolve("/projects/history-resume");
const BASE = Date.parse("2026-11-01T00:00:00.000Z");
const CALL_LIMIT = 200;
const SLOW_TIME_MS = 40;

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
		}
		assert.deepEqual(failures, []);
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
});
