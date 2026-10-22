import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { spawn } from "child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	ensureTool: vi.fn<(tool: "fd" | "rg") => Promise<string | undefined>>(),
	loadNativeSearchBinding: vi.fn(),
	spawn: vi.fn(),
}));

vi.mock("child_process", async () => {
	const actual = await vi.importActual<typeof import("child_process")>("child_process");
	return { ...actual, spawn: mocks.spawn };
});

vi.mock("../../../src/core/tools/search-native.ts", () => ({
	loadNativeSearchBinding: mocks.loadNativeSearchBinding,
}));

vi.mock("../../../src/utils/tools-manager.ts", () => ({
	ensureTool: mocks.ensureTool,
}));

import { createGrepToolDefinition } from "../../../src/core/tools/grep.ts";

const mockedSpawn = vi.mocked(spawn);

function finishedRipgrepProcess(): ReturnType<typeof spawn> {
	const child = Object.assign(new EventEmitter(), {
		killed: false,
		kill: vi.fn(() => true),
		stderr: Readable.from([]),
		stdout: Readable.from([]),
	});
	queueMicrotask(() => child.emit("close", 1));
	return child as unknown as ReturnType<typeof spawn>;
}

describe("issue #11203: grep ignores ripgrep configuration", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
		vi.restoreAllMocks();
	});

	it("starts ripgrep with --no-config before the pattern", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "atomic-11203-"));
		writeFileSync(join(tempDir, "fixture.txt"), "aXb\na.b\n");
		mocks.ensureTool.mockResolvedValue("rg");
		mocks.loadNativeSearchBinding.mockReturnValue(null);
		mockedSpawn.mockImplementation(() => finishedRipgrepProcess());

		await createGrepToolDefinition(tempDir).execute("grep-ripgrep-config", { pattern: "a.b" });

		const args = mockedSpawn.mock.calls[0]?.[1] as string[];
		expect(mocks.ensureTool).toHaveBeenCalledWith("rg");
		expect(args).toContain("--no-config");
		expect(args.indexOf("--no-config")).toBeLessThan(args.indexOf("--"));
	});
});
