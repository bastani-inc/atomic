import { test } from "bun:test";
import assert from "node:assert/strict";
import { InteractiveModeBase } from "../../packages/coding-agent/src/modes/interactive/interactive-mode-base.ts";
import "../../packages/coding-agent/src/modes/interactive/interactive-input-handling.ts";
import "../../packages/coding-agent/src/modes/interactive/interactive-process-lifecycle.ts";
import "../../packages/coding-agent/src/modes/interactive/interactive-bash-compact.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";

// handleBashCommand builds themed components; the theme is process-global.
initTheme("dark");

/**
 * Contract item 6 for the submit paths that never reach `runUserPromptTurn()`.
 *
 * `/atomic`, a deferred slash command, an extension command during compaction, a
 * streaming steer send, `!bash`, `/compact`, and Alt+Enter all clear the editor
 * and dispatch straight to the engine. Before this, a send the engine never
 * accepted discarded the text on every one of those branches.
 */

const SEND_FAILURE = "Agent process exited (code=null signal=SIGKILL). Stderr: ";

interface SubmitStub {
	editorText: string;
	errors: string[];
	history: string[];
	startupCookedInputRecovered: boolean;
	prompted: Array<{ text: string; streamingBehavior?: string }>;
	bashCommands: string[];
	compactions: number;
	submit(text: string): Promise<void>;
	followUp(): Promise<void>;
	mode: InteractiveModeBase;
}

function makeSubmitStub(options?: {
	failSend?: boolean;
	failWith?: string;
	isCompacting?: boolean;
	isStreaming?: boolean;
	deferredStartupPending?: boolean;
	isExtensionCommand?: boolean;
	editorMounted?: boolean;
}): SubmitStub {
	const state = {
		editorText: "",
		errors: [] as string[],
		history: [] as string[],
		startupCookedInputRecovered: false,
		prompted: [] as Array<{ text: string; streamingBehavior?: string }>,
		bashCommands: [] as string[],
		compactions: 0,
	};
	const fail = (): never => {
		throw new Error(options?.failWith ?? SEND_FAILURE);
	};
	const editor = {
		getText: () => state.editorText,
		getExpandedText: () => state.editorText,
		setText: (text: string) => { state.editorText = text; },
		addToHistory: (text: string) => { state.history.push(text); },
		onSubmit: undefined as ((text: string) => Promise<void> | void) | undefined,
	};
	const host = {
		firstSubmitRecorded: true,
		startupReplayActiveInput: undefined,
		startupReplayInputs: [],
		deferredStartupPending: options?.deferredStartupPending === true,
		isBashMode: false,
		defaultEditor: editor,
		editor,
		editorContainer: { children: options?.editorMounted === false ? [] : [editor] },
		ui: { setFocus: () => {}, requestRender: () => {} },
		get startupCookedInputRecovered(): boolean { return state.startupCookedInputRecovered; },
		set startupCookedInputRecovered(value: boolean) { state.startupCookedInputRecovered = value; },
		session: {
			isCompacting: options?.isCompacting === true,
			isStreaming: options?.isStreaming === true,
			isBashRunning: false,
			queuedMessagesPaused: false,
			prompt: async (text: string, promptOptions?: { streamingBehavior?: string }) => {
				if (options?.failSend) fail();
				state.prompted.push({ text, ...(promptOptions?.streamingBehavior ? { streamingBehavior: promptOptions.streamingBehavior } : {}) });
			},
		},
		isExtensionCommand: () => options?.isExtensionCommand === true,
		queueCompactionMessage: () => {},
		updatePendingMessagesDisplay: () => {},
		updateEditorBorderColor: () => {},
		flushPendingBashComponents: () => {},
		renderDeferredUserInput: () => {},
		ensureDeferredStartupComplete: async () => {},
		showError: (message: string) => { state.errors.push(message); },
		showWarning: () => {},
		advanceStartupInputReplay: () => {},
		handleBashCommand: async (command: string) => {
			if (options?.failSend) fail();
			state.bashCommands.push(command);
		},
		handleCompactCommand: async () => {
			if (options?.failSend) fail();
			state.compactions += 1;
		},
	};
	const mode = host as unknown as InteractiveModeBase;
	InteractiveModeBase.prototype.setupEditorSubmitHandler.call(mode);
	return Object.assign(state, {
		mode,
		submit: async (text: string) => {
			// The built-in editor clears itself before invoking onSubmit, so the
			// buffer is empty when a submit branch starts dispatching.
			state.editorText = "";
			await editor.onSubmit?.(text);
		},
		followUp: () => InteractiveModeBase.prototype.handleFollowUp.call(mode),
	}) as SubmitStub;
}

const DIRECT_BRANCHES: Array<{
	name: string;
	text: string;
	options?: Parameters<typeof makeSubmitStub>[0];
}> = [
	{ name: "/atomic", text: "/atomic do the thing" },
	{ name: "deferred slash command", text: "/some-extension-command", options: { deferredStartupPending: true } },
	{ name: "extension command during compaction", text: "/ext", options: { isCompacting: true, isExtensionCommand: true } },
	{ name: "streaming steer", text: "steer me", options: { isStreaming: true } },
	{ name: "bash", text: "!echo hi" },
	{ name: "/compact", text: "/compact" },
];

for (const branch of DIRECT_BRANCHES) {
	test(`${branch.name}: a send the engine never accepted returns the draft to the editor`, async () => {
		const stub = makeSubmitStub({ ...branch.options, failSend: true });
		await stub.submit(branch.text);
		assert.equal(stub.editorText, branch.text, `${branch.name} discarded the submission`);
		assert.deepEqual(stub.errors, [SEND_FAILURE]);
		assert.equal(stub.startupCookedInputRecovered, true, "a restored draft must not be replayed as startup input");
	});

	test(`${branch.name}: an accepted send still clears the editor`, async () => {
		const stub = makeSubmitStub(branch.options);
		await stub.submit(branch.text);
		assert.equal(stub.editorText, "", `${branch.name} left text behind after a successful send`);
		assert.deepEqual(stub.errors, []);
	});
}

test("a direct-branch failure that is not a send failure still propagates", async () => {
	const stub = makeSubmitStub({ failSend: true, failWith: "Model provider returned 500" });
	await assert.rejects(() => stub.submit("/atomic boom"), /Model provider returned 500/);
	assert.equal(stub.editorText, "", "an unrelated failure must not resurrect the submission");
	assert.deepEqual(stub.errors, []);
});

test("the restored direct-branch draft is the untrimmed callback text", async () => {
	const stub = makeSubmitStub({ failSend: true });
	await stub.submit("  /atomic spaced  ");
	assert.equal(stub.editorText, "  /atomic spaced  ", "the callback draft was trimmed again before restoring");
});

test("a direct-branch draft merges ahead of text typed while the send was pending", async () => {
	const stub = makeSubmitStub({ failSend: true });
	const editor = (stub.mode as unknown as { editor: { setText(text: string): void } }).editor;
	const session = (stub.mode as unknown as { session: { prompt(text: string): Promise<void> } }).session;
	const originalPrompt = session.prompt.bind(session);
	session.prompt = async (text: string) => {
		editor.setText("typed during the hang");
		return originalPrompt(text);
	};
	await stub.submit("/atomic slow");
	assert.equal(stub.editorText, "/atomic slow\n\ntyped during the hang");
});

test("Alt+Enter streaming follow-up returns the draft when the send fails", async () => {
	const stub = makeSubmitStub({ failSend: true, isStreaming: true });
	stub.editorText = "follow up while streaming";
	await stub.followUp();
	assert.equal(stub.editorText, "follow up while streaming");
	assert.deepEqual(stub.errors, [SEND_FAILURE]);
	assert.equal(stub.startupCookedInputRecovered, true);
});

test("Alt+Enter extension command during compaction returns the draft when the send fails", async () => {
	const stub = makeSubmitStub({ failSend: true, isCompacting: true, isExtensionCommand: true });
	stub.editorText = "/ext during compaction";
	await stub.followUp();
	assert.equal(stub.editorText, "/ext during compaction");
	assert.deepEqual(stub.errors, [SEND_FAILURE]);
});

test("Alt+Enter clears the editor when the send is accepted", async () => {
	const stub = makeSubmitStub({ isStreaming: true });
	stub.editorText = "accepted follow up";
	await stub.followUp();
	assert.equal(stub.editorText, "");
	assert.deepEqual(stub.prompted, [{ text: "accepted follow up", streamingBehavior: "followUp" }]);
});

/**
 * Bash and compaction used to swallow every failure. They must expose exactly
 * the sends the engine never accepted, so the submit handler can restore the
 * draft, while keeping their existing rendered/event-driven handling otherwise.
 */
function makeBashStub(options: {
	executeBash: (command: string, onChunk: (chunk: string) => void) => Promise<unknown>;
}): { mode: InteractiveModeBase; errors: string[] } {
	const errors: string[] = [];
	const component = {
		appendOutput: () => {},
		setComplete: () => {},
	};
	const host = {
		bashComponent: undefined as unknown,
		session: {
			isStreaming: false,
			extensionRunner: { emitUserBash: async () => undefined },
			executeBash: options.executeBash,
			recordBashResult: () => {},
		},
		sessionManager: { getCwd: () => "/tmp" },
		chatContainer: { addChild: () => {} },
		pendingMessagesContainer: { addChild: () => {} },
		pendingBashComponents: [] as unknown[],
		ui: { requestRender: () => {} },
		showError: (message: string) => { errors.push(message); },
	};
	// Replace the real component construction with a stub: this test is about the
	// failure policy, not about bash rendering.
	Object.defineProperty(host, "bashComponent", { value: component, writable: true });
	return { mode: host as unknown as InteractiveModeBase, errors };
}

test("bash rethrows a send the engine never accepted and renders every other failure", async () => {
	const rejected = makeBashStub({ executeBash: async () => { throw new Error(SEND_FAILURE); } });
	await assert.rejects(
		() => InteractiveModeBase.prototype.handleBashCommand.call(rejected.mode, "echo hi"),
		/Agent process exited/,
	);
	assert.deepEqual(rejected.errors, [], "an unaccepted send must not also render a bash error");

	const runtimeFailure = makeBashStub({ executeBash: async () => { throw new Error("spawn ENOENT"); } });
	await InteractiveModeBase.prototype.handleBashCommand.call(runtimeFailure.mode, "echo hi");
	assert.deepEqual(runtimeFailure.errors, ["Bash command failed: spawn ENOENT"]);
});

test("bash keeps a transport failure local once the command has produced output", async () => {
	const started = makeBashStub({
		executeBash: async (_command, onChunk) => {
			onChunk("partial output");
			throw new Error(SEND_FAILURE);
		},
	});
	await InteractiveModeBase.prototype.handleBashCommand.call(started.mode, "echo hi");
	assert.equal(started.errors.length, 1, "an acknowledged command must not resurrect the submission");
	assert.match(started.errors[0]!, /Bash command failed: Agent process exited/);
});

test("/compact rethrows a send the engine never accepted and ignores other failures", async () => {
	const makeCompactStub = (compact: () => Promise<void>) => ({
		session: { isCompacting: false, compact },
		sessionManager: { getEntries: () => [{ type: "message" }, { type: "message" }] },
		loadingAnimation: undefined,
		statusContainer: { clear: () => {} },
		showWarning: () => {},
	}) as unknown as InteractiveModeBase;

	await assert.rejects(
		() => InteractiveModeBase.prototype.handleCompactCommand.call(
			makeCompactStub(async () => { throw new Error(SEND_FAILURE); }),
		),
		/Agent process exited/,
	);
	// Ordinary compaction failures still surface through session events only.
	await InteractiveModeBase.prototype.handleCompactCommand.call(
		makeCompactStub(async () => { throw new Error("compaction model error"); }),
	);
});
