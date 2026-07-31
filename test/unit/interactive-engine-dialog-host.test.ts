import assert from "node:assert/strict";
import { test } from "vitest";
import type { ExtensionUIContext } from "../../packages/coding-agent/src/core/extensions/index.ts";
import { EngineDialogHostController } from "../../packages/coding-agent/src/modes/interactive-engine/engine-dialog-host.ts";
import type { InteractiveEngineGenerationEnded } from "../../packages/coding-agent/src/modes/interactive-engine/engine-generation.ts";
import type { IsolatedInteractiveRuntime } from "../../packages/coding-agent/src/modes/interactive-engine/isolated-runtime.ts";
import type {
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
} from "../../packages/coding-agent/src/modes/rpc/rpc-types.ts";
import { sleep } from "../helpers/runtime.js";

/**
 * `select`, `confirm`, `input`, and `editor` mount real host components on
 * behalf of the engine child. Before this controller they had no owner: a dead
 * generation left its dialog on screen forever, its host promise unsettled, and
 * a late answer could be written to the replacement child.
 */

interface Mount {
	method: string;
	resolve(value: unknown): void;
	aborted: boolean;
}

interface Harness {
	controller: EngineDialogHostController;
	mounts: Mount[];
	widgetWrites: Array<{ key: string; cleared: boolean }>;
	responses: Array<RpcExtensionUIResponse | undefined>;
	generation: number;
	send(request: RpcExtensionUIRequest): Promise<void>;
	endGeneration(generation: number): void;
}

function harness(): Harness {
	const mounts: Mount[] = [];
	const widgetWrites: Array<{ key: string; cleared: boolean }> = [];
	const responses: Array<RpcExtensionUIResponse | undefined> = [];
	const generationListeners: Array<(event: InteractiveEngineGenerationEnded) => void> = [];
	let handler: ((request: RpcExtensionUIRequest) => Promise<RpcExtensionUIResponse | undefined>) | undefined;
	const state = { generation: 1 };

	const mount = (method: string, signal: AbortSignal | undefined): Promise<unknown> =>
		new Promise((resolve) => {
			const record: Mount = { method, resolve, aborted: false };
			mounts.push(record);
			signal?.addEventListener(
				"abort",
				() => {
					record.aborted = true;
					// The real host dialogs resolve undefined (cancelled) when aborted.
					resolve(undefined);
				},
				{ once: true },
			);
		});

	const ui = {
		select: (_title: string, _options: string[], opts?: { signal?: AbortSignal }) => mount("select", opts?.signal),
		confirm: (_title: string, _message: string, opts?: { signal?: AbortSignal }) => mount("confirm", opts?.signal),
		input: (_title: string, _placeholder?: string, opts?: { signal?: AbortSignal }) => mount("input", opts?.signal),
		editor: (_title: string, _prefill?: string, opts?: { signal?: AbortSignal }) => mount("editor", opts?.signal),
		notify: () => {},
		setStatus: () => {},
		setWidget: (key: string, lines: string[] | undefined) => {
			widgetWrites.push({ key, cleared: lines === undefined });
		},
		setTitle: () => {},
		setEditorText: () => {},
	} as unknown as ExtensionUIContext;

	const runtime = {
		getEngineGeneration: () => state.generation,
		setExtensionUIHandler: (next: typeof handler) => {
			handler = next;
			return () => {
				handler = undefined;
			};
		},
		onGenerationEnded: (listener: (event: InteractiveEngineGenerationEnded) => void) => {
			generationListeners.push(listener);
			return () => {};
		},
	} as unknown as IsolatedInteractiveRuntime;

	const controller = new EngineDialogHostController(runtime, ui);
	return {
		controller,
		mounts,
		widgetWrites,
		responses,
		get generation(): number {
			return state.generation;
		},
		set generation(value: number) {
			state.generation = value;
		},
		send: async (request) => {
			responses.push(await handler!(request));
		},
		endGeneration: (generation) => {
			state.generation = generation + 1;
			for (const listener of [...generationListeners]) {
				listener({ generation, error: new Error("Agent process exited"), kind: "exit", expected: false });
			}
		},
	} as Harness;
}

const REQUESTS: Record<string, RpcExtensionUIRequest> = {
	select: {
		type: "extension_ui_request",
		id: "r1",
		method: "select",
		title: "pick",
		options: ["a"],
	} as RpcExtensionUIRequest,
	confirm: {
		type: "extension_ui_request",
		id: "r2",
		method: "confirm",
		title: "sure?",
		message: "really",
	} as RpcExtensionUIRequest,
	input: { type: "extension_ui_request", id: "r3", method: "input", title: "name" } as RpcExtensionUIRequest,
	editor: { type: "extension_ui_request", id: "r4", method: "editor", title: "edit" } as RpcExtensionUIRequest,
};

for (const [method, request] of Object.entries(REQUESTS)) {
	test(`${method}: engine death closes the dialog and suppresses the reply`, async () => {
		const h = harness();
		const settled = h.send(request);
		await sleep(0);
		assert.equal(h.mounts.length, 1, `${method} did not mount`);
		assert.equal(h.mounts[0]!.method, method);

		h.endGeneration(1);
		await settled;

		assert.equal(h.mounts[0]!.aborted, true, "the exact mount must be cancelled");
		assert.deepEqual(h.responses, [undefined], "a dead generation must never be answered");
		h.controller.dispose();
	});

	test(`${method}: an ordinary answer still reaches the engine`, async () => {
		const h = harness();
		const settled = h.send(request);
		await sleep(0);
		h.mounts[0]!.resolve(method === "confirm" ? true : "value");
		await settled;
		assert.equal(h.responses.length, 1);
		assert.ok(h.responses[0] !== undefined, "a live generation must be answered");
		assert.equal(h.mounts[0]!.aborted, false);
		h.controller.dispose();
	});
}

test("a dialog opened by the replacement generation survives stale cleanup", async () => {
	const h = harness();
	const stale = h.send(REQUESTS.select!);
	await sleep(0);

	// The replacement child opens its own dialog before the old generation's
	// teardown runs.
	h.generation = 2;
	const fresh = h.send({ ...REQUESTS.input!, id: "r9" });
	await sleep(0);
	assert.equal(h.mounts.length, 2);

	h.endGeneration(1);
	await stale;
	assert.equal(h.mounts[0]!.aborted, true, "the dead generation's dialog closes");
	assert.equal(h.mounts[1]!.aborted, false, "a newer dialog must not be dismissed");

	h.mounts[1]!.resolve("still mine");
	await fresh;
	assert.equal(h.responses.length, 2);
	assert.equal(h.responses[0], undefined, "the stale request stays unanswered");
	assert.ok(h.responses[1] !== undefined, "the newer request is answered normally");
	h.controller.dispose();
});

test("non-mounting requests are handled without ownership bookkeeping", async () => {
	const h = harness();
	await h.send({ type: "extension_ui_request", id: "n1", method: "notify", message: "hi" } as RpcExtensionUIRequest);
	assert.deepEqual(h.responses, [undefined]);
	assert.equal(h.mounts.length, 0);
	h.endGeneration(1);
	h.controller.dispose();
});

test("disposing the controller cancels every live dialog", async () => {
	const h = harness();
	const settled = h.send(REQUESTS.editor!);
	await sleep(0);
	h.controller.dispose();
	await settled;
	assert.equal(h.mounts[0]!.aborted, true);
	assert.deepEqual(h.responses, [undefined]);
});

/**
 * Line widgets are plain host state keyed by name with no component to close,
 * so a dead generation used to leave its lines on screen forever. Ownership is
 * tracked per key and released only for the generation that last wrote it.
 */
function widgetRequest(id: string, key: string, lines: string[] | undefined): RpcExtensionUIRequest {
	return {
		type: "extension_ui_request",
		id,
		method: "setWidget",
		widgetKey: key,
		widgetLines: lines,
	} as RpcExtensionUIRequest;
}

test("a line widget is released when its owning generation dies", async () => {
	const h = harness();
	await h.send(widgetRequest("w1", "engine-status", ["line"]));
	assert.deepEqual(h.widgetWrites, [{ key: "engine-status", cleared: false }]);

	h.endGeneration(1);
	assert.deepEqual(h.widgetWrites.at(-1), { key: "engine-status", cleared: true });

	// Nothing left to release on a second death.
	const writes = h.widgetWrites.length;
	h.endGeneration(2);
	assert.equal(h.widgetWrites.length, writes);
	h.controller.dispose();
});

test("an explicit widget clear also drops ownership", async () => {
	const h = harness();
	await h.send(widgetRequest("w1", "engine-status", ["line"]));
	await h.send(widgetRequest("w2", "engine-status", undefined));
	const writes = h.widgetWrites.length;
	h.endGeneration(1);
	assert.equal(h.widgetWrites.length, writes, "an already-cleared key must not be cleared again");
	h.controller.dispose();
});

test("a newer generation takes over a widget key and survives stale cleanup", async () => {
	const h = harness();
	await h.send(widgetRequest("w1", "shared", ["from generation 1"]));
	h.generation = 2;
	await h.send(widgetRequest("w2", "shared", ["from generation 2"]));
	const writes = h.widgetWrites.length;

	// Generation 1's teardown must not wipe the replacement's live content.
	h.controller.disposeGeneration(1);
	assert.equal(h.widgetWrites.length, writes, "stale cleanup cleared a newer generation's widget");

	h.controller.disposeGeneration(2);
	assert.deepEqual(h.widgetWrites.at(-1), { key: "shared", cleared: true });
	h.controller.dispose();
});

test("disposing the controller releases every widget key it still owns", async () => {
	const h = harness();
	await h.send(widgetRequest("w1", "a", ["x"]));
	await h.send(widgetRequest("w2", "b", ["y"]));
	h.controller.dispose();
	assert.deepEqual(
		h.widgetWrites
			.slice(-2)
			.map((write) => write.key)
			.sort(),
		["a", "b"],
	);
	assert.ok(h.widgetWrites.slice(-2).every((write) => write.cleared));
});
