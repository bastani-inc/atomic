import assert from "node:assert/strict";
import type * as ChildProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof ChildProcess>();
	return { ...actual, spawn: spawnMock };
});

import { killProcessTree } from "../../../src/utils/shell.ts";

function withWindowsPlatform(test: () => void): void {
	const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
	try {
		Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
		test();
	} finally {
		if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
	}
}

afterEach(() => {
	spawnMock.mockReset();
	vi.unstubAllEnvs();
});

describe("issue #6596 taskkill spawn failures", () => {
	// #9490: missing or empty SystemRoot must retain an absolute taskkill fallback.
	it.each([
		["D:\\CustomWindows", "D:\\CustomWindows"],
		[undefined, "C:\\Windows"],
		["", "C:\\Windows"],
	] as const)("uses System32 taskkill and consumes its spawn error with SystemRoot=%j", (systemRoot, expectedRoot) => {
		const child = new EventEmitter();
		vi.stubEnv("SystemRoot", systemRoot);
		spawnMock.mockReturnValue(child);

		withWindowsPlatform(() => {
			killProcessTree(1234);
		});

		// Atomic also passes a curated child environment, which upstream does not, so
		// the options are matched on the fields this regression is about rather than
		// exactly. `windowsHide` is asserted because `detached` otherwise gives the
		// child its own console window on Windows.
		assert.equal(spawnMock.mock.calls.length, 1);
		const [command, args, options] = spawnMock.mock.calls[0];
		assert.equal(command, join(expectedRoot, "System32", "taskkill.exe"));
		assert.deepEqual(args, ["/F", "/T", "/PID", "1234"]);
		assert.deepEqual(
			{ detached: options.detached, stdio: options.stdio, windowsHide: options.windowsHide },
			{ detached: true, stdio: "ignore", windowsHide: true },
		);
		assert.doesNotThrow(() => child.emit("error", new Error("spawn taskkill ENOENT")));
	});

	/**
	 * Atomic reaps detached children from a worker thread that upstream does not
	 * have, and it spawned bare `taskkill` with no error listener. A failed spawn
	 * there takes the guardian thread down and leaks every child it exists to reap,
	 * so the worker source carries the same hardening as killProcessTree.
	 */
	it("hardens taskkill in the detached-child guardian worker source", async () => {
		const { readFileSync } = await import("node:fs");
		const shellSource = readFileSync(new URL("../../../src/utils/shell.ts", import.meta.url), "utf8");
		const guardian = /const PARENT_GUARDIAN_SOURCE = `([\s\S]*?)`;/u.exec(shellSource);
		expect(guardian).not.toBeNull();

		const workerSource: string = (guardian as RegExpExecArray)[1] as string;
		expect(workerSource).toContain('require("node:path")');
		expect(workerSource).toContain('"System32", "taskkill.exe"');
		expect(workerSource).toMatch(/child\.once\("error"/u);
		expect(workerSource).toContain("windowsHide: true");
		expect(workerSource).not.toMatch(/spawn\("taskkill"/u);
	});
});
