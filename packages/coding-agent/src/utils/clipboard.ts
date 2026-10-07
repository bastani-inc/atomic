import { execFile, execFileSync, execSync, spawn } from "child_process";
import { randomUUID } from "crypto";
import { unlinkSync, writeFileSync } from "fs";
import { platform, tmpdir } from "os";
import { join } from "path";
import { createChildProcessEnvironment } from "./child-process.ts";
import { isWaylandSession } from "./clipboard-image.ts";
import { type ClipboardModule, clipboard } from "./clipboard-native.ts";
import { isWSL } from "./wsl.ts";

type NativeClipboardExecOptions = {
	input: string;
	timeout: number;
	stdio: ["pipe", "ignore", "ignore"];
	env: NodeJS.ProcessEnv;
};

function copyToX11Clipboard(options: NativeClipboardExecOptions): void {
	try {
		execSync("xclip -selection clipboard", options);
	} catch {
		execSync("xsel --clipboard --input", options);
	}
}

const MAX_OSC52_ENCODED_LENGTH = 100_000;

function isRemoteSession(env: NodeJS.ProcessEnv): boolean {
	return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.MOSH_CONNECTION);
}

function emitOsc52(text: string): boolean {
	const encoded = Buffer.from(text).toString("base64");
	if (encoded.length > MAX_OSC52_ENCODED_LENGTH) {
		return false;
	}
	process.stdout.write(`\x1b]52;c;${encoded}\x07`);
	return true;
}

/**
 * WSL without WSLg has no Linux display, so the Windows clipboard is written through
 * interop. PowerShell reads the text from a file because `clip.exe` and PowerShell stdin
 * decode piped bytes with the console code page, which mangles non-ASCII UTF-8.
 */
function copyViaWindowsClipboard(text: string): boolean {
	const tmpFile = join(tmpdir(), `pi-wsl-clip-${randomUUID()}.txt`);
	const env = createChildProcessEnvironment();
	try {
		writeFileSync(tmpFile, text, { encoding: "utf8", mode: 0o600 });
		const winPath = execFileSync("wslpath", ["-w", tmpFile], {
			timeout: 1000,
			stdio: ["ignore", "pipe", "ignore"],
			env,
		})
			.toString("utf8")
			.trim();
		if (!winPath) return false;
		const script = `Set-Clipboard -Value ([System.IO.File]::ReadAllText('${winPath.replaceAll("'", "''")}', [System.Text.Encoding]::UTF8))`;
		execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
			timeout: 5000,
			stdio: ["ignore", "ignore", "ignore"],
			env,
		});
		return true;
	} catch {
		return false;
	} finally {
		try {
			unlinkSync(tmpFile);
		} catch {
			// The file may not have been created.
		}
	}
}

function readTermuxClipboardText(): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile("termux-clipboard-get", [], { timeout: 5000, env: createChildProcessEnvironment() }, (error, stdout) =>
			resolve(error ? undefined : stdout),
		);
	});
}

export async function readClipboardText(
	source: { getText(): Promise<string> } | null = clipboard,
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
	source: Pick<ClipboardModule, "availableFormats"> | null = clipboard,
	currentPlatform: NodeJS.Platform = process.platform,
): Promise<string[] | null> {
	if (currentPlatform !== "darwin" || !source?.availableFormats?.().includes(FILE_URL_PASTEBOARD_TYPE)) return null;
	const stdout = await new Promise<string>((resolve, reject) => {
		execFile(
			"osascript",
			["-l", "JavaScript", "-e", READ_FILE_URLS_SCRIPT],
			{ timeout: 5000, env: createChildProcessEnvironment() },
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
		if (clipboard && p !== "linux") {
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
	};

	if (!copied) {
		try {
			if (p === "darwin") {
				execSync("pbcopy", options);
				copied = true;
			} else if (p === "win32") {
				execSync("clip", options);
				copied = true;
			} else {
				// Linux. Try Termux, Wayland, or X11 clipboard tools.
				if (env.TERMUX_VERSION) {
					try {
						execSync("termux-clipboard-set", options);
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
							// Verify wl-copy exists (spawn errors are async and won't be caught)
							execSync("which wl-copy", { stdio: "ignore", env: createChildProcessEnvironment() });
							// wl-copy with execSync hangs due to fork behavior; use spawn instead.
							// Await its terminal event so failures can fall through to X11 or OSC 52.
							const exitCode = await new Promise<number>((resolve) => {
								const proc = spawn("wl-copy", [], {
									stdio: ["pipe", "ignore", "ignore"],
									env: createChildProcessEnvironment(),
								});
								let settled = false;
								const finish = (code: number) => {
									if (settled) return;
									settled = true;
									resolve(code);
								};
								proc.once("error", () => finish(1));
								proc.once("close", (code) => finish(code ?? 1));
								proc.stdin.on("error", () => {});
								proc.stdin.end(text);
							});
							if (exitCode === 0) copied = true;
							else if (hasX11Display) {
								copyToX11Clipboard(options);
								copied = true;
							}
						} catch {
							if (hasX11Display) {
								copyToX11Clipboard(options);
								copied = true;
							}
						}
					} else if (hasX11Display) {
						copyToX11Clipboard(options);
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
	if (!copied && !remote && p === "linux" && isWSL(env)) {
		// Windows Terminal supports OSC 52; prefer it over the slower PowerShell round trip.
		if (env.WT_SESSION) osc52Emitted = emitOsc52(text);
		copied = osc52Emitted || copyViaWindowsClipboard(text);
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
