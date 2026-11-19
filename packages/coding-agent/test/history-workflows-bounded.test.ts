import assert from "node:assert/strict";
import { resolve } from "node:path";
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
import { assertFewStalls, type WatchedTurns, watchEventLoopTurns } from "./helpers/event-loop-turns.js";

const PROJECT = resolve("/projects/workflow-bounded");
const BASE = Date.parse("2026-11-01T00:00:00.000Z");
const RUN_COUNT = 25;
const RENDER_BLOCK_LIMIT_MS = 10;
const LARGE_RUN_TIMEOUT_MS = 120_000;
const HUGE_TEXT_CHARS = 32 * 1024 * 1024;

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
	it("labels a cut multi-line search window in the run log itself (#5250)", async () => {
		const detail = runDetail("run-window", BASE, { text: "x".repeat(150_000) });
		const { router, request } = historyOf([detail]);
		const output =
			(await router.search!("history://workflows/run-window", request("needle-token run-window\\n"))) ?? "";
		assert.match(output, /^history:\/\/workflows\/run-window:6: summary: needle-token run-window$/m);
		assert.match(
			output,
			/^history:\/\/workflows\/run-window:0: \[multi-line matches are searched up to 16 KB of text or 256 entries past where they start, so a longer match is not shown\]$/m,
		);
	});

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
				const stopWatching = watchEventLoopTurns(RENDER_BLOCK_LIMIT_MS);
				let output: string;
				let turns: WatchedTurns;
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

				const stopSearchWatching = watchEventLoopTurns(RENDER_BLOCK_LIMIT_MS);
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
				const stopWatching = watchEventLoopTurns(RENDER_BLOCK_LIMIT_MS);
				let found: string;
				let turns: WatchedTurns;
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

	it("preserves disjoint line ranges across workflow read continuations without reading omitted gaps (#5250)", async () => {
		const detail: WorkflowRunDetail = {
			...runDetail("run-disjoint", BASE),
			error: Array.from(
				{ length: 30 },
				(_, index) => `error-line-${String(index + 1).padStart(2, "0")}-${"x".repeat(40)}`,
			).join("\n"),
		};
		const expected = referenceLines(detail);
		assert.ok(expected.length >= 35, `expected at least 35 lines, got ${expected.length}`);
		const { read } = historyOf([detail], { bytes: 240 });
		const pieces: string[] = [];
		let url: string | undefined = "history://workflows/run-disjoint:10-13,25-28:raw";
		let calls = 0;
		for (; url !== undefined && calls < 20; calls++) {
			const output = await read(url);
			const lines = output.split("\n");
			url = continuation(output);
			if (url !== undefined) lines.pop();
			pieces.push(...lines);
		}
		assert.equal(url, undefined, "the disjoint read reached the end");
		assert.ok(calls >= 2, `expected multiple continuation calls, got ${calls}`);
		assert.deepEqual(pieces, [...expected.slice(9, 13), ...expected.slice(24, 28)]);
	});

	it("stops a workflow run search on the time budget without rendering the whole run and resumes with context intact (#5250)", async () => {
		const hugeRun = runDetail("run-huge-time", BASE, { text: hugeText(HUGE_TEXT_CHARS) });
		const timed = historyOf([hugeRun], { timeMs: 15 });
		const startedAt = performance.now();
		const partial =
			(await timed.router.search?.("history://workflows/run-huge-time", timed.request("needle-token"))) ?? "";
		const elapsedMs = performance.now() - startedAt;
		assert.match(partial, /^history:\/\/workflows\/run-huge-time:6: summary: needle-token run-huge-time$/m);
		assert.match(
			partial,
			/^history:\/\/workflows\/run-huge-time:0: \[the time budget ran out; continue with history:\/\/workflows\/run-huge-time\?cursor=0\.\d+/m,
		);
		assert.ok(elapsedMs < 250, `expected bounded stop under 250 ms, took ${Math.round(elapsedMs)} ms`);

		const nextTimedUrl = continuation(partial);
		assert.ok(nextTimedUrl !== undefined);
		const firstCursorLine = Number(/\?cursor=0\.(\d+)/.exec(nextTimedUrl)?.[1] ?? "0");
		const resumedStart = performance.now();
		const resumedPartial = (await timed.router.search?.(nextTimedUrl, timed.request("needle-token"))) ?? "";
		const resumedElapsedMs = performance.now() - resumedStart;
		const secondCursorLine = Number(/\?cursor=0\.(\d+)/.exec(continuation(resumedPartial) ?? "")?.[1] ?? "0");
		assert.ok(resumedElapsedMs < 250, `expected resumed stop under 250 ms, took ${Math.round(resumedElapsedMs)} ms`);
		assert.ok(
			secondCursorLine > firstCursorLine,
			`expected cursor to advance past ${firstCursorLine}, got ${secondCursorLine}`,
		);

		const lateRangeStart = performance.now();
		const lateRangeOut =
			(await timed.router.search?.("history://workflows/run-huge-time:7000-7010", timed.request("needle-token"))) ??
			"";
		const lateRangeElapsedMs = performance.now() - lateRangeStart;
		assert.ok(
			lateRangeElapsedMs < 250,
			`expected late range skip under 250 ms, took ${Math.round(lateRangeElapsedMs)} ms`,
		);
		assert.match(
			lateRangeOut,
			/^history:\/\/workflows\/run-huge-time:0: \[the time budget ran out; continue with history:\/\/workflows\/run-huge-time\?cursor=0\.\d+:7000-7010\]$/m,
		);

		const coldCursorStart = performance.now();
		const coldCursorOut =
			(await timed.router.search?.(
				"history://workflows/run-huge-time?cursor=0.7000",
				timed.request("needle-token"),
			)) ?? "";
		const coldCursorElapsedMs = performance.now() - coldCursorStart;
		assert.ok(
			coldCursorElapsedMs < 250,
			`expected cold late cursor skip under 250 ms, took ${Math.round(coldCursorElapsedMs)} ms`,
		);
		assert.match(
			coldCursorOut,
			/^history:\/\/workflows\/run-huge-time:0: \[the time budget ran out; continue with history:\/\/workflows\/run-huge-time\?cursor=0\.7000\]$/m,
		);

		const contextRun: WorkflowRunDetail = {
			...runDetail("run-context", BASE),
			error: Array.from({ length: 40 }, (_, index) =>
				index % 3 === 1 ? `hit-line-${index} needle-ctx` : `filler-line-${index}-${"y".repeat(36)}`,
			).join("\n"),
		};
		const full = historyOf([contextRun]);
		const req: InternalSearchRequest = {
			pattern: "needle-ctx",
			ignoreCase: false,
			literal: false,
			contextBefore: 1,
			contextAfter: 1,
		};
		const expectedRows = ((await full.router.search?.("history://workflows/run-context", req)) ?? "")
			.split("\n")
			.filter((line) => line !== "");
		const paged = historyOf([contextRun], { bytes: 900 });
		const actualRows: string[] = [];
		let url: string | undefined = "history://workflows/run-context";
		let calls = 0;
		for (; url !== undefined && calls < 30; calls++) {
			const out = (await paged.router.search?.(url, req)) ?? "";
			url = continuation(out);
			actualRows.push(
				...out.split("\n").filter((line) => line !== "" && !line.startsWith("history://workflows/run-context:0:")),
			);
		}
		assert.equal(url, undefined, "paged context search reached the end");
		assert.ok(calls >= 3, `expected at least 3 continuation calls, got ${calls}`);
		assert.deepEqual(actualRows, expectedRows);
	});
});
