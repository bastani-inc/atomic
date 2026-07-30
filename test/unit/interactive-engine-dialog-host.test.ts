import { test } from "bun:test";
import assert from "node:assert/strict";
import type { ExtensionUIContext } from "../../packages/coding-agent/src/core/extensions/index.ts";
import { EngineDialogHostController } from "../../packages/coding-agent/src/modes/interactive-engine/engine-dialog-host.ts";
import type { IsolatedInteractiveRuntime } from "../../packages/coding-agent/src/modes/interactive-engine/isolated-runtime.ts";
import type { InteractiveEngineGenerationEnded } from "../../packages/coding-agent/src/modes/interactive-engine/engine-generation.ts";
import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from "../../packages/coding-agent/src/modes/rpc/rpc-types.ts";

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
	responses: Array<RpcExtensionUIResponse | undefined>;
	generation: number;
	send(request: RpcExtensionUIRequest): Promise<void>;
	endGeneration(generation: number): void;
}

function harness(): Harness {
	const mounts: Mount[] = [];
	const responses: Array<RpcExtensionUIResponse | undefined> = [];
	const generationListeners: Array<(event: InteractiveEngineGenerationEnded) => void> = [];
	let handler: ((request: RpcExtensionUIRequest) => Promise<RpcExtensionUIResponse | undefined>) | undefined;
	const state = { generation: 1 };

	const mount = (method: string, signal: AbortSignal | undefined): Promise<unknown> =>
		new Promise((resolve) => {
			const record: Mount = { method, resolve, aborted: false };
			mounts.push(record);
			signal?.addEventListener("abort", () => {
				record.aborted = true;
				// The real host dialogs resolve undefined (cancelled) when aborted.
				resolve(undefined);
			}, { once: true });
		});

	const ui = {
		select: (_title: string, _options: string[], opts?: { signal?: AbortSignal }) => mount("select", opts?.signal),
		confirm: (_title: string, _message: string, opts?: { signal?: AbortSignal }) => mount("confirm", opts?.signal),
		input: (_title: string, _placeholder?: string, opts?: { signal?: AbortSignal }) => mount("input", opts?.signal),
		editor: (_title: string, _prefill?: string, opts?: { signal?: AbortSignal }) => mount("editor", opts?.signal),
		notify: () => {},
		setStatus: () => {},
		setWidget: () => {},
		setTitle: () => {},
		setEditorText: () => {},
	} as unknown as ExtensionUIContext;

	const runtime = {
		getEngineGeneration: () => state.generation,
		setExtensionUIHandler: (next: typeof handler) => { handler = next; return () => { handler = undefined; }; },
		onGenerationEnded: (listener: (event: InteractiveEngineGenerationEnded) => void) => {
			generationListeners.push(listener);
			return () => {};
		},
	} as unknown as IsolatedInteractiveRuntime;

	const controller = new EngineDialogHostController(runtime, ui);
	return {
		controller,
		mounts,
		responses,
		get generation(): number { return state.generation; },
		set generation(value: number) { state.generation = value; },
		send: async (request) => { responses.push(await handler!(request)); },
		endGeneration: (generation) => {
			state.generation = generation + 1;
			for (const listener of [...generationListeners]) {
				listener({ generation, error: new Error("Agent process exited"), kind: "exit", expected: false });
			}
		},
	} as Harness;
}

const REQUESTS: Record<string, RpcExtensionUIRequest> = {
	select: { type: "extension_ui_request", id: "r1", method: "select", title: "pick", options: ["a"] } as RpcExtensionUIRequest,
	confirm: { type: "extension_ui_request", id: "r2", method: "confirm", title: "sure?", message: "really" } as RpcExtensionUIRequest,
	input: { type: "extension_ui_request", id: "r3", method: "input", title: "name" } as RpcExtensionUIRequest,
	editor: { type: "extension_ui_request", id: "r4", method: "editor", title: "edit" } as RpcExtensionUIRequest,
};

for (const [method, request] of Object.entries(REQUESTS)) {
	test(`${method}: engine death closes the dialog and suppresses the reply`, async () => {
		const h = harness();
		const settled = h.send(request);
		await Bun.sleep(0);
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
		await Bun.sleep(0);
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
	await Bun.sleep(0);

	// The replacement child opens its own dialog before the old generation's
	// teardown runs.
	h.generation = 2;
	const fresh = h.send({ ...REQUESTS.input!, id: "r9" });
	await Bun.sleep(0);
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
	await Bun.sleep(0);
	h.controller.dispose();
	await settled;
	assert.equal(h.mounts[0]!.aborted, true);
	assert.deepEqual(h.responses, [undefined]);
});
