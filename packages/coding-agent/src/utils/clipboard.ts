import { execFile, spawn } from "child_process";
import { randomUUID } from "crypto";
import { unlink, writeFile } from "fs/promises";
import { platform, tmpdir } from "os";
import { join } from "path";
import { ENV_CLIPBOARD_OSC52, getEnvNames } from "../config.js";
import { createChildProcessEnvironment } from "./child-process.ts";
import { isWaylandSession } from "./clipboard-image.ts";
import { type ClipboardModule, getNativeClipboard } from "./clipboard-native.ts";
import { findHelperExecutableAsync, helperLaunchAsync, missingHelperOptions } from "./helper-command.ts";
import { windowsPowerShellEnvironment } from "./windows-powershell.ts";
import { isWSL } from "./wsl.ts";

type NativeClipboardExecOptions = {
	input: string;
	timeout: number;
	stdio: ["pipe", "ignore", "ignore"];
	env: NodeJS.ProcessEnv;
	detached: boolean;
	cwd: string;
};

/**
 * Clipboard tools ignore the working directory, and WSL cannot start Windows executables (powershell.exe)
 * when the cwd's \\wsl.localhost\... path exceeds MAX_PATH (pi#11592). Running them from / (the current
 * drive root on Windows) also keeps a daemonizing clipboard owner from pinning the cwd.
 */
const CLIPBOARD_CWD = "/";

async function runClipboardCommand(
	command: string,
	args: string[],
	options: NativeClipboardExecOptions,
): Promise<void> {
	const launch = await helperLaunchAsync(command, { env: options.env, cwd: options.cwd });
	return new Promise((resolve, reject) => {
		const proc = spawn(launch.file, args, {
			timeout: options.timeout,
			stdio: options.stdio,
			env: options.env,
			detached: options.detached,
			cwd: options.cwd,
			...missingHelperOptions(launch),
		});
		let settled = false;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			if (error) reject(error);
			else resolve();
		};
		proc.once("error", (error) => finish(error));
		proc.once("close", (code) => {
			if (code === 0) finish();
			else finish(new Error(`${command} exited with code ${code ?? 1}`));
		});
		proc.stdin.on("error", () => {});
		proc.stdin.end(options.input);
	});
}

async function copyToX11Clipboard(options: NativeClipboardExecOptions): Promise<void> {
	try {
		await runClipboardCommand("xclip", ["-selection", "clipboard"], options);
	} catch {
		await runClipboardCommand("xsel", ["--clipboard", "--input"], options);
	}
}

const MAX_OSC52_ENCODED_LENGTH = 100_000;

/**
 * Remote sessions also emit OSC 52 so the client terminal receives the copy. Rex terminals count as
 * remote: a Rex server spawns shells without SSH markers, and its client may be another machine.
 * ATOMIC_CLIPBOARD_OSC52=1 (or its PI_CLIPBOARD_OSC52 alias) covers remote clients that leave no
 * markers, such as multiplexer attaches or remote IDE daemons.
 */
function isRemoteSession(env: NodeJS.ProcessEnv): boolean {
	const forceOsc52 = getEnvNames(ENV_CLIPBOARD_OSC52)
		.map((name) => env[name])
		.find((value) => value !== undefined);
	return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.MOSH_CONNECTION || env.REX_SESSION || forceOsc52 === "1");
}

function emitOsc52(text: string): boolean {
	const encoded = Buffer.from(text).toString("base64");
	if (encoded.length > MAX_OSC52_ENCODED_LENGTH) {
		return false;
	}
	process.stdout.write(`\x1b]52;c;${encoded}\x07`);
	return true;
}

async function runClipboardExecFile(
	file: string,
	args: string[],
	options: { timeout: number; env: NodeJS.ProcessEnv; cwd: string },
): Promise<string> {
	const launch = await helperLaunchAsync(file, { env: options.env, cwd: options.cwd });
	return new Promise((resolve, reject) => {
		execFile(launch.file, args, { ...options, ...missingHelperOptions(launch) }, (error, stdout) => {
			if (error) reject(error);
			else resolve(typeof stdout === "string" ? stdout : Buffer.from(stdout ?? "").toString("utf8"));
		});
	});
}

/**
 * WSL without WSLg has no Linux display, so the Windows clipboard is written through
 * interop. PowerShell reads the text from a file because `clip.exe` and PowerShell stdin
 * decode piped bytes with the console code page, which mangles non-ASCII UTF-8.
 */
async function copyViaWindowsClipboard(text: string): Promise<boolean> {
	const tmpFile = join(tmpdir(), `pi-wsl-clip-${randomUUID()}.txt`);
	const env = createChildProcessEnvironment();
	try {
		await writeFile(tmpFile, text, { encoding: "utf8", mode: 0o600 });
		const winPath = (
			await runClipboardExecFile("wslpath", ["-w", tmpFile], {
				timeout: 1000,
				env,
				cwd: CLIPBOARD_CWD,
			})
		).trim();
		if (!winPath) return false;
		const script = `Set-Clipboard -Value ([System.IO.File]::ReadAllText('${winPath.replaceAll("'", "''")}', [System.Text.Encoding]::UTF8))`;
		await runClipboardExecFile("powershell.exe", ["-NoProfile", "-Command", script], {
			timeout: 5000,
			env: windowsPowerShellEnvironment(env),
			cwd: CLIPBOARD_CWD,
		});
		return true;
	} catch {
		return false;
	} finally {
		try {
			await unlink(tmpFile);
		} catch {
			// The file may not have been created.
		}
	}
}

async function readTermuxClipboardText(): Promise<string | undefined> {
	const env = createChildProcessEnvironment();
	const file = await findHelperExecutableAsync("termux-clipboard-get", { env });
	if (file === undefined) return undefined;
	return new Promise((resolve) => {
		execFile(file, [], { timeout: 5000, env }, (error, stdout) => resolve(error ? undefined : stdout));
	});
}

export async function readClipboardText(
	source: { getText(): Promise<string> } | null = getNativeClipboard(),
): Promise<string | null> {
	if (process.env.TERMUX_VERSION) {
		const text = await readTermuxClipboardText();
		if (text !== undefined) return text || null;
	}
	try {
		if (!source) return null;
		return await source.getText();
	} catch {
		return null;
	}
}

/** Pasteboard type that Finder and other macOS apps publish for copied files. */
const FILE_URL_PASTEBOARD_TYPE = "public.file-url";

/** Prints the POSIX paths of the file URLs on the general pasteboard as a JSON array. */
const READ_FILE_URLS_SCRIPT = `ObjC.import("AppKit");
const urls = $.NSPasteboard.generalPasteboard.readObjectsForClassesOptions(
	$.NSArray.arrayWithObject($.NSURL),
	$.NSDictionary.dictionaryWithObjectForKey($.NSNumber.numberWithBool(true), $.NSPasteboardURLReadingFileURLsOnlyKey)
);
const paths = [];
for (let i = 0; i < urls.count; i++) paths.push(ObjC.unwrap(urls.objectAtIndex(i).path));
JSON.stringify(paths);`;

/**
 * Read file paths, such as Finder file copies, from the macOS clipboard. The native clipboard
 * module reports whether file URLs are present; AppKit is read through JavaScript for Automation
 * only then, because the module cannot read file URLs itself.
 */
export async function readClipboardFilePaths(
	source: Pick<ClipboardModule, "availableFormats"> | null = getNativeClipboard(),
	currentPlatform: NodeJS.Platform = process.platform,
): Promise<string[] | null> {
	if (currentPlatform !== "darwin" || !source?.availableFormats?.().includes(FILE_URL_PASTEBOARD_TYPE)) return null;
	const env = createChildProcessEnvironment();
	const launch = await helperLaunchAsync("osascript", { env });
	const stdout = await new Promise<string>((resolve, reject) => {
		execFile(
			launch.file,
			["-l", "JavaScript", "-e", READ_FILE_URLS_SCRIPT],
			{ timeout: 5000, env, ...missingHelperOptions(launch) },
			(error, output, stderr) => {
				if (error) {
					// The default error message repeats the whole script; report what osascript printed instead.
					const detail = stderr.trim();
					reject(new Error(`osascript could not read the copied files${detail ? `: ${detail}` : ""}`));
				} else resolve(output);
			},
		);
	});
	const paths = JSON.parse(stdout) as string[] | null;
	if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string")) {
		throw new Error("Unexpected clipboard file path output");
	}
	return paths.length > 0 ? paths : null;
}

export async function copyToClipboard(text: string): Promise<void> {
	let copied = false;

	const p = platform();
	const env = process.env;
	// Prefer direct clipboard writes. Emitting OSC 52 first can make terminals
	// write the same native clipboard concurrently with the addon, and very large
	// OSC 52 payloads can desynchronize terminal rendering.
	//
	// On Linux, skip the native addon. The underlying `clipboard-rs` crate is
	// X11-only and does not retain selection ownership after `set_text`
	// resolves, so on Wayland-only compositors (Hyprland, Niri, ...) and even
	// some X11 sessions the call resolves successfully without populating the
	// clipboard. The platform tools below (wl-copy, xclip, xsel) properly
	// daemonize and keep ownership.
	try {
		const clipboard = p === "linux" ? null : getNativeClipboard();
		if (clipboard) {
			await clipboard.setText(text);
			copied = true;
		}
	} catch {
		// Fall through to platform-specific clipboard tools.
	}

	const remote = isRemoteSession(env);
	if (copied && !remote) {
		return;
	}

	const options: NativeClipboardExecOptions = {
		input: text,
		timeout: 5000,
		stdio: ["pipe", "ignore", "ignore"],
		env: createChildProcessEnvironment(),
		// Clipboard writers can daemonize. Detach on POSIX so the daemon leaves Atomic's process group
		// and Ctrl+Z suspend (SIGTSTP to the group) does not stop the clipboard owner (earendil-works/pi#11179).
		detached: p !== "win32",
		cwd: CLIPBOARD_CWD,
	};

	if (!copied) {
		try {
			if (p === "darwin") {
				await runClipboardCommand("pbcopy", [], options);
				copied = true;
			} else if (p === "win32") {
				await runClipboardCommand("clip", [], options);
				copied = true;
			} else {
				// Linux. Try Termux, Wayland, or X11 clipboard tools.
				if (env.TERMUX_VERSION) {
					try {
						await runClipboardCommand("termux-clipboard-set", [], options);
						copied = true;
					} catch {
						// Fall back to Wayland or X11 tools.
					}
				}

				if (!copied) {
					const hasWaylandDisplay = Boolean(env.WAYLAND_DISPLAY);
					const hasX11Display = Boolean(env.DISPLAY);
					const isWayland = isWaylandSession();
					if (isWayland && hasWaylandDisplay) {
						try {
							await runClipboardCommand("wl-copy", [], options);
							copied = true;
						} catch {
							if (hasX11Display) {
								await copyToX11Clipboard(options);
								copied = true;
							}
						}
					} else if (hasX11Display) {
						await copyToX11Clipboard(options);
						copied = true;
					}
				}
			}
		} catch {
			// Fall through to OSC 52 fallback.
		}
	}

	let osc52Emitted = false;
	// A remote session skips the Windows clipboard: the copied text belongs on the connected
	// client, which the OSC 52 fallback below reaches, not on the remote host.
	if (!copied && !remote && p === "linux" && (await isWSL(env))) {
		// Windows Terminal supports OSC 52; prefer it over the slower PowerShell round trip.
		if (env.WT_SESSION) osc52Emitted = emitOsc52(text);
		copied = osc52Emitted || (await copyViaWindowsClipboard(text));
	}
	// OSC 52 cannot be verified, so a desktop session with a display reports the failure
	// instead. Without a display the terminal is the only clipboard route (containers,
	// WSL without WSLg). A remote session emits it even after a successful local write:
	// that write reached the remote host's display clipboard, while the user is at the
	// client, which only the terminal can reach. The Windows interop fallback above is
	// different because it is a last resort that a remote session gains nothing from.
	const headless = p === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY && !env.TERMUX_VERSION;
	let oversized = false;
	if (!osc52Emitted && (remote || (!copied && headless))) {
		if (emitOsc52(text)) copied = true;
		else oversized = true;
	}
	if (copied) return;
	if (oversized) throw new Error("Clipboard unavailable: text exceeds the OSC 52 size limit");
	if (env.TERMUX_VERSION) {
		throw new Error("Clipboard unavailable: install the Termux:API app and `termux-api` package");
	}
	if (p === "linux") {
		if (env.WAYLAND_DISPLAY) {
			throw new Error("Clipboard unavailable: install `wl-clipboard` (`wl-copy`) or check Wayland access");
		}
		if (env.DISPLAY) {
			throw new Error("Clipboard unavailable: install `xclip` or `xsel`, or check X11 access");
		}
	}
	throw new Error("Clipboard unavailable");
}
