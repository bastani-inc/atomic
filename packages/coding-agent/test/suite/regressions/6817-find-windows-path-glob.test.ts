import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { spawn } from "child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	ensureTool: vi.fn<(tool: "fd" | "rg", silent?: boolean) => Promise<string | undefined>>(),
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

import { createFindToolDefinition } from "../../../src/core/tools/find.ts";

const mockedSpawn = vi.mocked(spawn);

function finishedFdProcess(): ReturnType<typeof spawn> {
	const child = Object.assign(new EventEmitter(), {
		killed: false,
		kill: vi.fn(() => true),
		stderr: Readable.from([]),
		stdout: Readable.from([]),
	});
	queueMicrotask(() => child.emit("close", 0));
	return child as unknown as ReturnType<typeof spawn>;
}

describe("issue #6817: Windows find path globs", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
		vi.restoreAllMocks();
	});

	it("passes slash-containing fallback patterns to fd with native separator classes", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "atomic-6817-"));
		mkdirSync(join(tempDir, "src"), { recursive: true });
		mocks.ensureTool.mockResolvedValue("fd");
		mocks.loadNativeSearchBinding.mockReturnValue(null);
		mockedSpawn.mockImplementation(() => finishedFdProcess());
		const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

		try {
			Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
			await createFindToolDefinition(tempDir).execute("find-windows-path-glob", { paths: ["src/**/lib/*.spec.ts"] });
		} finally {
			if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
		}

		const args = mockedSpawn.mock.calls[0]?.[1];
		expect(mocks.ensureTool).toHaveBeenCalledWith("fd", true);
		expect(args).toContain("--full-path");
		expect(args?.at((args?.indexOf("--") ?? -1) + 1)).toBe(String.raw`**[/\\]lib[/\\]*.spec.ts`);
	});
});
