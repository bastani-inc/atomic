import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { test } from "vitest";
import { InteractiveModeBase } from "../../packages/coding-agent/src/modes/interactive/interactive-mode-base.ts";
import {
	isEngineSendFailure,
	mergeRestoredDraft,
	restoreUnsentPromptDraft,
} from "../../packages/coding-agent/src/modes/interactive/interactive-prompt-restore.ts";
import { QueuedWriter } from "../../packages/coding-agent/src/modes/rpc/queued-writer.ts";
import "../../packages/coding-agent/src/modes/interactive/interactive-prompt-turn.ts";
import {
	asAcceptedRequestFailure,
	rpcTransportError,
} from "../../packages/coding-agent/src/modes/rpc/rpc-transport-error.ts";
import { sleep } from "../helpers/runtime.js";

/** A writable that hands its `_write` callback back so a test can fail it. */
class ControlledWritable extends Writable {
	private callbacks: Array<(error?: Error | null) => void> = [];
	constructor() {
		super();
		this.on("error", () => {});
	}
	_write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
		this.callbacks.push(callback);
	}
	failActive(error: Error): void {
		const callback = this.callbacks.shift();
		assert.ok(callback, "expected an in-flight write");
		callback(error);
	}
}

/**
 * Regression: a submission the engine never accepted used to be discarded from
 * the editor, leaving only `Error: Agent process stopped` and no way to recover
 * the typed text.
 */

interface PromptTurnStub {
	editorText: string;
	editorMounted: boolean;
	focused: unknown;
	renders: number;
	errors: string[];
	discarded: string[];
	queued: Array<{ text: string; draft: string }>;
	startupCookedInputRecovered: boolean;
}

function makeStub(options: {
	draft: string;
	prompt: (text: string) => Promise<void>;
	subscribe?: (listener: (event: { type: string }) => void) => () => void;
	editorMounted?: boolean;
	queued?: Array<{ text: string; draft: string }>;
}): { stub: PromptTurnStub; run: (text: string, draft?: string) => Promise<void> } {
	const editor = {
		getText: () => state.editorText,
		setText: (text: string) => {
			state.editorText = text;
		},
	};
	const state: PromptTurnStub = {
		editorText: "",
		editorMounted: options.editorMounted ?? true,
		focused: undefined,
		renders: 0,
		errors: [],
		discarded: [],
		queued: options.queued ?? [],
		startupCookedInputRecovered: false,
	};
	const host = {
		promptTurnWorkingLoaderActive: false,
		deferredStartupPending: false,
		deferredStartupPromise: undefined,
		editor,
		editorContainer: { children: state.editorMounted ? [editor] : [] },
		ui: {
			setFocus: (component: unknown) => {
				state.focused = component;
			},
			requestRender: () => {
				state.renders += 1;
			},
		},
		pendingUserInputs: state.queued,
		get startupCookedInputRecovered(): boolean {
			return state.startupCookedInputRecovered;
		},
		set startupCookedInputRecovered(value: boolean) {
			state.startupCookedInputRecovered = value;
		},
		session: {
			isStreaming: false,
			subscribe: options.subscribe ?? (() => () => {}),
			resumeQueuedMessages: async () => {},
			prompt: options.prompt,
			_tryExecuteBuiltinSlashCommand: async () => false,
			_tryExecuteExtensionCommand: async () => false,
		},
		showWorkingLoaderNow: () => {},
		stopWorkingLoader: () => {},
		ensureDeferredStartupComplete: async () => {},
		discardDeferredRenderedUserInput: (text: string) => {
			state.discarded.push(text);
		},
		showError: (message: string) => {
			state.errors.push(message);
		},
	};
	Object.defineProperty(state, "editorRef", { value: editor });
	return {
		stub: state,
		run: (text: string, draft?: string) =>
			InteractiveModeBase.prototype.runUserPromptTurn.call(host as unknown as InteractiveModeBase, {
				text,
				draft: draft ?? options.draft,
			}),
	};
}

test("isEngineSendFailure matches every transport-loss error the RPC client raises", () => {
	for (const message of [
		"Agent process stopped",
		"Agent process exited (code=null signal=SIGKILL). Stderr: ",
		"Agent process stdin is not writable",
		"Client not started",
		"Interactive engine emitted malformed JSONL",
	]) {
		assert.equal(isEngineSendFailure(rpcTransportError(message)), true, message);
	}
	assert.equal(isEngineSendFailure(rpcTransportError("write EPIPE")), true, "the marker decides, not the wording");
	assert.equal(isEngineSendFailure(new Error("Model provider returned 500")), false);
});

test("isEngineSendFailure ignores message text so an admitted turn cannot be restored", () => {
	// A provider, extension, or command failure is free to quote a transport
	// phrase. The engine may already have run the submission, so restoring the
	// draft here would hide the real error and invite a duplicate run.
	for (const impostor of [
		new Error("Model provider returned 500: Agent process stopped"),
		new Error("Agent process exited (code=null signal=SIGKILL). Stderr: "),
		new Error("Client not started"),
		"Agent process stopped",
		{ message: "Agent process stopped" },
	]) {
		assert.equal(isEngineSendFailure(impostor), false, String(impostor));
	}
	// Admission is the only discriminator between two identical messages.
	const unsent = rpcTransportError("Agent process stopped");
	assert.equal(isEngineSendFailure(unsent), true);
	assert.equal(isEngineSendFailure(asAcceptedRequestFailure(unsent)), false);
});

test("restoreUnsentPromptDraft leaves a started turn alone and never steals focus from a modal", () => {
	const calls = { text: undefined as string | undefined, focused: 0, renders: 0 };
	const target = {
		turnStarted: true,
		draft: "draft",
		getEditorText: () => "",
		setEditorText: (text: string) => {
			calls.text = text;
		},
		editorOwnsInput: () => true,
		focusEditor: () => {
			calls.focused += 1;
		},
		requestRender: () => {
			calls.renders += 1;
		},
	};
	assert.equal(restoreUnsentPromptDraft(rpcTransportError("Agent process stopped"), target), false);
	assert.equal(calls.text, undefined);

	const modal = { ...target, turnStarted: false, editorOwnsInput: () => false };
	assert.equal(restoreUnsentPromptDraft(rpcTransportError("Agent process stopped"), modal), true);
	assert.equal(calls.text, "draft");
	assert.equal(calls.focused, 0, "focus must stay with the modal that owns input");
	assert.equal(calls.renders, 1);
});

test("mergeRestoredDraft keeps temporal order and never trims either side", () => {
	assert.equal(mergeRestoredDraft("/freeze-test", ""), "/freeze-test");
	assert.equal(
		mergeRestoredDraft("/freeze-test", "world typed during the hang"),
		"/freeze-test\n\nworld typed during the hang",
	);
	// Whitespace-only current text is still text the user entered.
	assert.equal(mergeRestoredDraft("draft", "   "), "draft\n\n   ");
	assert.equal(mergeRestoredDraft("  draft  ", "\tlater\n"), "  draft  \n\n\tlater\n");
	assert.equal(mergeRestoredDraft("first\nsecond", "third\nfourth"), "first\nsecond\n\nthird\nfourth");
});

test("a send that the engine never accepted restores the exact typed draft without a duplicate error", async () => {
	for (const message of [
		"Agent process stopped",
		"Agent process exited (code=1 signal=null). Stderr: ",
		"Client not started",
	]) {
		const { stub, run } = makeStub({
			// Untrimmed: the prompt loop only sees the trimmed text, but the editor
			// gets back exactly what the submit callback handed over.
			draft: "  hello engine\n",
			prompt: async () => {
				throw rpcTransportError(message);
			},
		});
		await run("hello engine");
		assert.equal(stub.editorText, "  hello engine\n", `draft was not restored verbatim for ${message}`);
		assert.deepEqual(stub.discarded, ["hello engine"]);
		assert.deepEqual(stub.errors, [], "a restored draft must not also raise a red transport error");
		assert.ok(stub.renders > 0, "no render was requested after restoring the draft");
	}
});

/**
 * The real transport failure, end to end: a stream write callback fails with a
 * raw coded error, `QueuedWriter` rejects the frame, the prompt send rejects
 * with it, and the host must still recognize it as a send that never landed.
 *
 * `write EPIPE` matches none of the legacy message fragments, so before the
 * transport marker this exact path showed a red error and threw the text away.
 * Testing `isEngineSendFailure()` alone would not prove the writer applies it.
 */
test("a raw EPIPE from the writer restores the draft instead of reporting a red error", async () => {
	for (const raw of [
		Object.assign(new Error("write EPIPE"), { code: "EPIPE", errno: -32, syscall: "write" }),
		Object.assign(new Error("Cannot call write after a stream was destroyed"), { code: "ERR_STREAM_DESTROYED" }),
		Object.assign(new Error("write after end"), { code: "ERR_STREAM_WRITE_AFTER_END" }),
	]) {
		const stream = new ControlledWritable();
		const writer = new QueuedWriter(stream);
		const { stub, run } = makeStub({
			draft: "  /freeze-test\n",
			prompt: async () => {
				const sent = writer.write('{"type":"prompt","message":"/freeze-test"}\n');
				await sleep(0);
				stream.failActive(raw);
				// The user keeps typing while the doomed send is still pending.
				stub.editorText = "typed during the hang";
				await sent;
			},
		});
		await run("/freeze-test");
		assert.equal(
			stub.editorText,
			"  /freeze-test\n\n\ntyped during the hang",
			`draft was not restored for ${raw.message}`,
		);
		assert.deepEqual(stub.errors, [], `a red error accompanied the restored draft for ${raw.message}`);
		assert.equal(stub.startupCookedInputRecovered, true);
		assert.ok(stub.renders > 0);
	}
});

test("a raw writer failure after the agent turn started keeps the text in the transcript", async () => {
	const stream = new ControlledWritable();
	const writer = new QueuedWriter(stream);
	const { stub, run } = makeStub({
		draft: "  /freeze-test\n",
		subscribe: (listener) => {
			listener({ type: "agent_start" });
			return () => {};
		},
		prompt: async () => {
			const sent = writer.write('{"type":"prompt"}\n');
			await sleep(0);
			stream.failActive(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
			await sent;
		},
	});
	await run("/freeze-test");
	assert.equal(stub.editorText, "");
	assert.equal(stub.errors.length, 1, "a mid-turn transport failure is still reported");
});

test("a raw writer failure restores queued submissions in FIFO order too", async () => {
	const stream = new ControlledWritable();
	const writer = new QueuedWriter(stream);
	const queued = [
		{ text: "second", draft: "  second  " },
		{ text: "third", draft: "third\n" },
	];
	const { stub, run } = makeStub({
		draft: " first ",
		queued,
		prompt: async () => {
			const sent = writer.write('{"type":"prompt"}\n');
			await sleep(0);
			stream.failActive(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
			await sent;
		},
	});
	await run("first");
	assert.equal(stub.editorText, " first \n\n  second  \n\nthird\n");
	assert.deepEqual(queued, []);
});

/**
 * Two submissions whose drafts differ only in whitespace normalize to the same
 * delivered text. A shared "last submitted draft" slot could not tell them
 * apart, so a failure could restore the wrong buffer — or clear the slot before
 * the other turn used it. Each submission now carries its own draft.
 */
test("overlapping submissions that normalize identically keep their own exact drafts", async () => {
	let failFirst!: (error: Error) => void;
	let sends = 0;
	// One host, two Enters: exactly the case a shared slot cannot represent.
	const { stub, run } = makeStub({
		draft: " first ",
		prompt: () => {
			sends += 1;
			return sends === 1
				? new Promise<void>((_, reject) => {
						failFirst = reject;
					})
				: Promise.resolve();
		},
	});
	const firstTurn = run("first", " first ");
	await sleep(0);
	// A second Enter with a different raw buffer while the first is still pending.
	await run("first", "  first  ");
	assert.equal(stub.editorText, "", "a successful send leaves nothing behind");

	failFirst(rpcTransportError("Agent process stopped"));
	await firstTurn;
	assert.equal(stub.editorText, " first ", "the failed submission restored the other submission's draft");
});

/**
 * Queued submissions were never sent either. Restoring them with the active one
 * in FIFO order keeps their relative order; leaving them queued would let each
 * later failure prepend a newer draft above older restored text.
 */
test("still-queued submissions come back in order behind the failed one", async () => {
	const queued = [
		{ text: "second", draft: "  second  " },
		{ text: "third", draft: "third\n" },
	];
	const { stub, run } = makeStub({
		draft: " first ",
		queued,
		prompt: async () => {
			throw rpcTransportError("Agent process stopped");
		},
	});
	await run("first");
	assert.equal(stub.editorText, " first \n\n  second  \n\nthird\n");
	assert.deepEqual(queued, [], "restored submissions must not also be delivered later");
});

test("a failure that restores nothing leaves the queue untouched", async () => {
	const queued = [{ text: "second", draft: "second" }];
	const { stub, run } = makeStub({
		draft: "first",
		queued,
		prompt: async () => {
			throw new Error("Model provider returned 500");
		},
	});
	await run("first");
	assert.equal(stub.editorText, "");
	assert.deepEqual(queued, [{ text: "second", draft: "second" }]);
});

/**
 * Reproduced live by review: typing while the send was still pending used to be
 * wiped out, because restoration replaced the whole editor buffer.
 */
test("text typed while the send was pending survives alongside the restored draft", async () => {
	const typedDuringSend = "world typed during the hang";
	const { stub, run } = makeStub({
		draft: "/freeze-test",
		prompt: async function (this: void) {
			stub.editorText = typedDuringSend;
			throw rpcTransportError("Agent process exited (code=null signal=SIGKILL). Stderr: ");
		},
	});
	await run("/freeze-test");
	assert.equal(
		stub.editorText,
		`/freeze-test\n\n${typedDuringSend}`,
		"the failed submission must come back ahead of text entered while it was pending",
	);
});

test("whitespace-only text typed during the pending send is preserved", async () => {
	const { stub, run } = makeStub({
		draft: "hello",
		prompt: async () => {
			stub.editorText = "   ";
			throw rpcTransportError("Agent process stopped");
		},
	});
	await run("hello");
	assert.equal(stub.editorText, "hello\n\n   ");
});

test("multiline text typed during the pending send is preserved verbatim", async () => {
	const { stub, run } = makeStub({
		draft: "first\nsecond",
		prompt: async () => {
			stub.editorText = "third\nfourth";
			throw rpcTransportError("Agent process stopped");
		},
	});
	await run("first\nsecond");
	assert.equal(stub.editorText, "first\nsecond\n\nthird\nfourth");
});

/**
 * Reproduced live: restoring a command-like draft used to be re-read by
 * `recoverCookedStartupInput()` on the next `getUserInput()` and replayed as a
 * submission, which re-ran the very command whose send had just failed (a fresh
 * engine then re-mounted the stale custom UI).
 */
test("a restored draft is a draft, never cooked startup input", async () => {
	const { stub, run } = makeStub({
		draft: "/freeze-test",
		prompt: async () => {
			throw rpcTransportError("Agent process exited (code=null signal=SIGKILL). Stderr: ");
		},
	});
	await run("/freeze-test");
	assert.equal(stub.editorText, "/freeze-test");
	assert.equal(stub.startupCookedInputRecovered, true, "a restored command draft would be replayed as a submission");
});

test("a failure that does not restore anything leaves startup-input recovery alone", async () => {
	const { stub, run } = makeStub({
		draft: "/freeze-test",
		prompt: async () => {
			throw new Error("Model provider returned 500");
		},
	});
	await run("/freeze-test");
	assert.equal(stub.startupCookedInputRecovered, false);
});

test("a failure after the agent turn started keeps the text in the transcript", async () => {
	const { stub, run } = makeStub({
		draft: "run something",
		subscribe: (listener) => {
			listener({ type: "agent_start" });
			return () => {};
		},
		prompt: async () => {
			throw rpcTransportError("Agent process exited (code=null signal=SIGKILL). Stderr: ");
		},
	});
	await run("run something");
	assert.equal(stub.editorText, "", "a started turn must not resurrect the submission");
	assert.equal(stub.errors.length, 1);
});

test("an unrelated prompt failure is reported without touching the editor", async () => {
	const { stub, run } = makeStub({
		draft: "hello",
		prompt: async () => {
			throw new Error("Model provider returned 500");
		},
	});
	await run("hello");
	assert.equal(stub.editorText, "");
	assert.deepEqual(stub.errors, ["Model provider returned 500"]);
});

test("a successful send leaves the editor empty", async () => {
	const { stub, run } = makeStub({ draft: "hello", prompt: async () => {} });
	await run("hello");
	assert.equal(stub.editorText, "");
	assert.deepEqual(stub.errors, []);
});
