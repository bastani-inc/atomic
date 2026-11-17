import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	start: vi.fn(),
	write: vi.fn(),
	resize: vi.fn(),
	config: vi.fn(() => ({ shell: "pwsh.exe", args: [] })),
}));
vi.mock("../src/utils/shell.ts", () => ({ getPowerShellConfig: mocks.config }));
vi.mock("../src/utils/module-require.js", () => ({
	createModuleRequire: () => () => ({
		PtySession: class {
			start = mocks.start;
			write = mocks.write;
			resize = mocks.resize;
		},
	}),
}));

import { isWindowsSubshellActive, openWindowsSubshell } from "../src/modes/interactive/interactive-windows-subshell.ts";

let raw = true;
const input = Object.assign(new EventEmitter(), {
	setRawMode: vi.fn((value: boolean) => {
		raw = value;
	}),
	resume: vi.fn(),
	pause: vi.fn(),
});
Object.defineProperty(input, "isRaw", { get: () => raw });
const output = Object.assign(new EventEmitter(), { columns: 120, rows: 36, write: vi.fn() });
const ui = {
	stop: vi.fn(() => {
		raw = false;
	}),
	start: vi.fn(() => {
		expect(raw).toBe(false);
	}),
	requestRender: vi.fn(),
};
const owner = { ui, sessionManager: { getCwd: () => "C:/project" } };

beforeEach(() => {
	raw = true;
	output.columns = 120;
	output.rows = 36;
	vi.spyOn(process, "stdin", "get").mockReturnValue(input as typeof process.stdin);
	vi.spyOn(process, "stdout", "get").mockReturnValue(output as typeof process.stdout);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
	expect(input.listenerCount("data")).toBe(0);
	expect(output.listenerCount("resize")).toBe(0);
});

test("releases the terminal once and restores it after PowerShell exits", async () => {
	let finish!: () => void;
	mocks.start.mockImplementationOnce(
		() =>
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
	);
	const run = openWindowsSubshell(owner);
	expect(isWindowsSubshellActive(owner)).toBe(true);
	await openWindowsSubshell(owner);
	await setImmediate();
	try {
		expect(mocks.start).toHaveBeenCalledTimes(1);
		expect(mocks.start).toHaveBeenCalledWith(
			{
				shell: "pwsh.exe",
				shellArgs: ["-NoLogo", "-NoExit", "-Command"],
				command: "",
				cwd: "C:/project",
				cols: 120,
				rows: 36,
			},
			expect.any(Function),
		);
		expect(ui.stop).toHaveBeenCalledOnce();
		expect(ui.stop).toHaveBeenCalledWith({ preserveScreen: true });
		expect(ui.start).not.toHaveBeenCalled();
		mocks.start.mock.calls[0][1](null, "PS C:/project> ");
		expect(output.write).toHaveBeenCalledWith("PS C:/project> ");
		output.columns = 100;
		output.rows = 30;
		output.emit("resize");
		expect(mocks.resize).toHaveBeenCalledWith(100, 30);
	} finally {
		finish();
		await run;
	}
	expect(isWindowsSubshellActive(owner)).toBe(false);
	expect(ui.start).toHaveBeenCalledOnce();
	expect(ui.requestRender).toHaveBeenCalledWith(true);
});

test.each(["throw", "reject"])("restores the terminal and SIGINT listeners after native start %s", async (failure) => {
	const error = new Error("spawn failed");
	mocks.start.mockImplementationOnce(() => {
		if (failure === "throw") throw error;
		return Promise.reject(error);
	});
	const listeners = process.listeners("SIGINT");
	await expect(openWindowsSubshell(owner)).rejects.toThrow(error);
	expect(isWindowsSubshellActive(owner)).toBe(false);
	expect(process.listeners("SIGINT")).toEqual(listeners);
	expect(ui.start).toHaveBeenCalledOnce();
	expect(ui.requestRender).toHaveBeenCalledWith(true);
});

test("forwards Ctrl+C as input to an isolated shell instead of enabling outer console signals", async () => {
	let finish!: () => void;
	mocks.start.mockImplementationOnce(
		() =>
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
	);
	const run = openWindowsSubshell(owner);
	await setImmediate();
	try {
		expect(raw).toBe(true);
		input.emit("data", "\x03");
		expect(mocks.write).toHaveBeenCalledWith("\x03");
		input.emit("data", Buffer.from("exit\r"));
		expect(mocks.write).toHaveBeenCalledWith("exit\r");
	} finally {
		finish();
		await run;
	}
});

test("does not request a duplicate outer cursor reply that consumes the shell's first keystroke", async () => {
	mocks.start.mockImplementationOnce((_options, onChunk) => {
		onChunk(null, "\x1b[");
		onChunk(null, "6nPS C:/project> ");
		return Promise.resolve();
	});
	await openWindowsSubshell(owner);
	expect(output.write.mock.calls.map(([text]) => text).join("")).toBe("PS C:/project> ");
});

test("finishes Alt+Z input dispatch before changing the Windows console mode", async () => {
	mocks.start.mockResolvedValueOnce(undefined);
	const run = openWindowsSubshell(owner);
	try {
		expect(ui.stop).not.toHaveBeenCalled();
	} finally {
		await run;
	}
	expect(ui.stop).toHaveBeenCalledOnce();
});
