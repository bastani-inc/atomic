import { setImmediate } from "node:timers/promises";
import type { PtySession } from "@bastani/atomic-natives";
import { createModuleRequire } from "../../utils/module-require.js";
import { getPowerShellConfigAsync } from "../../utils/shell.ts";

interface SubshellOwner {
	ui: { stop(options?: { preserveScreen?: boolean }): void; start(): void; requestRender(force?: boolean): void };
	sessionManager: { getCwd(): string };
}

const activeSubshells = new WeakSet<object>();

export function isWindowsSubshellActive(owner: object): boolean {
	return activeSubshells.has(owner);
}

/** Lend the terminal to PowerShell without disposing the session or its tasks. */
export async function openWindowsSubshell(owner: SubshellOwner): Promise<void> {
	if (activeSubshells.has(owner)) return;
	activeSubshells.add(owner);
	// This guard only protects the UI from externally delivered SIGINT. The
	// engine and owned tasks must never receive subshell console control events.
	const ignoreSigint = () => {};
	process.on("SIGINT", ignoreSigint);
	let releaseInput = () => {};
	try {
		// Finish Alt+Z's libuv input dispatch before stopping the console read.
		// Changing its mode inside that callback can invalidate Windows handles.
		await setImmediate();
		// This is a temporary handoff, not final shutdown. Replaying the full
		// document into the cooked Windows console can invalidate its handles.
		owner.ui.stop({ preserveScreen: true });
		const { shell } = await getPowerShellConfigAsync();
		const { PtySession: NativePtySession } = createModuleRequire(import.meta.url)("@bastani/atomic-natives") as {
			PtySession: typeof PtySession;
		};
		const child = new NativePtySession();
		const input = process.stdin;
		const output = process.stdout;
		const wasRaw = input.isRaw ?? false;
		const onInput = (data: string | Buffer) => {
			try {
				child.write(data.toString());
			} catch {
				// Native exit can close input before its completion promise settles.
			}
		};
		const onResize = () => {
			try {
				child.resize(output.columns || 120, output.rows || 40);
			} catch {
				// Likewise, a final resize can race native exit.
			}
		};
		releaseInput = () => {
			input.off("data", onInput);
			output.off("resize", onResize);
			input.pause();
			input.setRawMode(wasRaw);
		};
		// Inherited cooked stdio broadcasts Ctrl+C to every attached process,
		// including the piped RPC engine. Keep the outer console raw and relay
		// bytes into a separate ConPTY; only that console generates shell signals.
		input.setRawMode(true);
		let initialOutput = "";
		let awaitingCursorQuery = true;
		const exited = child.start(
			{
				shell,
				shellArgs: ["-NoLogo", "-NoExit", "-Command"],
				command: "",
				cwd: owner.sessionManager.getCwd(),
				cols: output.columns || 120,
				rows: output.rows || 40,
			},
			(_error, chunk) => {
				// PtySession already answers ConPTY's initial cursor query. A second
				// reply from our outer terminal corrupts PowerShell's first input.
				if (awaitingCursorQuery) {
					initialOutput += chunk;
					if (initialOutput.length < 4 && "\x1b[6n".startsWith(initialOutput)) return;
					awaitingCursorQuery = false;
					chunk = initialOutput.replace(/^\x1b\[6n/, "");
				}
				if (chunk) output.write(chunk);
			},
		);
		input.on("data", onInput);
		output.on("resize", onResize);
		input.resume();
		await exited;
	} finally {
		releaseInput();
		process.off("SIGINT", ignoreSigint);
		activeSubshells.delete(owner);
		owner.ui.start();
		owner.ui.requestRender(true);
	}
}
