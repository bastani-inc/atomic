import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { afterEach, describe, it } from "vitest";
import { createExtensionContext, type ExtensionContextSource } from "../src/core/extensions/runner-context.ts";
import { noOpUIContext } from "../src/core/extensions/runner-ui.ts";
import type { ExtensionContext, ExtensionUIContext, UserBlockChange } from "../src/core/extensions/types.ts";
import { getOpenUserBlocks, subscribeUserBlocks } from "../src/core/extensions/user-blocks.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { captureRejection, captureThrow } from "./error-capture.ts";
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

/**
 * The argument shapes the five blocking dialogs actually receive: a title, an
 * option list, a placeholder or prefill, or a dialog-options bag.
 */
type RecordedUiArgument = string | string[] | ExtensionUIDialogOptions | undefined;

interface RecordedUiCall {
	method: string;
	args: RecordedUiArgument[];
	openBlocksDuringCall: number;
}

/** A UI whose five blocking methods record their calls and return fixed values. */
function recordingUi(overrides: Partial<ExtensionUIContext>): {
	ui: ExtensionUIContext;
	calls: RecordedUiCall[];
} {
	const calls: RecordedUiCall[] = [];
	const record = (method: string, args: RecordedUiArgument[]): void => {
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

		const thrown = await captureRejection(async () => {
			await ctx.ui.custom(() => ({ render: () => [] }));
		});
		assert.equal(thrown, failure, "the very same error object reaches the caller");
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

		assert.equal(
			captureThrow(() => {
				ctx.ui.select("Pick", ["a"]);
			}),
			failure,
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

	it("uses an empty dialog title verbatim instead of the method name", async () => {
		// Nothing requires a non-empty label — Herdr's own schema types `message`
		// as a nullable string — so substituting "select" would invent text the
		// caller never wrote.
		const changes: UserBlockChange[] = [];
		const unsubscribe = subscribeUserBlocks((change) => changes.push(change));
		try {
			const { ui } = recordingUi({});
			const ctx = contextOver(ui);
			await ctx.ui.select("", ["a"]);
			await ctx.ui.input("");
			await ctx.ui.editor("");
			await ctx.ui.confirm("", "body");
		} finally {
			unsubscribe();
		}
		assert.deepEqual(
			changes.filter((change) => change.type === "agent_blocked").map((change) => change.label),
			["", "", "", ""],
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

	it("calls host methods with the host object as receiver, not the wrapper", async () => {
		// A host that keys per-instance state off its own identity — a WeakMap here,
		// a private field in a class — must see exactly the receiver it saw before
		// wrapping existed. Reading through the proxy receiver silently broke this.
		const hostState = new WeakMap<object, string>();
		const base = recordingUi({}).ui;
		const host: ExtensionUIContext = {
			...base,
			select(this: ExtensionUIContext) {
				return Promise.resolve(hostState.get(this));
			},
		};
		hostState.set(host, "host-owned-value");

		assert.equal(await host.select("Pick", ["a"]), "host-owned-value");
		const ctx = contextOver(host);
		assert.equal(
			await ctx.ui.select("Pick", ["a"]),
			"host-owned-value",
			"wrapping must not change which object the host method runs on",
		);
	});

	it("resolves host getters against the host object", async () => {
		const base = recordingUi({}).ui;
		const secret = "host-theme-token";
		const host: ExtensionUIContext = Object.defineProperties(
			{ ...base },
			{
				getEditorText: {
					value(this: { marker?: string }) {
						return this.marker ?? "wrong-receiver";
					},
					enumerable: true,
					configurable: true,
				},
				marker: { value: secret, enumerable: false, configurable: true },
			},
		) as ExtensionUIContext;

		const ctx = contextOver(host);
		assert.equal(ctx.ui.getEditorText(), secret);
	});

	it("keeps accessor and member lookup stable", () => {
		const { ui } = recordingUi({});
		const ctx = contextOver(ui);
		assert.equal(ctx.ui, ctx.ui);
		assert.equal(ctx.ui.select, ctx.ui.select);
		// Non-blocking members are forwarders too, so they are not the host's own
		// function — a forwarder cannot be the function it forwards to. What has
		// to hold is that repeated lookup is stable, which is what callers that
		// store or compare a member actually depend on.
		assert.equal(ctx.ui.notify, ctx.ui.notify);
		assert.equal(ctx.ui.setStatus, ctx.ui.setStatus);
		assert.equal(ctx.ui.requestRender, ctx.ui.requestRender);
	});

	it("calls non-blocking members on the host object too", () => {
		// Keyed by receiver identity, so it answers only when the method actually
		// ran on the host. This is the same shape as a class host reading a private
		// field, which throws outright when `this` is the proxy.
		const stateByReceiver = new WeakMap<object, string[]>();
		const seen: string[] = [];
		const host: ExtensionUIContext = {
			...recordingUi({}).ui,
			notify(this: ExtensionUIContext, message: string) {
				stateByReceiver.get(this)?.push(`notify:${message}`);
			},
			setStatus(this: ExtensionUIContext, key: string, text: string | undefined) {
				stateByReceiver.get(this)?.push(`status:${key}=${text}`);
			},
		};
		stateByReceiver.set(host, seen);

		const ctx = contextOver(host);
		ctx.ui.notify("hello");
		ctx.ui.setStatus("k", "v");
		assert.deepEqual(seen, ["notify:hello", "status:k=v"], "members must run on the host, not the proxy");
	});

	it("returns a non-blocking member's value through the forwarder", () => {
		const host: ExtensionUIContext = { ...recordingUi({}).ui, getEditorText: () => "typed text" };
		const ctx = contextOver(host);
		assert.equal(ctx.ui.getEditorText(), "typed text");
	});

	it("re-wraps when a host getter hands back a different function", () => {
		let current = (message: string) => `first:${message}`;
		const base = recordingUi({}).ui;
		const host = Object.defineProperties(
			{ ...base },
			{
				notify: {
					get: () => current,
					configurable: true,
				},
			},
		) as ExtensionUIContext;
		const ctx = contextOver(host);

		const before = ctx.ui.notify;
		assert.equal(ctx.ui.notify, before, "stable while the host returns the same function");
		current = (message: string) => `second:${message}`;
		assert.notEqual(ctx.ui.notify, before, "a new host function gets a new forwarder");
	});

	it("forwards assignment, definition, and deletion to the host", () => {
		// The surrogate target used to swallow every write: the host never saw it,
		// and the surrogate gained an own property that contradicted the descriptor
		// this proxy reports, so the next read or Object.keys threw outright.
		const { ui } = recordingUi({});
		const host: ExtensionUIContext = { ...ui };
		const ctx = contextOver(host);

		const replacement = (): void => {};
		ctx.ui.notify = replacement;
		assert.equal(host.notify, replacement, "assignment reaches the host");
		assert.equal(typeof ctx.ui.notify, "function", "the wrapper still reads cleanly afterwards");
		assert.deepEqual(Object.keys(ctx.ui).sort(), Object.keys(host).sort());
		// `Object.keys` is the interesting part; JSON.stringify would additionally
		// read the host's `theme` getter, which is not initialized in this suite.

		Object.defineProperty(ctx.ui, "setTitle", {
			value: () => {},
			configurable: true,
			writable: true,
			enumerable: true,
		});
		assert.equal(Object.hasOwn(host, "setTitle"), true, "a configurable definition reaches the host");

		assert.equal("hostSessionPicker" in ctx.ui, false, "absent before the host defines it");
		host.hostSessionPicker = () => ({
			result: Promise.resolve(undefined),
			update: () => {},
			error: () => {},
			close: () => {},
		});
		assert.equal("hostSessionPicker" in ctx.ui, true);
		delete ctx.ui.hostSessionPicker;
		assert.equal("hostSessionPicker" in host, false, "deletion reaches the host");
		assert.equal("hostSessionPicker" in ctx.ui, false);
	});

	it("routes an assignment through a host setter on the host object", () => {
		const seen: string[] = [];
		let stored = "";
		const host = Object.defineProperties(
			{ ...recordingUi({}).ui },
			{
				editorText: {
					set(this: ExtensionUIContext, value: string) {
						seen.push(`set:${value}`);
						stored = value;
					},
					get(this: ExtensionUIContext) {
						return stored;
					},
					configurable: true,
					enumerable: true,
				},
			},
		) as ExtensionUIContext;
		const wrapped = contextOver(host).ui as ExtensionUIContext & { editorText: string };

		wrapped.editorText = "typed";
		assert.deepEqual(seen, ["set:typed"], "the host setter ran, not a surrogate write");
		assert.equal(stored, "typed");
	});

	it("holds the block until a cross-realm promise settles", async () => {
		// An isolated host bridge or a vm realm returns a promise that fails
		// `instanceof Promise`, and the block used to be released immediately —
		// reporting the agent free while the user was still being asked.
		const realm = createContext({});
		const makeDeferred = runInContext(
			"(() => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; })",
			realm,
		) as () => { promise: PromiseLike<string>; resolve: (value: string) => void };
		const deferred = makeDeferred();
		assert.equal(deferred.promise instanceof Promise, false, "the fixture must be a foreign promise");

		const { ui } = recordingUi({});
		const host: ExtensionUIContext = { ...ui, select: () => deferred.promise };
		const ctx = contextOver(host);

		const pending = ctx.ui.select("Approve edit?", ["yes"]);
		assert.equal(getOpenUserBlocks().length, 1, "the block is held while the dialog is open");
		deferred.resolve("yes");
		assert.equal(await pending, "yes");
		assert.deepEqual(getOpenUserBlocks(), []);
	});

	it("holds the block until a plain thenable settles, and releases on rejection", async () => {
		let settle: ((value: string) => void) | undefined;
		let fail: ((reason: Error) => void) | undefined;
		const thenable = {
			// biome-ignore lint/suspicious/noThenProperty: a plain thenable is the subject of this test.
			then(onFulfilled: (value: string) => void, onRejected: (reason: Error) => void) {
				settle = onFulfilled;
				fail = onRejected;
			},
		};
		// `Promise.resolve(thenable)` calls `then` in a later microtask, so the
		// callbacks are not available on the turn the dialog was opened.
		const untilThenCalled = async (): Promise<void> => {
			for (let index = 0; index < 10 && settle === undefined; index++) await Promise.resolve();
		};

		const { ui } = recordingUi({});
		const ctx = contextOver({ ...ui, select: () => thenable } as ExtensionUIContext);

		const pending = ctx.ui.select("Approve edit?", ["yes"]);
		assert.equal(getOpenUserBlocks().length, 1, "held while the thenable is pending");
		await untilThenCalled();
		settle?.("yes");
		assert.equal(await pending, "yes");
		assert.deepEqual(getOpenUserBlocks(), []);

		settle = undefined;
		const failure = new Error("dialog failed");
		const rejecting = ctx.ui.select("Approve edit?", ["yes"]);
		assert.equal(getOpenUserBlocks().length, 1);
		await untilThenCalled();
		fail?.(failure);
		assert.equal(
			await captureRejection(async () => {
				await rejecting;
			}),
			failure,
		);
		assert.deepEqual(getOpenUserBlocks(), []);
	});

	it("works on a frozen host UI context", async () => {
		// A proxy may not substitute a value for a non-configurable, non-writable
		// data property on its target. Proxying the host directly therefore threw
		// on the first blocking call, and a frozen ExtensionUIContext is a
		// perfectly valid one to hand to AgentSession.bindExtensions.
		const { ui } = recordingUi({});
		const frozen = Object.freeze({ ...ui });
		const ctx = contextOver(frozen);

		assert.equal(await ctx.ui.select("Pick one", ["a", "b"]), "a");
		assert.equal(await ctx.ui.confirm("Sure?", "really"), true);
		ctx.ui.notify("still fine");
		assert.deepEqual(getOpenUserBlocks(), []);
	});

	it("works when a single dialog method is non-configurable and non-writable", async () => {
		const { ui } = recordingUi({});
		const host = { ...ui };
		Object.defineProperty(host, "select", {
			value: async (_title: string, options: string[]) => options[1],
			writable: false,
			configurable: false,
			enumerable: true,
		});
		const ctx = contextOver(host);

		assert.equal(await ctx.ui.select("Pick one", ["a", "b"]), "b");
		assert.deepEqual(getOpenUserBlocks(), []);
	});

	it("still mints a block for a frozen host's dialog", async () => {
		let openDuringDialog = 0;
		const base = recordingUi({}).ui;
		const frozen = Object.freeze({
			...base,
			confirm: async () => {
				openDuringDialog = getOpenUserBlocks().length;
				return true;
			},
		});
		const ctx = contextOver(frozen);

		assert.equal(await ctx.ui.confirm("Approve edit?", "really"), true);
		assert.equal(openDuringDialog, 1, "freezing the host must not disable block tracking");
		assert.deepEqual(getOpenUserBlocks(), []);
	});

	it("reports the host's own keys and sees members added later", () => {
		const { ui } = recordingUi({});
		const host: ExtensionUIContext = { ...ui };
		const ctx = contextOver(host);

		assert.deepEqual(Object.keys(ctx.ui).sort(), Object.keys(host).sort());

		// The proxy resolves against the live host, so a member the host gains
		// afterwards is visible rather than frozen out by a one-time copy.
		assert.equal("hostInputForm" in ctx.ui, false);
		host.hostInputForm = async () => ({ field: "value" });
		assert.equal("hostInputForm" in ctx.ui, true);
		assert.equal(typeof ctx.ui.hostInputForm, "function");
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

describe("block-door source constraints", () => {
	/**
	 * The repo rule against `any`/`unknown` is a source constraint, and `tsc`
	 * accepts both, so it is checked here rather than assumed.
	 */
	it("adds no any or unknown types in the block door, the reporter, or their tests", async () => {
		const files = [
			"src/core/extensions/runner-ui-blocks.ts",
			"src/core/extensions/user-blocks.ts",
			"src/core/extensions/block-types.ts",
			"src/core/extensions/loaded-extension-paths.ts",
			"src/extensions/herdr/index.ts",
			"src/extensions/herdr/reporter.ts",
			"src/extensions/herdr/reducer.ts",
			"src/extensions/herdr/sequence.ts",
			"src/extensions/herdr/transport.ts",
			"src/extensions/herdr/types.ts",
			// The rule binds the tests this work added too. `tsc` accepts both
			// spellings, and the previous scan covered production files only, so
			// nine `unknown` annotations survived a full green check.
			"test/error-capture.ts",
			"test/extensions-ui-block-wrapping.test.ts",
			"test/extensions-user-blocks.test.ts",
			"test/herdr-activation.test.ts",
			"test/herdr-extension-integration.test.ts",
			"test/herdr-reducer.test.ts",
			"test/herdr-reporter-wire.test.ts",
			"test/herdr-single-writer.test.ts",
			"test/herdr-socket-fixture.ts",
			"test/loaded-extension-paths-cycle.test.ts",
			"test/project-trust-user-block.test.ts",
		];
		const banned = /(:|<|\bas\s+)\s*(any|unknown)\b|\b(any|unknown)\[\]/;
		for (const file of files) {
			const source = await readFile(join(import.meta.dirname, "..", file), "utf8");
			const offenders = source
				.split("\n")
				.map((line, index) => ({ line: line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, ""), index: index + 1 }))
				.filter((entry) => banned.test(entry.line));
			assert.deepEqual(
				offenders.map((entry) => `${file}:${entry.index}: ${entry.line.trim()}`),
				[],
			);
		}
	});
});
