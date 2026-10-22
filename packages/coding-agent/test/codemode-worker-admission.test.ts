import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import * as codemode from "@earendil-works/pi-codemode";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { executeCodemode } from "../src/extensions/codemode/execute.js";

vi.mock("@earendil-works/pi-codemode", async (importOriginal) => {
	const actual = await importOriginal<typeof codemode>();
	return { ...actual, loadQuickJSWasm: vi.fn(actual.loadQuickJSWasm) };
});

const terminate = Worker.prototype.terminate;
const terminations = new Map<Worker, (code: number) => void>();

beforeEach(() => {
	vi.spyOn(Worker.prototype, "terminate").mockImplementation(function (this: Worker) {
		this.ref();
		return new Promise<number>((resolve) => {
			terminations.set(this, resolve);
		});
	});
});

afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await Promise.all(
		[...terminations].map(async ([worker, resolve]) => {
			resolve(await terminate.call(worker));
		}),
	);
	terminations.clear();
});

const run = (code: string, signal?: AbortSignal) =>
	executeCodemode("worker-admission", { code }, signal, undefined, undefined);

/** Let the first held worker actually exit. */
async function releaseOne(): Promise<void> {
	const [worker, resolve] = [...terminations][0];
	terminations.delete(worker);
	resolve(await terminate.call(worker));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function assertErrorText(result: Awaited<ReturnType<typeof run>>, text: string): void {
	assert.equal(result.isError, true);
	assert.ok(result.content.some((block) => block.type === "text" && block.text.includes(text)));
}

function assertRunningTimeout(result: Awaited<ReturnType<typeof run>>, budgetMs: number): void {
	assert.equal(result.isError, true);
	const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
	const reported = /Execution timed out after (\d+) ms/u.exec(text);
	assert.ok(reported, `expected a running-script timeout, got: ${text}`);
	assert.ok(Number(reported[1]) > 0 && Number(reported[1]) <= budgetMs);
	assert.doesNotMatch(text, /while waiting for a free codemode worker|The script did not start/u);
}

function assertOutputText(result: Awaited<ReturnType<typeof run>>, text: string): void {
	assert.equal(result.isError, undefined);
	assert.ok(result.content.some((block) => block.type === "text" && block.text === text));
}

describe("codemode worker admission", () => {
	it.each(["timeout", "abort", "success"] as const)(
		"holds shared capacity until actual worker exit after %s (earendil-works/pi#10748, #3862)",
		async (how) => {
			const once = vi.spyOn(Worker.prototype, "once");
			for (let i = 0; i < 2; i++) {
				const controller = new AbortController();
				const exitListenersBefore = once.mock.calls.filter(([event]) => event === "exit").length;
				const pending = run(
					how === "timeout"
						? '// @options: {"timeout_ms": 200}\nwhile (true) {}'
						: how === "abort"
							? "while (true) {}"
							: "return 1",
					controller.signal,
				);
				if (how === "abort") {
					await vi.waitFor(() =>
						assert.ok(once.mock.calls.filter(([event]) => event === "exit").length > exitListenersBefore),
					);
					controller.abort();
				}
				const result = await pending;
				if (how === "success") assert.equal(result.isError, undefined);
				else if (how === "timeout") assertRunningTimeout(result, 200);
				else assertErrorText(result, "This operation was aborted");
				assert.equal(terminations.size, i + 1);
			}

			// earendil-works/pi#11184: at capacity, a script waits for a worker instead of failing.
			let waitingSettled = false;
			const waiting = run("return 3").finally(() => {
				waitingSettled = true;
			});

			const abortWhileWaiting = new AbortController();
			const aborted = run("while (true) {}", abortWhileWaiting.signal);
			await sleep(50);
			abortWhileWaiting.abort();
			const abortedResult = await aborted;
			assertErrorText(abortedResult, "Script aborted: This operation was aborted");
			assertErrorText(abortedResult, "The script did not start.");

			const timedOut = await run('// @options: {"timeout_ms": 50}\nreturn 1');
			assertErrorText(timedOut, "Execution timed out after 50 ms while waiting for a free codemode worker");

			assert.equal(waitingSettled, false);
			assert.equal(terminations.size, 2);

			// Releasing one actual worker, not its result, admits exactly the waiting script.
			await releaseOne();
			assertOutputText(await waiting, "3");
			assert.equal(terminations.size, 2);
		},
	);

	it("starts no worker for a launch that resumes after its result timed out (earendil-works/pi#10748)", async () => {
		const wasm = await codemode.loadQuickJSWasm();
		const loading = Promise.withResolvers<codemode.CodemodeWasmModule>();
		vi.mocked(codemode.loadQuickJSWasm).mockReturnValue(loading.promise);
		try {
			const results = await Promise.all(
				Array.from({ length: 3 }, () => run('// @options: {"timeout_ms": 20}\nwhile (true) {}')),
			);
			assert.ok(results.every((result) => result.isError));
			assert.equal(terminations.size, 0);
			loading.resolve(wasm);
			assert.equal((await run("return 1")).isError, undefined);
			// Only the last script's worker started.
			assert.equal(terminations.size, 1);
		} finally {
			loading.resolve(wasm);
			vi.mocked(codemode.loadQuickJSWasm).mockReset();
		}
	});

	it("queues a concurrent burst behind two workers (earendil-works/pi#10748, earendil-works/pi#11184)", async () => {
		const results: Awaited<ReturnType<typeof run>>[] = [];
		const pending = Array.from({ length: 6 }, () => run("return 1").then((result) => results.push(result)));
		for (let released = 0; released < 4; released++) {
			await vi.waitFor(() => {
				assert.equal(terminations.size, 2);
				assert.equal(results.length, released + 2);
			});
			await sleep(50);
			assert.equal(results.length, released + 2);
			await releaseOne();
		}
		await Promise.all(pending);
		assert.ok(results.every((result) => result.isError === undefined));
		assert.equal(terminations.size, 2);
	});

	// earendil-works/pi#11184: in-process hosts with many sessions can raise the limit.
	it.each(["ATOMIC_CODEMODE_MAX_WORKERS", "PI_CODEMODE_MAX_WORKERS"])("reads the limit from %s", async (name) => {
		vi.stubEnv(name, "3");
		const results: Awaited<ReturnType<typeof run>>[] = [];
		const pending = Array.from({ length: 4 }, () => run("return 1").then((result) => results.push(result)));
		await vi.waitFor(() => assert.equal(results.length, 3));
		await sleep(50);
		assert.equal(results.length, 3);
		assert.equal(terminations.size, 3);
		await releaseOne();
		await Promise.all(pending);
		assert.ok(results.every((result) => result.isError === undefined));
	});

	it("ignores an invalid ATOMIC_CODEMODE_MAX_WORKERS", async () => {
		vi.stubEnv("ATOMIC_CODEMODE_MAX_WORKERS", "0");
		const results: Awaited<ReturnType<typeof run>>[] = [];
		const pending = Array.from({ length: 3 }, () => run("return 1").then((result) => results.push(result)));
		await vi.waitFor(() => assert.equal(results.length, 2));
		await sleep(50);
		assert.equal(results.length, 2);
		await releaseOne();
		await Promise.all(pending);
	});
});

describe("codemode timeout budget after admission (#3862)", () => {
	it("reports the remaining running-script budget when admission itself took time", async () => {
		const real = performance.now.bind(performance);
		let calls = 0;
		vi.spyOn(performance, "now").mockImplementation(() => real() + 5 * calls++);
		const result = await run('// @options: {"timeout_ms": 200}\nwhile (true) {}');
		assertRunningTimeout(result, 200);
		assert.equal(terminations.size, 1);
	});
});
