import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { spawn } from "child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	ensureTool: vi.fn(),
	loadNativeSearchBinding: vi.fn(),
	spawn: vi.fn(),
}));

vi.mock("child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("child_process")>()),
	spawn: mocks.spawn,
}));

vi.mock("../src/core/tools/search-native.ts", () => ({
	loadNativeSearchBinding: mocks.loadNativeSearchBinding,
}));

vi.mock("../src/utils/tools-manager.ts", () => ({
	ensureTool: mocks.ensureTool,
}));

import { FileToolAbortedError, isFileToolAbortedError } from "../src/core/tools/file-tool-errors.ts";
import { createFindToolDefinition } from "../src/core/tools/find.ts";

const mockedSpawn = vi.mocked(spawn);

function finishedFdProcess(): ReturnType<typeof spawn> {
	const child = Object.assign(new EventEmitter(), {
		killed: false,
		kill: vi.fn(() => true),
		stderr: Readable.from([]),
		stdout: Readable.from([]),
	});
	child.stdout.on("end", () => setImmediate(() => child.emit("close", 0)));
	return child as unknown as ReturnType<typeof spawn>;
}

describe("find abort before fd starts", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "atomic-find-abort-"));
		mkdirSync(join(tempDir, "a"));
		mkdirSync(join(tempDir, "b"));
		mocks.ensureTool.mockResolvedValue("fd");
		mocks.loadNativeSearchBinding.mockReturnValue(null);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
		mocks.ensureTool.mockReset();
		mocks.loadNativeSearchBinding.mockReset();
		mockedSpawn.mockReset();
	});

	it("does not start fd for later search paths after an abort during an update", async () => {
		const controller = new AbortController();
		const reason = new Error("user cancelled");
		mockedSpawn.mockImplementation(() => finishedFdProcess());
		const def = createFindToolDefinition(tempDir);

		const failure = await def
			.execute(
				"call-1",
				{ paths: [join(tempDir, "a", "*.ts"), join(tempDir, "b", "*.ts")] },
				controller.signal,
				() => controller.abort(reason),
				undefined as never,
			)
			.catch((error: unknown) => error);

		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(failure).toBeInstanceOf(FileToolAbortedError);
		expect(isFileToolAbortedError(failure)).toBe(true);
		expect((failure as FileToolAbortedError).code).toBe("aborted");
		expect((failure as FileToolAbortedError).cause).toBe(reason);
		expect(mockedSpawn).toHaveBeenCalledTimes(1);
	});

	it("does not start fd when the signal was already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const def = createFindToolDefinition(tempDir);

		await expect(
			def.execute("call-1", { paths: [tempDir] }, controller.signal, undefined, undefined as never),
		).rejects.toBeInstanceOf(FileToolAbortedError);

		expect(mockedSpawn).not.toHaveBeenCalled();
	});

	it("does not start fd when the signal aborts while fd is being provisioned", async () => {
		const controller = new AbortController();
		mocks.ensureTool.mockImplementation(async () => {
			controller.abort();
			return "fd";
		});
		const def = createFindToolDefinition(tempDir);

		await expect(
			def.execute(
				"call-1",
				{ paths: [join(tempDir, "a", "*.ts")] },
				controller.signal,
				undefined,
				undefined as never,
			),
		).rejects.toBeInstanceOf(FileToolAbortedError);

		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(mockedSpawn).not.toHaveBeenCalled();
	});
});
