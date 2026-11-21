import assert from "node:assert/strict";
import { execFile, spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import type * as OsModule from "os";
import { platform } from "os";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { copyToClipboard, readClipboardText } from "../src/utils/clipboard.js";

// The simulated platform's programs are the mocked child processes, so every helper is found under its own name.
vi.mock("../src/utils/helper-command.ts", () => ({
	findHelperExecutable: (name: string) => name,
	findHelperExecutableAsync: async (name: string) => name,
	helperLaunch: (name: string) => ({ file: name }),
	helperLaunchAsync: async (name: string) => ({ file: name }),
	missingHelperOptions: () => ({}),
}));

const mocks = vi.hoisted(() => {
	return {
		clipboard: {
			setText: vi.fn<(text: string) => Promise<void>>(),
		},
		execFile: vi.fn(),
		spawn: vi.fn(),
		platform: vi.fn<() => NodeJS.Platform>(),
		isWaylandSession: vi.fn<() => boolean>(),
	};
});

vi.mock("../src/utils/clipboard-native.js", () => {
	return {
		getNativeClipboard: () => mocks.clipboard,
	};
});

vi.mock("child_process", () => {
	return {
		execFile: mocks.execFile,
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

const mockedExecFile = vi.mocked(execFile);
const mockedSpawn = vi.mocked(spawn);
const mockedPlatform = vi.mocked(platform);

let originalWrite: typeof process.stdout.write;
let stdoutWrites: string[];
let nativeResolved = false;

function osc52Writes(): string[] {
	return stdoutWrites.filter((write) => write.startsWith("\x1b]52;c;"));
}

function spawnCommands(): string[] {
	return mockedSpawn.mock.calls.map(([command, args]) => {
		const argList = (args as readonly string[]) ?? [];
		return argList.length > 0 ? `${command as string} ${argList.join(" ")}` : (command as string);
	});
}

function execFileFiles(): string[] {
	return mockedExecFile.mock.calls.map(([file]) => file as string);
}

function spawnCalls(): {
	command: string;
	args: readonly string[];
	input: string | undefined;
	options: { stdio?: unknown; timeout?: number; env?: NodeJS.ProcessEnv; detached?: boolean; cwd?: string };
}[] {
	return mockedSpawn.mock.calls.map(([command, args, options], index) => ({
		command: command as string,
		args: args as readonly string[],
		input: spawnedChildren[index]?.input,
		options: options as {
			stdio?: unknown;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
			detached?: boolean;
			cwd?: string;
		},
	}));
}

let spawnedChildren: { input: string | undefined }[];

function mockSpawnExit(
	exitCodeForCommand: number | ((command: string, args: readonly string[]) => number | Error),
): void {
	mockedSpawn.mockImplementation(((command: string, args: readonly string[]) => {
		const record = { input: undefined as string | undefined };
		spawnedChildren.push(record);
		const outcome = typeof exitCodeForCommand === "function" ? exitCodeForCommand(command, args) : exitCodeForCommand;
		const child = {
			once(event: string, listener: (value: unknown) => void) {
				if (outcome instanceof Error) {
					if (event === "error") queueMicrotask(() => listener(outcome));
				} else if (event === "close") {
					queueMicrotask(() => listener(outcome));
				}
				return child;
			},
			stdin: {
				on() {
					return child.stdin;
				},
				end: vi.fn((text?: string) => {
					record.input = text;
				}),
			},
		};
		return child as unknown as ReturnType<typeof spawn>;
	}) as unknown as typeof spawn);
}

beforeEach(() => {
	vi.unstubAllEnvs();
	vi.stubEnv("SSH_CONNECTION", "");
	vi.stubEnv("SSH_CLIENT", "");
	vi.stubEnv("MOSH_CONNECTION", "");
	vi.stubEnv("REX_SESSION", "");
	vi.stubEnv("TERMUX_VERSION", "");
	vi.stubEnv("WAYLAND_DISPLAY", "");
	vi.stubEnv("DISPLAY", "");
	vi.stubEnv("WT_SESSION", "");
	vi.stubEnv("WSL_DISTRO_NAME", "");
	vi.stubEnv("WSLENV", "");
	vi.stubEnv("ATOMIC_CLIPBOARD_OSC52", undefined);
	vi.stubEnv("PI_CLIPBOARD_OSC52", undefined);
	stdoutWrites = [];
	spawnedChildren = [];
	nativeResolved = false;
	mocks.clipboard.setText.mockReset();
	mocks.execFile.mockReset();
	mocks.spawn.mockReset();
	mocks.platform.mockReset();
	mocks.isWaylandSession.mockReset();
	mockedPlatform.mockReturnValue("darwin");
	mocks.isWaylandSession.mockReturnValue(false);
	mockSpawnExit(0);
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
		assert.equal(mockedSpawn.mock.calls.length, 0);
	});

	test.each([
		["ATOMIC_CLIPBOARD_OSC52", "darwin", undefined],
		["ATOMIC_CLIPBOARD_OSC52", "win32", undefined],
		["ATOMIC_CLIPBOARD_OSC52", "linux", ":99"],
		["PI_CLIPBOARD_OSC52", "darwin", undefined],
	] as const)(
		"%s=1 emits OSC 52 after a successful %s copy (earendil-works/pi#10826, #10835, #10114)",
		async (name, currentPlatform, display) => {
			mockedPlatform.mockReturnValue(currentPlatform);
			if (display) vi.stubEnv("DISPLAY", display);
			vi.stubEnv(name, "1");

			await copyToClipboard("hello");

			if (currentPlatform === "linux") assert.deepEqual(spawnCommands(), ["xclip -selection clipboard"]);
			else assert.deepEqual(mocks.clipboard.setText.mock.calls, [["hello"]]);
			assert.deepEqual(osc52Writes(), [`\x1b]52;c;${Buffer.from("hello").toString("base64")}\x07`]);
		},
	);

	test("ATOMIC_CLIPBOARD_OSC52 takes precedence over PI_CLIPBOARD_OSC52", async () => {
		vi.stubEnv("ATOMIC_CLIPBOARD_OSC52", "0");
		vi.stubEnv("PI_CLIPBOARD_OSC52", "1");

		await copyToClipboard("hello");

		assert.deepEqual(mocks.clipboard.setText.mock.calls, [["hello"]]);
		assert.equal(osc52Writes().length, 0);
	});

	test("local shell fallback success skips OSC 52", async () => {
		mocks.clipboard.setText.mockRejectedValue(new Error("native failed"));

		await copyToClipboard("hello");

		const calls = spawnCalls();
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.command, "pbcopy");
		assert.equal(calls[0]!.input, "hello");
		assert.deepEqual(calls[0]!.options.stdio, ["pipe", "ignore", "ignore"]);
		assert.equal(calls[0]!.options.timeout, 5000);
		assert.equal(calls[0]!.options.env?.AI_AGENT, "atomic");
		assert.equal(osc52Writes().length, 0);
	});

	test.each(["SSH_CONNECTION", "SSH_CLIENT", "MOSH_CONNECTION"])("remote %s retains OSC 52 fallback", async (key) => {
		vi.stubEnv(key, "remote");
		mocks.clipboard.setText.mockRejectedValue(new Error("native failed"));
		mockSpawnExit(1);

		await copyToClipboard("hello");

		assert.equal(osc52Writes().length, 1);
	});

	test("a Rex terminal emits OSC 52 after a successful display write on the Rex server", async () => {
		mockedPlatform.mockReturnValue("linux");
		vi.stubEnv("DISPLAY", ":0");
		vi.stubEnv("REX_SESSION", "session:01a10cf3-2655-7e48-9b9c-43dd6612bef5");

		await copyToClipboard("hello");

		assert.deepEqual(spawnCommands(), ["xclip -selection clipboard"]);
		assert.deepEqual(osc52Writes(), [`\x1b]52;c;${Buffer.from("hello").toString("base64")}\x07`]);
	});

	test("a headless FreeBSD Rex server forwards copies through OSC 52", async () => {
		mockedPlatform.mockReturnValue("freebsd");
		vi.stubEnv("REX_SESSION", "session:01a10cf3-2655-7e48-9b9c-43dd6612bef5");

		await copyToClipboard("hello");

		assert.deepEqual(osc52Writes(), [`\x1b]52;c;${Buffer.from("hello").toString("base64")}\x07`]);
	});

	test("does not emit oversized OSC 52 payloads", async () => {
		vi.stubEnv("SSH_CONNECTION", "remote");
		mocks.clipboard.setText.mockRejectedValue(new Error("native failed"));
		mockSpawnExit(1);

		await assert.rejects(copyToClipboard("x".repeat(80_000)), {
			message: "Clipboard unavailable: text exceeds the OSC 52 size limit",
		});
		assert.equal(osc52Writes().length, 0);
	});

	test("awaits successful wl-copy before reporting Wayland success", async () => {
		mockedPlatform.mockReturnValue("linux");
		mocks.isWaylandSession.mockReturnValue(true);
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-1");
		mockSpawnExit(0);

		await copyToClipboard("hello");

		const calls = spawnCalls();
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.command, "wl-copy");
		assert.deepEqual(calls[0]!.args, []);
		assert.deepEqual(calls[0]!.options.stdio, ["pipe", "ignore", "ignore"]);
		assert.equal(calls[0]!.options.env?.AI_AGENT, "atomic");
		assert.equal(osc52Writes().length, 0);
	});

	test("falls through to X11 when wl-copy exits unsuccessfully", async () => {
		mockedPlatform.mockReturnValue("linux");
		mocks.isWaylandSession.mockReturnValue(true);
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-1");
		vi.stubEnv("DISPLAY", ":0");
		mockSpawnExit((command) => (command === "wl-copy" ? 1 : 0));

		await copyToClipboard("hello");

		assert.deepEqual(spawnCommands(), ["wl-copy", "xclip -selection clipboard"]);
		assert.equal(osc52Writes().length, 0);
	});

	test("runs Linux clipboard writers outside Atomic's process group so Ctrl+Z does not stop them (earendil-works/pi#11179)", async () => {
		mockedPlatform.mockReturnValue("linux");
		mocks.isWaylandSession.mockReturnValue(true);
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-1");
		vi.stubEnv("DISPLAY", ":0");
		mockSpawnExit((command) => (command === "wl-copy" ? 1 : 0));

		await copyToClipboard("hello");

		assert.deepEqual(spawnCommands(), ["wl-copy", "xclip -selection clipboard"]);
		assert.equal(spawnCalls()[0]!.options.detached, true);
		assert.equal(spawnCalls()[1]!.options.detached, true);
	});

	// pi#11592: clipboard tools ignore the cwd, and WSL cannot start Windows executables from a long one.
	test("runs clipboard writers from the filesystem root", async () => {
		mockedPlatform.mockReturnValue("linux");
		mocks.isWaylandSession.mockReturnValue(true);
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-1");
		vi.stubEnv("DISPLAY", ":0");
		mockSpawnExit((command) => (command === "wl-copy" ? 1 : 0));

		await copyToClipboard("hello");

		assert.equal(spawnCalls()[0]!.options.cwd, "/");
		assert.equal(spawnCalls()[1]!.options.cwd, "/");
	});

	test("keeps the Windows clip command in Atomic's process group", async () => {
		mockedPlatform.mockReturnValue("win32");
		mocks.clipboard.setText.mockRejectedValue(new Error("native failed"));

		await copyToClipboard("hello");

		assert.deepEqual(spawnCommands(), ["clip"]);
		assert.notEqual(spawnCalls()[0]!.options.detached, true);
	});

	test("rejects failed local wl-copy without emitting OSC 52", async () => {
		mockedPlatform.mockReturnValue("linux");
		mocks.isWaylandSession.mockReturnValue(true);
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-1");
		mockSpawnExit(1);

		await assert.rejects(copyToClipboard("hello"), {
			message: "Clipboard unavailable: install `wl-clipboard` (`wl-copy`) or check Wayland access",
		});
		assert.equal(osc52Writes().length, 0);
	});

	test("display-less Linux falls back to OSC 52", async () => {
		// Regression test for earendil-works/pi#9688: containers without X11/Wayland access.
		mockedPlatform.mockReturnValue("linux");

		await copyToClipboard("hello");

		assert.equal(mockedSpawn.mock.calls.length, 0);
		assert.equal(mockedExecFile.mock.calls.length, 0);
		assert.equal(osc52Writes().length, 1);
	});

	test("WSL without a display writes the Windows clipboard through PowerShell", async () => {
		// Regression test for earendil-works/pi#9688: WSL with WSLg disabled.
		mockedPlatform.mockReturnValue("linux");
		vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
		let written: string | undefined;
		mockedExecFile.mockImplementation(((
			file: string,
			args: string[],
			_options: object,
			callback: (error: Error | null, stdout: string) => void,
		) => {
			if (file !== "wslpath") {
				callback(null, "");
				return;
			}
			written = readFileSync(args[1]!, "utf8");
			callback(null, "\\\\wsl.localhost\\Ubuntu\\tmp\\clip.txt\n");
		}) as unknown as typeof execFile);

		await copyToClipboard("héllo");

		assert.deepEqual(execFileFiles(), ["wslpath", "powershell.exe"]);
		assert.equal(written, "héllo");
		const [, wslpathArgs] = mockedExecFile.mock.calls[0]!;
		assert.equal(existsSync((wslpathArgs as string[])[1]!), false);
		const [, powershellArgs] = mockedExecFile.mock.calls[1]!;
		assert.match((powershellArgs as string[])[2]!, /Set-Clipboard/);
		for (const call of mockedExecFile.mock.calls) assert.equal((call[2] as { cwd?: string }).cwd, "/");
		assert.ok((powershellArgs as string[])[2]!.includes("'\\\\wsl.localhost\\Ubuntu\\tmp\\clip.txt'"));
		assert.equal(osc52Writes().length, 0);
	});

	test("WSL clipboard write starts Windows PowerShell without the parent's PSModulePath", async () => {
		mockedPlatform.mockReturnValue("linux");
		vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
		vi.stubEnv("PSModulePath", "C:\\Program Files\\PowerShell\\7\\Modules");
		mockedExecFile.mockImplementation(((
			file: string,
			_args: string[],
			_options: object,
			callback: (error: Error | null, stdout: string) => void,
		) => {
			callback(null, file === "wslpath" ? "\\\\wsl.localhost\\Ubuntu\\tmp\\clip.txt\n" : "");
		}) as unknown as typeof execFile);

		await copyToClipboard("hello");

		assert.deepEqual(execFileFiles(), ["wslpath", "powershell.exe"]);
		const env = (mockedExecFile.mock.calls[1]![2] as { env: NodeJS.ProcessEnv }).env;
		assert.deepEqual(
			Object.keys(env).filter((key) => key.toLowerCase() === "psmodulepath"),
			[],
		);
		assert.equal(env.WSL_DISTRO_NAME, "Ubuntu");
	});

	test("WSL falls back to OSC 52 when Windows interop is unavailable", async () => {
		mockedPlatform.mockReturnValue("linux");
		vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
		mockedExecFile.mockImplementation(((
			_file: string,
			_args: string[],
			_options: object,
			callback: (error: Error | null, stdout: string) => void,
		) => {
			callback(new Error("wslpath: not found"), "");
		}) as unknown as typeof execFile);

		await copyToClipboard("hello");

		assert.deepEqual(execFileFiles(), ["wslpath"]);
		assert.equal(osc52Writes().length, 1);
	});

	test("WSL in Windows Terminal prefers OSC 52 over PowerShell", async () => {
		mockedPlatform.mockReturnValue("linux");
		vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
		vi.stubEnv("WT_SESSION", "session");

		await copyToClipboard("hello");

		assert.equal(mockedExecFile.mock.calls.length, 0);
		assert.equal(osc52Writes().length, 1);
	});

	test("WSL in Windows Terminal emits OSC 52 once in a remote session", async () => {
		mockedPlatform.mockReturnValue("linux");
		vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
		vi.stubEnv("WT_SESSION", "session");
		vi.stubEnv("SSH_CONNECTION", "client server");

		await copyToClipboard("hello");

		assert.equal(mockedExecFile.mock.calls.length, 0);
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

			assert.equal(mockedExecFile.mock.calls.length, 0);
			assert.equal(osc52Writes().length, 1);
		},
	);

	test("WSL in Windows Terminal uses PowerShell for oversized OSC 52 payloads", async () => {
		mockedPlatform.mockReturnValue("linux");
		vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
		vi.stubEnv("WT_SESSION", "session");
		mockedExecFile.mockImplementation(((
			file: string,
			_args: string[],
			_options: object,
			callback: (error: Error | null, stdout: string) => void,
		) => {
			callback(null, file === "wslpath" ? "C:\\clip.txt" : "");
		}) as unknown as typeof execFile);

		await copyToClipboard("x".repeat(80_000));

		assert.deepEqual(execFileFiles(), ["wslpath", "powershell.exe"]);
		assert.equal(osc52Writes().length, 0);
	});

	test("WSL with a display prefers the Linux clipboard tools", async () => {
		mockedPlatform.mockReturnValue("linux");
		vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
		mocks.isWaylandSession.mockReturnValue(true);
		mockSpawnExit(0);

		await copyToClipboard("hello");

		assert.deepEqual(
			spawnCalls().map(({ command, args }) => ({ command, args })),
			[{ command: "wl-copy", args: [] }],
		);
		assert.equal(mockedExecFile.mock.calls.length, 0);
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
		mockSpawnExit(0);

		await copyToClipboard("hello");

		assert.deepEqual(
			spawnCalls().map(({ command, args }) => ({ command, args })),
			[{ command: "wl-copy", args: [] }],
		);
		assert.equal(mockedExecFile.mock.calls.length, 0);
		assert.equal(osc52Writes().length, 1);
	});

	test("Termux on Android writes through termux-clipboard-set", async () => {
		mockedPlatform.mockReturnValue("android");
		vi.stubEnv("TERMUX_VERSION", "0.119");
		mocks.clipboard.setText.mockRejectedValue(new Error("native failed"));

		await copyToClipboard("hello");

		assert.deepEqual(spawnCommands(), ["termux-clipboard-set"]);
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
			mockSpawnExit(new Error("backend failed"));
			await assert.rejects(copyToClipboard("hello"), { message });
			assert.equal(osc52Writes().length, 0);
		},
	);
});
