/**
 * Interactive host process for the issue #2074 end-to-end scenario.
 *
 * The behaviour under test is drawn: a queued-message row in a stage chat and a
 * queued-count badge on a graph node. It therefore has to be driven the way a
 * user drives it — keystrokes into the interactive TUI — and read back as
 * rendered text.
 *
 * So this file runs the shipped `main()` from `packages/coding-agent/src/main.ts`
 * (the whole of what `cli.ts` does after argument parsing) through the
 * `internalInteractiveHarness` hook the CLI already exposes, substituting only
 * the `Terminal`, because vitest has no TTY to allocate. Everything else is the
 * real thing: the same isolated engine child, the same builtin extension
 * packages, the same workflows overlay, the same stage-chat host.
 * `scripts/e2e/issue-2074-evidence.sh` drives `cli.ts` itself inside a real
 * terminal and reaches the same screens.
 *
 * Protocol: newline-delimited JSON on stdin (`{"type":"input","data":"..."}`,
 * `{"type":"state"}`), `@@ISSUE_2074@@`-prefixed JSON on stdout. Only `state`
 * carries the accumulated terminal writes, so driving the scenario does not
 * bury the pipe under one copy of the screen per animation frame.
 */

import type { Terminal } from "@earendil-works/pi-tui";
import { main } from "../../../packages/coding-agent/src/main.ts";
import type { InteractiveMode } from "../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts";
import { hasInteractiveEngineBootstrapArg } from "../../../packages/coding-agent/src/utils/interactive-engine-bootstrap.ts";

export const ISSUE_2074_HOST_PREFIX = "@@ISSUE_2074@@";

/** Everything the driver can be told. */
interface HostReport {
	readonly type: "ready" | "state";
	readonly output?: string;
	readonly editorText?: string;
}

function report(value: HostReport): void {
	process.stdout.write(`${ISSUE_2074_HOST_PREFIX}${JSON.stringify(value)}\n`);
}

/**
 * Collects what the TUI wrote and replays injected keystrokes into it.
 *
 * The width is the one the scenario's assertions assume: the workflow node card
 * centres its badge inside the card, and a narrower terminal would truncate the
 * rendered rows this suite matches on.
 */
class RecordingTerminal implements Terminal {
	columns = 120;
	rows = 40;
	kittyProtocolActive = false;
	private onInput: ((data: string) => void) | undefined;
	private written = "";

	start(onInput: (data: string) => void): void {
		this.onInput = onInput;
	}
	stop(): void {
		this.onInput = undefined;
	}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.written += data;
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	inject(data: string): void {
		this.onInput?.(data);
	}
	get output(): string {
		return this.written;
	}
}

async function runHost(): Promise<void> {
	const terminal = new RecordingTerminal();
	let mode: InteractiveMode | undefined;
	let buffer = "";
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk: string) => {
		buffer += chunk;
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline === -1) break;
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (line.trim() === "") continue;
			const command = JSON.parse(line) as { type?: string; data?: string };
			if (command.type === "input" && typeof command.data === "string") terminal.inject(command.data);
			else if (command.type === "state") {
				report({ type: "state", output: terminal.output, editorText: mode?.editor.getText() });
			}
		}
	});
	await main(process.argv.slice(2), {
		internalInteractiveHarness: {
			forceInteractive: true,
			terminal,
			onMode: (created) => {
				mode = created;
				const getUserInput = created.getUserInput.bind(created);
				created.getUserInput = () => {
					const input = getUserInput();
					report({ type: "ready" });
					return input;
				};
			},
		},
	});
}

// The engine child is identified by its private bootstrap argument; it is the
// real RPC-mode CLI and must not be wrapped in the recording host.
if (hasInteractiveEngineBootstrapArg(process.argv.slice(2))) await main(process.argv.slice(2));
else await runHost();
