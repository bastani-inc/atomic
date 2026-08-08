import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import type { BashOperations } from "../src/core/tools/bash.ts";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import { OutputAccumulator } from "../src/core/tools/output-accumulator.ts";
import { resetSessionTempDirStateForTesting } from "../src/core/tools/session-temp-dir.ts";
import { DEFAULT_MAX_BYTES } from "../src/core/tools/truncate.ts";

let sandbox: string;
const persistedFileMock = vi.hoisted(() => ({
	mode: "construct" as "construct" | "write",
	constructorCalls: 0,
	writeCalls: 0,
	endCalls: 0,
}));

vi.mock("../src/core/tools/persisted-output-file.ts", () => ({
	PersistedOutputFile: class {
		constructor() {
			persistedFileMock.constructorCalls++;
			if (persistedFileMock.mode === "construct") {
				const error = new Error("too many open files") as Error & { code: string };
				error.code = "EMFILE";
				throw error;
			}
		}

		write(): void {
			persistedFileMock.writeCalls++;
			throw new Error("buffered replay failed");
		}

		end(): void {
			persistedFileMock.endCalls++;
		}
	},
}));

beforeEach(() => {
	sandbox = realpathSync(mkdtempSync(join(tmpdir(), "atomic-accumulator-failure-")));
	resetSessionTempDirStateForTesting();
	persistedFileMock.mode = "construct";
	persistedFileMock.constructorCalls = 0;
	persistedFileMock.writeCalls = 0;
	persistedFileMock.endCalls = 0;
});

afterEach(() => {
	resetSessionTempDirStateForTesting();
	rmSync(sandbox, { recursive: true, force: true });
});

function outputAfterRefusal(): BashOperations {
	return {
		exec: async (_command, _cwd, { onData }) => {
			// The first chunk remains below the display cap and is held for a possible
			// spill. The second crosses the cap and triggers the mocked open failure.
			onData(Buffer.alloc(Math.floor(DEFAULT_MAX_BYTES / 2), 0x61), "stdout");
			onData(Buffer.alloc(DEFAULT_MAX_BYTES, 0x62), "stdout");
			// Persistence must now be unavailable: later output cannot retry the open.
			onData(Buffer.alloc(DEFAULT_MAX_BYTES, 0x63), "stdout");
			return { exitCode: 0 };
		},
	};
}

describe("OutputAccumulator spill-file open failure", () => {
	it("returns truncated bash output without advertising or retrying the failed path", async () => {
		const definition = createBashToolDefinition(process.cwd(), {
			operations: outputAfterRefusal(),
			sessionTempDir: () => sandbox,
		});

		const result = await definition.execute("call-emfile", { command: "produce output" });
		const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("");

		assert.ok(text.includes("[Showing"), "the bounded bash result still reports truncation");
		assert.equal(text.includes("Full output:"), false);
		assert.equal(text.includes("undefined"), false);
		assert.equal(result.details?.fullOutputPath, undefined);
		assert.equal(result.details?.truncation?.truncated, true);
		assert.equal(persistedFileMock.constructorCalls, 1, "later output must not retry a refused spill");
	});

	it("does not publish a writer that fails while replaying buffered output", () => {
		persistedFileMock.mode = "write";
		const accumulator = new OutputAccumulator({ maxBytes: 1024, maxLines: 1000, tempDir: sandbox });

		accumulator.append(Buffer.alloc(512, 0x61));
		accumulator.append(Buffer.alloc(1024, 0x62));
		accumulator.append(Buffer.alloc(1024, 0x63));
		accumulator.finish();
		const snapshot = accumulator.snapshot({ persistIfTruncated: true });

		assert.equal(snapshot.truncation.truncated, true);
		assert.equal(snapshot.fullOutputPath, undefined);
		assert.equal(persistedFileMock.constructorCalls, 1, "failure makes persistence unavailable");
		assert.equal(persistedFileMock.writeCalls, 1, "only the buffered chunk reached the uncommitted writer");
		assert.equal(persistedFileMock.endCalls, 1, "the uncommitted writer is discarded best-effort");
	});
});
