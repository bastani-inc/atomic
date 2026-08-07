import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";
import { createExtensionContext, type ExtensionContextSource } from "../src/core/extensions/runner-context.ts";
import { noOpUIContext } from "../src/core/extensions/runner-ui.ts";
import type { ExtensionContext, ExtensionUIContext, UserBlockChange } from "../src/core/extensions/types.ts";
import { getOpenUserBlocks, subscribeUserBlocks } from "../src/core/extensions/user-blocks.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { fakeModelRuntime } from "./model-runtime-test-utils.ts";

/**
 * Build a context over a supplied UI so the `get ui()` accessor — the single
 * place wrapping happens — is the thing under test.
 */
function contextOver(ui: ExtensionUIContext): ExtensionContext {
	const sessionManager = SessionManager.inMemory();
	const modelRegistry = new ModelRegistry(fakeModelRuntime());
	const source: ExtensionContextSource = {
		assertActive: () => {},
		getUIContext: () => ui,
		getMode: () => "tui",
		hasUI: () => true,
		getCwd: () => process.cwd(),
		getSessionManager: () => sessionManager,
		getModelRegistry: () => modelRegistry,
		getModel: () => undefined,
		getScopedModels: () => [],
		getThinkingLevel: () => undefined,
		getOrchestrationContext: () => undefined,
		getSubagentPolicy: () => undefined,
		isIdle: () => true,
		isProjectTrusted: () => true,
		getSignal: () => undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
	};
	return createExtensionContext(source);
}

/** A UI whose five blocking methods record their calls and return fixed values. */
function recordingUi(overrides: Partial<ExtensionUIContext>): {
	ui: ExtensionUIContext;
	calls: Array<{ method: string; args: unknown[]; openBlocksDuringCall: number }>;
} {
	const calls: Array<{ method: string; args: unknown[]; openBlocksDuringCall: number }> = [];
	const record = (method: string, args: unknown[]): void => {
		calls.push({ method, args, openBlocksDuringCall: getOpenUserBlocks().length });
	};
	const base: ExtensionUIContext = {
		...noOpUIContext,
		select: async (title, options, opts) => {
			record("select", [title, options, opts]);
			return options[0];
		},
		confirm: async (title, message, opts) => {
			record("confirm", [title, message, opts]);
			return true;
		},
		input: async (title, placeholder, opts) => {
			record("input", [title, placeholder, opts]);
			return "typed";
		},
		editor: async (title, prefill, opts) => {
			record("editor", [title, prefill, opts]);
			return "edited";
		},
		custom: async <T>() => {
			record("custom", []);
			return "custom-result" as T;
		},
	};
	return { ui: { ...base, ...overrides }, calls };
}

describe("ctx.ui block wrapping", () => {
	afterEach(() => {
		assert.deepEqual(getOpenUserBlocks(), [], "no block may outlive its dialog");
	});

	it("returns exactly what the host returned for each blocking dialog", async () => {
		const { ui } = recordingUi({});
		const ctx = contextOver(ui);

		assert.equal(await ctx.ui.select("Pick one", ["a", "b"]), "a");
		assert.equal(await ctx.ui.confirm("Sure?", "really"), true);
		assert.equal(await ctx.ui.input("Name?", "placeholder"), "typed");
		assert.equal(await ctx.ui.editor("Edit", "prefill"), "edited");
		assert.equal(await ctx.ui.custom(() => ({ render: () => [] })), "custom-result");
	});

	it("forwards every argument unchanged", async () => {
		const { ui, calls } = recordingUi({});
		const ctx = contextOver(ui);
		const signal = new AbortController().signal;

		await ctx.ui.select("Pick one", ["a", "b"], { signal });
		await ctx.ui.confirm("Sure?", "really", { signal });
		await ctx.ui.input("Name?", "hint", { signal });
		await ctx.ui.editor("Edit", "prefill", { signal });

		assert.deepEqual(calls[0], {
			method: "select",
			args: ["Pick one", ["a", "b"], { signal }],
			openBlocksDuringCall: 1,
		});
		assert.deepEqual(calls[1]?.args, ["Sure?", "really", { signal }]);
		assert.deepEqual(calls[2]?.args, ["Name?", "hint", { signal }]);
		assert.deepEqual(calls[3]?.args, ["Edit", "prefill", { signal }]);
	});

	it("holds a block open for the whole dialog and releases it after", async () => {
		let openDuringDialog = 0;
		const { ui } = recordingUi({
			select: async () => {
				await new Promise((resolve) => setTimeout(resolve, 5));
				openDuringDialog = getOpenUserBlocks().length;
				return "chosen";
			},
		});
		const ctx = contextOver(ui);

		const pending = ctx.ui.select("Approve edit?", ["yes", "no"]);
		assert.equal(getOpenUserBlocks().length, 1, "the block opens before the dialog is awaited");
		assert.equal(getOpenUserBlocks()[0]?.reason, "dialog");
		assert.equal(getOpenUserBlocks()[0]?.label, "Approve edit?");
		assert.equal(await pending, "chosen");
		assert.equal(openDuringDialog, 1);
		assert.equal(getOpenUserBlocks().length, 0);
	});

	it("preserves cancellation as an undefined result rather than an error", async () => {
		const { ui } = recordingUi({
			select: async () => undefined,
			input: async () => undefined,
			editor: async () => undefined,
			confirm: async () => false,
		});
		const ctx = contextOver(ui);

		assert.equal(await ctx.ui.select("Pick", ["a"]), undefined);
		assert.equal(await ctx.ui.input("Name"), undefined);
		assert.equal(await ctx.ui.editor("Edit"), undefined);
		assert.equal(await ctx.ui.confirm("Sure?", "really"), false);
	});

	it("propagates a rejection unchanged and still releases the block", async () => {
		const failure = new Error("aborted by host");
		const { ui } = recordingUi({ custom: async () => Promise.reject(failure) });
		const ctx = contextOver(ui);

		await assert.rejects(
			() => ctx.ui.custom(() => ({ render: () => [] })),
			(error: unknown) => {
				assert.equal(error, failure, "the very same error object reaches the caller");
				return true;
			},
		);
		assert.deepEqual(getOpenUserBlocks(), []);
	});

	it("propagates a synchronous throw unchanged and still releases the block", async () => {
		const failure = new Error("threw before returning a promise");
		const { ui } = recordingUi({});
		const throwing: ExtensionUIContext = {
			...ui,
			select: () => {
				throw failure;
			},
		};
		const ctx = contextOver(throwing);

		assert.throws(
			() => ctx.ui.select("Pick", ["a"]),
			(error: unknown) => error === failure,
		);
		assert.deepEqual(getOpenUserBlocks(), []);
	});

	it("fires agent_blocked and agent_unblocked around each dialog", async () => {
		const changes: UserBlockChange[] = [];
		const unsubscribe = subscribeUserBlocks((change) => changes.push(change));
		try {
			const { ui } = recordingUi({});
			const ctx = contextOver(ui);
			await ctx.ui.confirm("Delete everything?", "no undo");
		} finally {
			unsubscribe();
		}

		assert.deepEqual(
			changes.map((change) => [change.type, change.label, change.reason]),
			[
				["agent_blocked", "Delete everything?", "dialog"],
				["agent_unblocked", "Delete everything?", "dialog"],
			],
		);
	});

	it("labels a custom dialog without inventing caller text", async () => {
		const changes: UserBlockChange[] = [];
		const unsubscribe = subscribeUserBlocks((change) => changes.push(change));
		try {
			const { ui } = recordingUi({});
			const ctx = contextOver(ui);
			await ctx.ui.custom(() => ({ render: () => [] }));
		} finally {
			unsubscribe();
		}
		assert.equal(changes[0]?.label, "Custom dialog");
	});

	it("does not wrap non-blocking members", async () => {
		const notified: string[] = [];
		const { ui } = recordingUi({});
		const withNotify: ExtensionUIContext = { ...ui, notify: (message) => notified.push(message) };
		const ctx = contextOver(withNotify);

		ctx.ui.notify("hello");
		ctx.ui.requestRender();
		assert.deepEqual(notified, ["hello"]);
		assert.deepEqual(getOpenUserBlocks(), []);
		assert.equal(ctx.ui.getEditorText(), "");
	});

	it("keeps accessor and method identity stable", () => {
		const { ui } = recordingUi({});
		const ctx = contextOver(ui);
		assert.equal(ctx.ui, ctx.ui);
		assert.equal(ctx.ui.select, ctx.ui.select);
		assert.equal(ctx.ui.notify, ui.notify, "an unwrapped member is the host's own function");
	});

	it("keeps optional members absent when the host omits them", () => {
		const { ui } = recordingUi({});
		const ctx = contextOver(ui);
		assert.equal(ctx.ui.hostSessionPicker, undefined);
		assert.equal("hostSessionPicker" in ctx.ui, false);
	});

	it("stacks one block per nested dialog and clears them in order", async () => {
		const inner = recordingUi({});
		const outerUi = recordingUi({
			select: async () => {
				// A dialog opened from inside another dialog: both blocks are held.
				assert.equal(getOpenUserBlocks().length, 1);
				await contextOver(inner.ui).ui.confirm("Inner?", "nested");
				assert.equal(getOpenUserBlocks().length, 1, "the inner block released, the outer did not");
				return "outer";
			},
		});
		const ctx = contextOver(outerUi.ui);
		assert.equal(await ctx.ui.select("Outer?", ["outer"]), "outer");
		assert.deepEqual(getOpenUserBlocks(), []);
	});
});
