import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Terminal, TUI } from "@bastani/atomic-tui";
import { test, vi } from "vitest";
import {
	createRpcExtensionUIContext,
	type RpcPendingExtensionRequests,
} from "../../packages/coding-agent/src/modes/rpc/rpc-extension-ui.ts";
import type { RpcExtensionUIResponse } from "../../packages/coding-agent/src/modes/rpc/rpc-types.ts";
import type { ProgramStatus } from "../../packages/tui/src/program-status.ts";

interface SentFrame {
	type?: string;
	id?: string;
	value?: string;
	confirmed?: boolean;
	cancelled?: boolean;
	message?: string;
}

interface FakeTerminalHandle extends Terminal {
	sendInput(data: string): void;
}

const harnessState = vi.hoisted(() => ({
	stdout: null as EventEmitter | null,
	terminal: null as FakeTerminalHandle | null,
	tui: null as TUI | null,
	sentFrames: [] as SentFrame[],
	pendingRequests: new Map() as RpcPendingExtensionRequests,
	onReady: null as (() => void) | null,
}));

vi.mock("node:child_process", () => ({
	spawn: () => {
		const stdout = new EventEmitter();
		const stderr = new EventEmitter();
		harnessState.stdout = stdout;
		return {
			stdin: {
				write(chunk: string): boolean {
					for (const line of chunk.split(/\r?\n/)) {
						if (!line.trim()) continue;
						const parsed = JSON.parse(line) as SentFrame;
						harnessState.sentFrames.push(parsed);
						if (parsed.type === "extension_ui_response" && typeof parsed.id === "string") {
							const pending = harnessState.pendingRequests.get(parsed.id);
							if (pending) {
								pending.resolve(parsed as RpcExtensionUIResponse);
							}
						}
					}
					return true;
				},
			},
			stdout,
			stderr,
			exitCode: null,
			kill: () => true,
			on: () => {},
		};
	},
}));

vi.mock("@bastani/atomic-tui", async (importOriginal) => {
	const original = await importOriginal<typeof import("@bastani/atomic-tui")>();
	class CapturingTUI extends original.TuiMainScreen {
		constructor(terminal: Terminal) {
			super(terminal);
			harnessState.tui = this;
		}
	}
	class CapturingTerminal implements FakeTerminalHandle {
		private inputHandler?: (data: string) => void;
		columns = 80;
		rows = 24;
		kittyProtocolActive = false;

		constructor() {
			harnessState.terminal = this;
		}

		start(onInput: (data: string) => void, _onResize: () => void): void {
			this.inputHandler = onInput;
			harnessState.onReady?.();
		}

		stop(): void {
			this.inputHandler = undefined;
		}

		async drainInput(): Promise<void> {}
		write(_data: string): void {}
		moveBy(_lines: number): void {}
		hideCursor(): void {}
		showCursor(): void {}
		clearLine(): void {}
		clearFromCursor(): void {}
		clearScreen(): void {}
		setTitle(_title: string): void {}
		setProgress(_active: boolean): void {}
		setProgramStatus(_status: ProgramStatus): void {}

		sendInput(data: string): void {
			this.inputHandler?.(data);
		}
	}
	return {
		...original,
		ProcessTerminal: CapturingTerminal,
		TuiMainScreen: CapturingTUI,
	};
});

function emitAgentFrame(frame: object): void {
	harnessState.stdout?.emit("data", Buffer.from(`${JSON.stringify(frame)}\n`, "utf8"));
}

function typeText(text: string): void {
	for (const ch of text) {
		harnessState.terminal?.sendInput(ch);
	}
}

function renderScreen(): string {
	assert.ok(harnessState.tui);
	return harnessState.tui.render(80).join("\n");
}

test("RPC extension UI reference client closes only the matching dialog on cancel and restores the prompt without replying (#5241)", async () => {
	const ready = new Promise<void>((resolve) => {
		harnessState.onReady = resolve;
	});
	try {
		await import("../../packages/coding-agent/examples/rpc-extension-ui.ts");
		await ready;

		const rpcUi = createRpcExtensionUIContext({
			output: (event) => {
				emitAgentFrame(event);
			},
			pendingExtensionRequests: harnessState.pendingRequests,
		});

		const abortSelect = new AbortController();
		const selectPromise = rpcUi.select("Allow dangerous command?", ["Allow", "Block"], {
			signal: abortSelect.signal,
		});
		assert.match(renderScreen(), /Allow dangerous command\?/);
		abortSelect.abort();
		assert.equal(await selectPromise, undefined);
		const emptyFrames: SentFrame[] = [];
		assert.doesNotMatch(renderScreen(), /Allow dangerous command\?/);
		assert.match(renderScreen(), /You:/);
		assert.deepEqual(harnessState.sentFrames, emptyFrames);

		const abortConfirm = new AbortController();
		const confirmPromise = rpcUi.confirm("Clear session?", "All messages will be lost.", {
			signal: abortConfirm.signal,
		});
		assert.match(renderScreen(), /Clear session\?: All messages will be lost\./);
		abortConfirm.abort();
		assert.equal(await confirmPromise, false);
		assert.doesNotMatch(renderScreen(), /Clear session\?/);
		assert.match(renderScreen(), /You:/);

		const abortInput = new AbortController();
		const abortedInputPromise = rpcUi.input("Provide token", "secret", {
			signal: abortInput.signal,
		});
		assert.match(renderScreen(), /Provide token \(secret\)/);
		abortInput.abort();
		assert.equal(await abortedInputPromise, undefined);
		assert.doesNotMatch(renderScreen(), /Provide token/);
		assert.match(renderScreen(), /You:/);

		const abortEditor = new AbortController();
		const editorPromise = rpcUi.editor("Edit note", "Line 1\nLine 2", {
			signal: abortEditor.signal,
		});
		assert.match(renderScreen(), /Edit note/);
		abortEditor.abort();
		assert.equal(await editorPromise, undefined);
		assert.doesNotMatch(renderScreen(), /Edit note/);
		assert.match(renderScreen(), /You:/);
		assert.deepEqual(harnessState.sentFrames, emptyFrames);

		typeText("hello");
		emitAgentFrame({
			type: "extension_ui_request",
			id: "already-closed-id",
			method: "cancel",
		});
		harnessState.terminal?.sendInput("\r");

		const promptFrames: SentFrame[] = [{ type: "prompt", message: "hello" }];
		assert.deepEqual(harnessState.sentFrames, promptFrames);
		harnessState.sentFrames.length = 0;

		emitAgentFrame({
			type: "extension_ui_request",
			id: "dialog-first",
			method: "select",
			title: "First dialog",
			options: ["One", "Two"],
		});
		assert.match(renderScreen(), /First dialog/);

		const inputPromise = rpcUi.input("Enter a value", "type something...");
		assert.match(renderScreen(), /Enter a value \(type something\.\.\.\)/);

		emitAgentFrame({
			type: "extension_ui_request",
			id: "dialog-first",
			method: "cancel",
		});
		assert.match(renderScreen(), /Enter a value \(type something\.\.\.\)/);
		assert.deepEqual(harnessState.sentFrames, emptyFrames);

		typeText("kept-value");
		harnessState.terminal?.sendInput("\r");

		assert.equal(await inputPromise, "kept-value");
		assert.equal(harnessState.sentFrames.length, 1);
		const reply = harnessState.sentFrames[0];
		assert.equal(reply?.type, "extension_ui_response");
		assert.equal(reply?.value, "kept-value");
		assert.match(renderScreen(), /You:/);
		harnessState.sentFrames.length = 0;

		typeText("/select");
		harnessState.terminal?.sendInput("\r");
		assert.match(renderScreen(), /Pick a color/);

		emitAgentFrame({
			type: "extension_ui_request",
			id: "stale-dialog-id",
			method: "cancel",
		});
		assert.match(renderScreen(), /Pick a color/);

		harnessState.terminal?.sendInput("\r");
		assert.match(renderScreen(), /You picked: Red/);
		assert.deepEqual(harnessState.sentFrames, emptyFrames);
	} finally {
		harnessState.tui?.stop();
		harnessState.pendingRequests.clear();
	}
});
