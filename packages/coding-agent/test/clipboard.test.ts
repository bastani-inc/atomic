import assert from "node:assert/strict";
import { execFile, execFileSync, execSync, spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import type * as OsModule from "os";
import { platform } from "os";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { copyToClipboard, readClipboardText } from "../src/utils/clipboard.js";

const mocks = vi.hoisted(() => {
	return {
		clipboard: {
			setText: vi.fn<(text: string) => Promise<void>>(),
		},
		execSync: vi.fn(),
		execFile: vi.fn(),
		execFileSync: vi.fn<(file: string, args: string[], options?: object) => Buffer>(),
		spawn: vi.fn(),
		platform: vi.fn<() => NodeJS.Platform>(),
		isWaylandSession: vi.fn<() => boolean>(),
	};
});

vi.mock("../src/utils/clipboard-native.js", () => {
	return {
		clipboard: mocks.clipboard,
	};
});

vi.mock("child_process", () => {
	return {
		execSync: mocks.execSync,
		execFile: mocks.execFile,
		execFileSync: mocks.execFileSync,
		spawn: mocks.spawn,
	};
});

vi.mock("os", async () => {
	return {
		...(await vi.importActual<typeof OsModule>("os")),
		platform: mocks.platform,
	};
});

vi.mock("../src/utils/clipboard-image.js", () => {
	return {
		isWaylandSession: mocks.isWaylandSession,
	};
});

const mockedExecSync = vi.mocked(execSync);
const mockedExecFile = vi.mocked(execFile);
const mockedExecFileSync = vi.mocked(execFileSync);
const mockedSpawn = vi.mocked(spawn);
const mockedPlatform = vi.mocked(platform);

let originalWrite: typeof process.stdout.write;
let stdoutWrites: string[];
let nativeResolved = false;

function osc52Writes(): string[] {
	return stdoutWrites.filter((write) => write.startsWith("\x1b]52;c;"));
}

function execSyncCommands(): string[] {
	return mockedExecSync.mock.calls.map(([command]) => command as string);
}

function execFileSyncFiles(): string[] {
	return mockedExecFileSync.mock.calls.map(([file]) => file);
}

function spawnCalls(): {
	command: string;
	args: readonly string[];
	options: { stdio?: unknown; env?: NodeJS.ProcessEnv };
}[] {
	return mockedSpawn.mock.calls.map(([command, args, options]) => ({
		command: command as string,
		args: args as readonly string[],
		options: options as { stdio?: unknown; env?: NodeJS.ProcessEnv },
	}));
}

function mockWlCopyExit(code: number): void {
	const child = {
		once(event: string, listener: (value: number | null) => void) {
			if (event === "close") queueMicrotask(() => listener(code));
			return child;
		},
		stdin: {
			on() {
				return child.stdin;
			},
			end: vi.fn(),
		},
	};
	mockedSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);
}

beforeEach(() => {
	vi.unstubAllEnvs();
	vi.stubEnv("SSH_CONNECTION", "");
	vi.stubEnv("SSH_CLIENT", "");
	vi.stubEnv("MOSH_CONNECTION", "");
	vi.stubEnv("TERMUX_VERSION", "");
	vi.stubEnv("WAYLAND_DISPLAY", "");
	vi.stubEnv("DISPLAY", "");
	vi.stubEnv("WT_SESSION", "");
	vi.stubEnv("WSL_DISTRO_NAME", "");
	vi.stubEnv("WSLENV", "");
	stdoutWrites = [];
	nativeResolved = false;
	mocks.clipboard.setText.mockReset();
	mocks.execSync.mockReset();
	mocks.execFile.mockReset();
	mocks.execFileSync.mockReset();
	mocks.spawn.mockReset();
	mocks.platform.mockReset();
	mocks.isWaylandSession.mockReset();
	mockedPlatform.mockReturnValue("darwin");
	mocks.isWaylandSession.mockReturnValue(false);
	mocks.clipboard.setText.mockImplementation(async () => {
		await new Promise((resolve) => setTimeout(resolve, 1));
		nativeResolved = true;
	});
	originalWrite = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((...args: Parameters<typeof process.stdout.write>) => {
		const [chunk] = args;
		if (typeof chunk === "string" && chunk.startsWith("\x1b]52;c;")) {
			stdoutWrites.push(chunk);
			return true;
		}
		return originalWrite(...args);
	}) as typeof process.stdout.write;
});

afterEach(() => {
	process.stdout.write = originalWrite;
	vi.unstubAllEnvs();
});

function mockTermuxClipboardGet(result: { stdout: string } | Error): void {
	mockedExecFile.mockImplementation(((
		_file: string,
		_args: string[],
		_options: object,
		callback: (error: Error | null, stdout: string) => void,
	) => {
		if (result instanceof Error) callback(result, "");
		else callback(null, result.stdout);
	}) as unknown as typeof execFile);
}

describe("readClipboardText", () => {
	test.each(["clipboard text", ""])("Termux reads termux-clipboard-get result %j on Android", async (text) => {
		// Regression test for earendil-works/pi#10391: Termux reports platform "android".
		mockedPlatform.mockReturnValue("android");
		vi.stubEnv("TERMUX_VERSION", "0.119");
		mockTermuxClipboardGet({ stdout: text });
		const source = { getText: vi.fn(async () => "native text") };

		assert.equal(await readClipboardText(source), text || null);

		assert.deepEqual(
			mockedExecFile.mock.calls.map(([file, args]) => [file, args]),
			[["termux-clipboard-get", []]],
		);
		assert.equal(source.getText.mock.calls.length, 0);
	});

	test("falls back to the native clipboard when termux-clipboard-get fails", async () => {
		vi.stubEnv("TERMUX_VERSION", "0.119");
		mockTermuxClipboardGet(new Error("termux-clipboard-get: not found"));

		assert.equal(await readClipboardText({ getText: async () => "native text" }), "native text");
	});

	test("does not run termux-clipboard-get outside Termux", async () => {
		assert.equal(await readClipboardText({ getText: async () => "native text" }), "native text");
		assert.equal(mockedExecFile.mock.calls.length, 0);
	});
});

describe("copyToClipboard", () => {
	test("local native success skips OSC 52 and shell fallbacks", async () => {
		await copyToClipboard("hello");

		assert.deepEqual(mocks.clipboard.setText.mock.calls, [["hello"]]);
		assert.equal(osc52Writes().length, 0);
		assert.equal(mockedExecSync.mock.calls.length, 0);
		assert.equal(mockedSpawn.mock.calls.length, 0);
	});

	test("remote native success emits OSC 52 after native write", async () => {
		vi.stubEnv("SSH_CONNECTION", "client server");
		mocks.clipboard.setText.mockImplementation(async () => {
			await new Promise((resolve) => setTimeout(resolve, 1));
			assert.equal(osc52Writes().length, 0);
			nativeResolved = true;
		});

		await copyToClipboard("hello");

		assert.equal(nativeResolved, true);
		assert.equal(osc52Writes().length, 1);
		assert.equal(mockedExecSync.mock.calls.length, 0);
	});

	test("local shell fallback success skips OSC 52", async () => {
		mocks.clipboard.setText.mockRejectedValue(new Error("native failed"));
		mockedExecSync.mockReturnValue(Buffer.alloc(0));

		await copyToClipboard("hello");

		assert.equal(mockedExecSync.mock.calls.length, 1);
		const [command, options] = mockedExecSync.mock.calls[0]!;
		assert.equal(command, "pbcopy");
		assert.equal(options?.input, "hello");
		assert.deepEqual(options?.stdio, ["pipe", "ignore", "ignore"]);
		assert.equal(options?.timeout, 5000);
		assert.equal(options?.env?.AI_AGENT, "atomic");
		assert.equal(osc52Writes().length, 0);
	});

	test.each(["SSH_CONNECTION", "SSH_CLIENT", "MOSH_CONNECTION"])("remote %s retains OSC 52 fallback", async (key) => {
		vi.stubEnv(key, "remote");
		mocks.clipboard.setText.mockRejectedValue(new Error("native failed"));
		mockedExecSync.mockImplementation(() => {
			throw new Error("pbcopy failed");
		});

		await copyToClipboard("hello");

		assert.equal(osc52Writes().length, 1);
	});

	test("does not emit oversized OSC 52 payloads", async () => {
		vi.stubEnv("SSH_CONNECTION", "remote");
		mocks.clipboard.setText.mockRejectedValue(new Error("native failed"));
		mockedExecSync.mockImplementation(() => {
			throw new Error("pbcopy failed");
		});

		await assert.rejects(copyToClipboard("x".repeat(80_000)), {
			message: "Clipboard unavailable: text exceeds the OSC 52 size limit",
		});
		assert.equal(osc52Writes().length, 0);
	});

	test("awaits successful wl-copy before reporting Wayland success", async () => {
		mockedPlatform.mockReturnValue("linux");
		mocks.isWaylandSession.mockReturnValue(true);
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-1");
		mockWlCopyExit(0);
		mockedExecSync.mockReturnValue(Buffer.alloc(0));

		await copyToClipboard("hello");

		const calls = spawnCalls();
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.command, "wl-copy");
		assert.deepEqual(calls[0]!.args, []);
		assert.deepEqual(calls[0]!.options.stdio, ["pipe", "ignore", "ignore"]);
		assert.equal(calls[0]!.options.env?.AI_AGENT, "atomic");
		assert.deepEqual(execSyncCommands(), ["which wl-copy"]);
		assert.equal(osc52Writes().length, 0);
	});

	test("falls through to X11 when wl-copy exits unsuccessfully", async () => {
		mockedPlatform.mockReturnValue("linux");
		mocks.isWaylandSession.mockReturnValue(true);
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-1");
		vi.stubEnv("DISPLAY", ":0");
		mockWlCopyExit(1);
		mockedExecSync.mockReturnValue(Buffer.alloc(0));

		await copyToClipboard("hello");

		assert.deepEqual(execSyncCommands(), ["which wl-copy", "xclip -selection clipboard"]);
		assert.equal(osc52Writes().length, 0);
	});

	test("rejects failed local wl-copy without emitting OSC 52", async () => {
		mockedPlatform.mockReturnValue("linux");
		mocks.isWaylandSession.mockReturnValue(true);
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-1");
		mockWlCopyExit(1);
		mockedExecSync.mockReturnValue(Buffer.alloc(0));

		await assert.rejects(copyToClipboard("hello"), {
			message: "Clipboard unavailable: install `wl-clipboard` (`wl-copy`) or check Wayland access",
		});
		assert.equal(osc52Writes().length, 0);
	});

	test("display-less Linux falls back to OSC 52", async () => {
		// Regression test for earendil-works/pi#9688: containers without X11/Wayland access.
		mockedPlatform.mockReturnValue("linux");

		await copyToClipboard("hello");

		assert.equal(mockedExecSync.mock.calls.length, 0);
		assert.equal(mockedExecFileSync.mock.calls.length, 0);
		assert.equal(osc52Writes().length, 1);
	});

	test("WSL without a display writes the Windows clipboard through PowerShell", async () => {
		// Regression test for earendil-works/pi#9688: WSL with WSLg disabled.
		mockedPlatform.mockReturnValue("linux");
		vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
		let written: string | undefined;
		mockedExecFileSync.mockImplementation((file, args) => {
			if (file !== "wslpath") return Buffer.alloc(0);
			written = readFileSync(args[1]!, "utf8");
			return Buffer.from("\\\\wsl.localhost\\Ubuntu\\tmp\\clip.txt\n");
		});

		await copyToClipboard("héllo");

		assert.deepEqual(execFileSyncFiles(), ["wslpath", "powershell.exe"]);
		assert.equal(written, "héllo");
		const [, wslpathArgs] = mockedExecFileSync.mock.calls[0]!;
		assert.equal(existsSync(wslpathArgs[1]!), false);
		const [, powershellArgs] = mockedExecFileSync.mock.calls[1]!;
		assert.match(powershellArgs[2]!, /Set-Clipboard/);
		assert.ok(powershellArgs[2]!.includes("'\\\\wsl.localhost\\Ubuntu\\tmp\\clip.txt'"));
		assert.equal(osc52Writes().length, 0);
	});

	test("WSL falls back to OSC 52 when Windows interop is unavailable", async () => {
		mockedPlatform.mockReturnValue("linux");
		vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
		mockedExecFileSync.mockImplementation(() => {
			throw new Error("wslpath: not found");
		});

		await copyToClipboard("hello");

		assert.deepEqual(execFileSyncFiles(), ["wslpath"]);
		assert.equal(osc52Writes().length, 1);
	});

	test("WSL in Windows Terminal prefers OSC 52 over PowerShell", async () => {
		mockedPlatform.mockReturnValue("linux");
		vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
		vi.stubEnv("WT_SESSION", "session");

		await copyToClipboard("hello");

		assert.equal(mockedExecFileSync.mock.calls.length, 0);
		assert.equal(osc52Writes().length, 1);
	});

	test("WSL in Windows Terminal emits OSC 52 once in a remote session", async () => {
		mockedPlatform.mockReturnValue("linux");
		vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
		vi.stubEnv("WT_SESSION", "session");
		vi.stubEnv("SSH_CONNECTION", "client server");

		await copyToClipboard("hello");

		assert.equal(mockedExecFileSync.mock.calls.length, 0);
		assert.equal(osc52Writes().length, 1);
	});

	test.each(["SSH_CONNECTION", "SSH_CLIENT", "MOSH_CONNECTION"])(
		"remote %s into WSL skips the Windows clipboard and emits OSC 52 for the client",
		async (key) => {
			// A remote session's copy belongs on the connected client; writing the remote host's
			// Windows clipboard as well would leak the text to a second endpoint.
			mockedPlatform.mockReturnValue("linux");
			vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
			vi.stubEnv(key, "client server");

			await copyToClipboard("hello");

			assert.equal(mockedExecFileSync.mock.calls.length, 0);
			assert.equal(osc52Writes().length, 1);
		},
	);

	test("WSL in Windows Terminal uses PowerShell for oversized OSC 52 payloads", async () => {
		mockedPlatform.mockReturnValue("linux");
		vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
		vi.stubEnv("WT_SESSION", "session");
		mockedExecFileSync.mockImplementation((file) =>
			file === "wslpath" ? Buffer.from("C:\\clip.txt") : Buffer.alloc(0),
		);

		await copyToClipboard("x".repeat(80_000));

		assert.deepEqual(execFileSyncFiles(), ["wslpath", "powershell.exe"]);
		assert.equal(osc52Writes().length, 0);
	});

	test("WSL with a display prefers the Linux clipboard tools", async () => {
		mockedPlatform.mockReturnValue("linux");
		vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
		mocks.isWaylandSession.mockReturnValue(true);
		mockWlCopyExit(0);
		mockedExecSync.mockReturnValue(Buffer.alloc(0));

		await copyToClipboard("hello");

		assert.deepEqual(
			spawnCalls().map(({ command, args }) => ({ command, args })),
			[{ command: "wl-copy", args: [] }],
		);
		assert.equal(mockedExecFileSync.mock.calls.length, 0);
		assert.equal(osc52Writes().length, 0);
	});

	test("remote WSLg session writes the display clipboard and still emits OSC 52 for the client", async () => {
		// Deliberate: the wl-copy write serves the remote host's desktop, while the SSH user
		// is at the client, which only OSC 52 reaches. Mirrors "remote native success emits
		// OSC 52 after native write" for the Linux display backends.
		mockedPlatform.mockReturnValue("linux");
		vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
		vi.stubEnv("SSH_CONNECTION", "client server");
		mocks.isWaylandSession.mockReturnValue(true);
		mockWlCopyExit(0);
		mockedExecSync.mockReturnValue(Buffer.alloc(0));

		await copyToClipboard("hello");

		assert.deepEqual(
			spawnCalls().map(({ command, args }) => ({ command, args })),
			[{ command: "wl-copy", args: [] }],
		);
		assert.equal(mockedExecFileSync.mock.calls.length, 0);
		assert.equal(osc52Writes().length, 1);
	});

	test("Termux on Android writes through termux-clipboard-set", async () => {
		mockedPlatform.mockReturnValue("android");
		vi.stubEnv("TERMUX_VERSION", "0.119");
		mocks.clipboard.setText.mockRejectedValue(new Error("native failed"));
		mockedExecSync.mockReturnValue(Buffer.alloc(0));

		await copyToClipboard("hello");

		assert.deepEqual(execSyncCommands(), ["termux-clipboard-set"]);
		assert.equal(osc52Writes().length, 0);
	});

	test.each([
		["darwin", "", "", "", "Clipboard unavailable"],
		["win32", "", "", "", "Clipboard unavailable"],
		["linux", "1", "wayland-1", ":0", "Clipboard unavailable: install the Termux:API app and `termux-api` package"],
		["android", "0.119", "", "", "Clipboard unavailable: install the Termux:API app and `termux-api` package"],
		[
			"linux",
			"",
			"wayland-1",
			":0",
			"Clipboard unavailable: install `wl-clipboard` (`wl-copy`) or check Wayland access",
		],
		["linux", "", "", ":0", "Clipboard unavailable: install `xclip` or `xsel`, or check X11 access"],
	] as const)(
		"local %s failure reports backend guidance (%s %s %s)",
		async (os, termux, wayland, display, message) => {
			mockedPlatform.mockReturnValue(os);
			vi.stubEnv("TERMUX_VERSION", termux);
			vi.stubEnv("WAYLAND_DISPLAY", wayland);
			vi.stubEnv("DISPLAY", display);
			mocks.isWaylandSession.mockReturnValue(Boolean(wayland));
			mocks.clipboard.setText.mockRejectedValue(new Error("native failed"));
			mockedExecSync.mockImplementation(() => {
				throw new Error("backend failed");
			});
			await assert.rejects(copyToClipboard("hello"), { message });
			assert.equal(osc52Writes().length, 0);
		},
	);
});
