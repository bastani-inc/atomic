import assert from "node:assert/strict";
import { resolve } from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { describe, it } from "vitest";
import type {
	WorkflowRunDetail,
	WorkflowRunJsonObject,
	WorkflowRunSummary,
} from "../src/core/extensions/workflow-run-control.js";
import {
	createHistoryRouter,
	type HistoryBudget,
	type WorkflowRunHistory,
} from "../src/core/tools/history-protocol.js";
import { textLines, timestamp, wrapLine } from "../src/core/tools/history-transcript.js";
import type { InternalSearchRequest } from "../src/core/tools/resource-selectors.js";

const PROJECT = resolve("/projects/workflow-bounded");
const BASE = Date.parse("2026-11-01T00:00:00.000Z");
const RUN_COUNT = 25;
const RENDER_BLOCK_LIMIT_MS = 10;
const STALLS_ALLOWED = 3;
const STALL_CEILING_MS = 100;
const LARGE_RUN_TIMEOUT_MS = 120_000;
const HUGE_TEXT_CHARS = 32 * 1024 * 1024;

function cpuMs(): number {
	const used = typeof process.threadCpuUsage === "function" ? process.threadCpuUsage() : process.cpuUsage();
	return (used.user + used.system) / 1000;
}

interface Interval {
	readonly start: number;
	readonly end: number;
}

function overlapMs(turn: Interval, pauses: readonly Interval[]): number {
	return pauses.reduce(
		(sum, pause) => sum + Math.max(0, Math.min(turn.end, pause.end) - Math.max(turn.start, pause.start)),
		0,
	);
}

function watchEventLoopTurns(): () => Promise<number[]> {
	const turns: (Interval & { readonly cpu: number })[] = [];
	const collections: Interval[] = [];
	const collected = (entries: readonly PerformanceEntry[]) => {
		for (const entry of entries) collections.push({ start: entry.startTime, end: entry.startTime + entry.duration });
	};
	const observer = new PerformanceObserver((list) => collected(list.getEntries()));
	observer.observe({ entryTypes: ["gc"] });
	let watching = true;
	let last = performance.now();
	let lastCpu = cpuMs();
	const turn = () => {
		const now = performance.now();
		const cpu = cpuMs();
		turns.push({ start: last, end: now, cpu: cpu - lastCpu });
		last = now;
		lastCpu = cpu;
		if (watching) setImmediate(turn);
	};
	setImmediate(turn);
	return async () => {
		watching = false;
		turn();
		await new Promise((resolve) => setTimeout(resolve, 20));
		collected(observer.takeRecords());
		observer.disconnect();
		return turns.map((item) => Math.max(0, Math.min(item.end - item.start, item.cpu) - overlapMs(item, collections)));
	};
}

function assertFewStalls(turns: readonly number[], limitMs: number, what: string): void {
	const stalls = turns.filter((ms) => ms > limitMs).sort((a, b) => b - a);
	assert.ok(
		stalls.length <= STALLS_ALLOWED && (stalls[0] ?? 0) < STALL_CEILING_MS,
		`${what} held the event loop for more than ${limitMs} ms ${stalls.length} times in ${turns.length} turns: ${stalls.slice(0, 8).map(Math.round).join(", ")} ms`,
	);
}

function continuation(text: string): string | undefined {
	return /continue with (history:\/\/\S+?)\]?$/m.exec(text)?.[1];
}

function runSummary(runId: string, startedAt: number): WorkflowRunSummary {
	return {
		runId,
		name: `flow-${runId}`,
		status: "completed",
		startedAt,
		elapsedMs: 1,
		activeStages: [],
		awaitingInput: [],
		awaitingInputCount: 0,
	};
}

function runDetail(runId: string, startedAt: number, result?: WorkflowRunJsonObject): WorkflowRunDetail {
	return {
		runId,
		name: `flow-${runId}`,
		status: "completed",
		startedAt,
		endedAt: startedAt + 1_000,
		summary: `needle-token ${runId}`,
		inputs: { objective: `objective of ${runId}` },
		stages: [{ id: "s1", name: "build", status: "completed" }],
		...(result === undefined ? {} : { result }),
	};
}

function referenceLines(detail: WorkflowRunDetail): string[] {
	return [
		`# workflow run ${detail.runId}`,
		`name: ${detail.name}`,
		`status: ${detail.status}`,
		`started: ${timestamp(detail.startedAt)}`,
		...(detail.endedAt === undefined ? [] : [`ended: ${timestamp(detail.endedAt)}`]),
		...(detail.identity ? textLines(`label: ${detail.identity}`) : []),
		...(detail.summary ? textLines(`summary: ${detail.summary}`) : []),
		...wrapLine(`inputs: ${JSON.stringify(detail.inputs)}`),
		"stages:",
		...detail.stages.flatMap((stage) => [
			[
				`- ${stage.name} [${stage.status}]`,
				...(stage.sessionId ? [`transcript history://sessions/${stage.sessionId}`] : []),
			].join(" "),
			...(stage.error ? textLines(`  error: ${stage.error}`) : []),
		]),
		...(detail.result === undefined ? [] : wrapLine(`result: ${JSON.stringify(detail.result)}`)),
		...(detail.error ? textLines(`error: ${detail.error}`) : []),
	];
}

function historyOf(details: readonly WorkflowRunDetail[], budget?: Partial<HistoryBudget>) {
	let getRunCalls = 0;
	const workflows: WorkflowRunHistory = {
		listRuns: async () => details.map((detail) => runSummary(detail.runId, detail.startedAt)),
		getRun: async (runId) => {
			getRunCalls++;
			const found = details.find((detail) => detail.runId === runId);
			if (!found) throw new Error(`no run ${runId}`);
			return found;
		},
	};
	const router = createHistoryRouter({
		cwd: PROJECT,
		sessionStore: () => undefined,
		workflows: () => workflows,
		...(budget === undefined ? {} : { budget }),
	});
	const request = (pattern: string): InternalSearchRequest => ({
		pattern,
		ignoreCase: false,
		literal: false,
		contextBefore: 0,
		contextAfter: 0,
	});
	const read = async (url: string): Promise<string> => String((await router.read?.(url)) ?? "");
	return { router, read, request, getRunCalls: () => getRunCalls };
}

function hugeText(chars: number): string {
	const unit = "row of text 🙂 é ";
	return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
}

function largeObject(items: number): WorkflowRunJsonObject {
	return {
		items: Array.from({ length: items }, (_, index) => ({
			id: index,
			name: `item ${index} "quoted" \\ back`,
			tags: ["a", "b", index % 3 === 0 ? null : "c"],
			nested: { ok: index % 2 === 0, ratio: index / 7, emoji: index % 5 === 0 ? "🙂" : "x" },
		})),
		count: items,
	};
}

describe("history:// workflow runs stay bounded (#5250)", () => {
	it("charges workflow runs listed, searched and read to the row budget and continues from the next run (#5250)", async () => {
		const details = Array.from({ length: RUN_COUNT }, (_, index) =>
			runDetail(`run-${String(index).padStart(2, "0")}`, BASE + index * 1_000),
		);
		const { router, read, request, getRunCalls } = historyOf(details, { rows: 1 });
		const expected = details.map((detail) => detail.runId).sort();

		const listed: string[] = [];
		let listCalls = 0;
		for (let url: string | undefined = "history://workflows"; url !== undefined && listCalls < 3 * RUN_COUNT; ) {
			const output = await read(url);
			listCalls++;
			const runs = [...output.matchAll(/^history:\/\/workflows\/(run-\d+) \| /gm)].map((match) => match[1]!);
			assert.equal(runs.length, 1, `one call listed ${runs.length} runs under a one-row budget`);
			listed.push(...runs);
			url = /next page: (history:\/\/\S+)$/m.exec(output)?.[1];
		}
		assert.deepEqual([...listed].sort(), expected);
		assert.equal(listCalls, RUN_COUNT);

		const searched: string[] = [];
		let searchCalls = 0;
		for (let url: string | undefined = "history://workflows"; url !== undefined && searchCalls < 3 * RUN_COUNT; ) {
			const before = getRunCalls();
			const output = (await router.search?.(url, request("needle-token"))) ?? "";
			searchCalls++;
			assert.ok(getRunCalls() - before <= 1, `one call read ${getRunCalls() - before} runs under a one-row budget`);
			searched.push(
				...[...output.matchAll(/^history:\/\/workflows\/(run-\d+):\d+: summary: needle-token/gm)].map(
					(match) => match[1]!,
				),
			);
			url = continuation(output);
		}
		assert.deepEqual([...searched].sort(), expected);
		assert.equal(searchCalls, RUN_COUNT);

		const before = getRunCalls();
		const runText = await read("history://workflows/run-03");
		assert.equal(getRunCalls() - before, 1);
		assert.deepEqual(runText.split("\n"), referenceLines(details[3]!));
	});

	it(
		"renders a large workflow run in bounded steps (#5250)",
		async () => {
			const stringRun = runDetail("run-text", BASE, { text: hugeText(HUGE_TEXT_CHARS) });
			const objectRun = runDetail("run-object", BASE + 1_000, largeObject(250_000));
			const { router, read } = historyOf([stringRun, objectRun]);
			for (const detail of [stringRun, objectRun]) {
				const stopWatching = watchEventLoopTurns();
				let output: string;
				let turns: number[];
				try {
					output = await read(`history://workflows/${detail.runId}`);
				} finally {
					turns = await stopWatching();
				}
				assertFewStalls(turns, RENDER_BLOCK_LIMIT_MS, `reading ${detail.runId}`);
				const expected = referenceLines(detail);
				const shown = output.split("\n");
				const note = shown.pop()!;
				assert.ok(shown.length > 0);
				assert.deepEqual(shown, expected.slice(0, shown.length));
				assert.equal(
					note,
					`[read lines 1-${shown.length} of ${expected.length}; the byte budget ran out; continue with history://workflows/${detail.runId}?cursor=${shown.length + 1}:${shown.length + 1}-${expected.length}]`,
				);

				const stopSearchWatching = watchEventLoopTurns();
				let found: string;
				try {
					found =
						(await router.search?.(`history://workflows/${detail.runId}`, {
							pattern: "needle-token",
							ignoreCase: false,
							literal: false,
							contextBefore: 0,
							contextAfter: 0,
						})) ?? "";
				} finally {
					turns = await stopSearchWatching();
				}
				assertFewStalls(turns, RENDER_BLOCK_LIMIT_MS, `searching ${detail.runId}`);
				assert.match(found, new RegExp(`^history://workflows/${detail.runId}:6: summary: needle-token`, "m"));

				const controller = new AbortController();
				const aborted = router.readSelected?.(`history://workflows/${detail.runId}`, { signal: controller.signal });
				setTimeout(() => controller.abort(new Error("stop reading")), 5);
				await assert.rejects(Promise.resolve(aborted), /stop reading/);
			}
		},
		LARGE_RUN_TIMEOUT_MS,
	);

	it(
		"searches a large workflow run with a multi-line pattern in bounded steps (#5250)",
		async () => {
			const stringRun = runDetail("run-text", BASE, { text: hugeText(2 * HUGE_TEXT_CHARS) });
			const { router } = historyOf([stringRun]);
			for (const pattern of ["needle-token run-text\\n", "(?<=summary: )needle-token run-text\\n"]) {
				const stopWatching = watchEventLoopTurns();
				let found: string;
				let turns: number[];
				try {
					found =
						(await router.search?.("history://workflows/run-text", {
							pattern,
							ignoreCase: false,
							literal: false,
							contextBefore: 0,
							contextAfter: 0,
						})) ?? "";
				} finally {
					turns = await stopWatching();
				}
				assertFewStalls(turns, RENDER_BLOCK_LIMIT_MS, `searching run-text for ${pattern}`);
				assert.match(found, /^history:\/\/workflows\/run-text:6: summary: needle-token run-text$/m);
				assert.match(found, /multi-line matches are searched up to 16 KB of text/);
			}
		},
		LARGE_RUN_TIMEOUT_MS,
	);

	it("reads a large workflow run to the end through its continuations without changing a line (#5250)", async () => {
		const textRun: WorkflowRunDetail = {
			...runDetail("run-text", BASE, { text: hugeText(900_000), tail: "the end" }),
			identity: "label\nwith two lines",
			error: `${"short line\n".repeat(600)}${hugeText(150_000)}\n\n${hugeText(5_000).replaceAll(" ", "")}\nlast`,
		};
		const objectRun = runDetail("run-object", BASE + 1_000, {
			...largeObject(6_000),
			skipped: undefined,
			nested: { deep: largeObject(400), list: [largeObject(300), "x", null, 1.5, [true, false]] },
		});
		const { read } = historyOf([textRun, objectRun], { bytes: 60_000 });
		for (const detail of [textRun, objectRun]) {
			const expected = referenceLines(detail);
			const pieces: string[] = [];
			let url: string | undefined = `history://workflows/${detail.runId}`;
			let calls = 0;
			let joinNext = false;
			for (; url !== undefined && calls < 200; calls++) {
				const output = await read(url);
				assert.ok(Buffer.byteLength(output) <= 60_000, `a read returned ${Buffer.byteLength(output)} bytes`);
				const lines = output.split("\n");
				url = continuation(output);
				const note = url === undefined ? undefined : lines.pop();
				if (joinNext) pieces.push(`${pieces.pop()}${lines.shift()}`);
				pieces.push(...lines);
				joinNext = note !== undefined && /^\[read line \d+ of /.test(note);
			}
			assert.equal(url, undefined, "the read reached the end");
			assert.ok(calls > 2, `the read took ${calls} calls`);
			assert.equal(pieces.join("\n"), expected.join("\n"));
		}
	});
});
