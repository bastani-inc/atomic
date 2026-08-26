import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("child_process")>();
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
});

describe("issue #6596 taskkill spawn failures", () => {
	it("uses System32 taskkill and consumes its asynchronous spawn error", () => {
		const child = new EventEmitter() as ChildProcess;
		const previousSystemRoot = process.env.SystemRoot;
		process.env.SystemRoot = "C:\\CustomWindows";
		spawnMock.mockReturnValue(child);

		try {
			withWindowsPlatform(() => {
				killProcessTree(1234);
			});
		} finally {
			if (previousSystemRoot === undefined) delete process.env.SystemRoot;
			else process.env.SystemRoot = previousSystemRoot;
		}

		// Atomic also passes a curated child environment, which upstream does not, so
		// the options are matched on the fields this regression is about rather than
		// exactly. `windowsHide` is asserted because `detached` otherwise gives the
		// child its own console window on Windows.
		expect(spawnMock).toHaveBeenCalledWith(
			join("C:\\CustomWindows", "System32", "taskkill.exe"),
			["/F", "/T", "/PID", "1234"],
			expect.objectContaining({ detached: true, stdio: "ignore", windowsHide: true }),
		);
		expect(() => child.emit("error", new Error("spawn taskkill ENOENT"))).not.toThrow();
	});

	it("falls back to C:\\Windows when SystemRoot is unset", () => {
		const child = new EventEmitter() as ChildProcess;
		const previousSystemRoot = process.env.SystemRoot;
		delete process.env.SystemRoot;
		spawnMock.mockReturnValue(child);

		try {
			withWindowsPlatform(() => {
				killProcessTree(4321);
			});
		} finally {
			if (previousSystemRoot !== undefined) process.env.SystemRoot = previousSystemRoot;
		}

		expect(spawnMock).toHaveBeenCalledWith(
			join("C:\\Windows", "System32", "taskkill.exe"),
			["/F", "/T", "/PID", "4321"],
			expect.objectContaining({ detached: true, stdio: "ignore", windowsHide: true }),
		);
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
