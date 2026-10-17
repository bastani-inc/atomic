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
	await Promise.all(
		[...terminations].map(async ([worker, resolve]) => {
			resolve(await terminate.call(worker));
		}),
	);
	terminations.clear();
});

const run = (code: string, signal?: AbortSignal) =>
	executeCodemode("worker-admission", { code }, signal, undefined, undefined);

function assertErrorText(result: Awaited<ReturnType<typeof run>>, text: string): void {
	assert.equal(result.isError, true);
	assert.ok(result.content.some((block) => block.type === "text" && block.text.includes(text)));
}

describe("codemode worker admission", () => {
	it.each(["timeout", "abort", "success"] as const)(
		"holds shared capacity until actual worker exit after %s (earendil-works/pi#10748)",
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
				else {
					assertErrorText(
						result,
						how === "timeout" ? "Execution timed out after 200 ms" : "This operation was aborted",
					);
				}
				assert.equal(terminations.size, i + 1);
			}

			const blocked = await run("return 3");
			assert.deepEqual(blocked.details?.calls, []);
			assertErrorText(blocked, "Codemode worker limit reached (2 workers are still running or shutting down)");
			assert.equal(terminations.size, 2);

			const aborted = await run("while (true) {}", AbortSignal.abort());
			assertErrorText(aborted, "This operation was aborted");
			assert.equal(terminations.size, 2);

			// Releasing one actual worker, not its result, permits exactly one new execution.
			const [worker, resolve] = [...terminations][0];
			resolve(await terminate.call(worker));
			terminations.delete(worker);
			assert.equal((await run("return 42")).isError, undefined);
			assert.equal(terminations.size, 2);
		},
	);

	it("bounds workers that start after their results already timed out (earendil-works/pi#10748)", async () => {
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
			const blocked = await run("return 1");
			assertErrorText(blocked, "Codemode worker limit reached");
			assert.equal(terminations.size, 2);
		} finally {
			loading.resolve(wasm);
			vi.mocked(codemode.loadQuickJSWasm).mockReset();
		}
	});

	it("admits only two workers from a concurrent burst (earendil-works/pi#10748)", async () => {
		const results = await Promise.all(Array.from({ length: 6 }, () => run("return 1")));
		assert.equal(results.filter((result) => !result.isError).length, 2);
		assert.equal(results.filter((result) => result.isError).length, 4);
		assert.equal(terminations.size, 2);
	});
});
