import assert from "node:assert/strict";
import { test } from "vitest";
import { heldPromptInput, heldPrompts } from "../src/core/extensions/held-prompts.js";
import {
	type HostInput,
	HostInputBridge,
	type HostInputOptions,
	hostInputError,
} from "../src/core/extensions/host-input.js";
import { noOpUIContext } from "../src/core/extensions/runner-ui.js";
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "../src/core/extensions/ui-types.js";

function pendingHost(): { host: HostInput; requests: HostInputOptions[] } {
	const requests: HostInputOptions[] = [];
	const present = <T>(options: HostInputOptions): Promise<T> =>
		new Promise((_resolve, reject) => {
			requests.push(options);
			options.signal.addEventListener("abort", () => reject(hostInputError("HumanInputCancelled")), { once: true });
		});
	return {
		requests,
		host: {
			confirm: (_title, _message, options) => present(options),
			select: (_title, _choices, options) => present(options),
			input: (_title, _placeholder, options) => present(options),
			editor: (_title, _initial, options) => present(options),
			questionnaire: (_params, options) => present(options),
		},
	};
}

const dialogs: Array<{
	method: string;
	invoke: (ui: ExtensionUIContext, options: ExtensionUIDialogOptions) => Promise<boolean | string | undefined>;
	expected: false | undefined;
}> = [
	{ method: "confirm", invoke: (ui, options) => ui.confirm("Continue?", "Proceed", options), expected: false },
	{ method: "select", invoke: (ui, options) => ui.select("Pick", ["a", "b"], options), expected: undefined },
	{ method: "input", invoke: (ui, options) => ui.input("Name", undefined, options), expected: undefined },
	{ method: "editor", invoke: (ui, options) => ui.editor("Edit", "draft", options), expected: undefined },
];

for (const { method, invoke, expected } of dialogs) {
	for (const boundary of ["timeout", "signal", "pre-aborted"] as const) {
		test(`${method} returns its cancellation default on caller ${boundary} (#5241)`, async () => {
			const { host, requests } = pendingHost();
			const bridge = new HostInputBridge(
				() => "session-1",
				() => undefined,
			);
			bridge.bind(host);
			const controller = new AbortController();
			if (boundary === "pre-aborted") controller.abort();
			const result = invoke(bridge.wrap(noOpUIContext, host), {
				signal: controller.signal,
				...(boundary === "timeout" ? { timeout: 1 } : {}),
			});
			if (boundary === "signal") controller.abort();
			assert.equal(await result, expected);
			assert.equal(requests.length, boundary === "pre-aborted" ? 0 : 1);
			if (requests[0]) {
				assert.equal(requests[0].signal.aborted, true);
				assert.equal(requests[0].timeout, boundary === "timeout" ? 1 : undefined);
			}
			bridge.close();
		});
	}

	for (const boundary of ["signal", "pre-aborted"] as const) {
		test(`${method} returns its cancellation default when caller and owner share a ${boundary} abort (#5241)`, async () => {
			for (const wrapSignal of [
				(signal: AbortSignal) => signal,
				(signal: AbortSignal) => AbortSignal.any([signal]),
			]) {
				const { host, requests } = pendingHost();
				const owner = new AbortController();
				const bridge = new HostInputBridge(
					() => "session-1",
					() => owner.signal,
				);
				bridge.bind(host);
				const signal = wrapSignal(owner.signal);
				if (boundary === "pre-aborted") owner.abort();
				const result = invoke(bridge.wrap(noOpUIContext, host), { signal });
				if (boundary === "signal") owner.abort();
				assert.equal(await result, expected);
				assert.equal(requests.length, boundary === "pre-aborted" ? 0 : 1);
				if (requests[0]) {
					assert.equal(requests[0].signal.aborted, true);
				}
				bridge.close();
			}
		});
	}
}

for (const boundary of ["cancel", "close", "rebind", "owner"] as const) {
	test(`bridge ${boundary} still rejects a pending dialog (#5241)`, async () => {
		const { host, requests } = pendingHost();
		const owner = new AbortController();
		const bridge = new HostInputBridge(
			() => "session-1",
			() => owner.signal,
		);
		bridge.bind(host);
		const caller = new AbortController();
		const rejected = assert.rejects(
			bridge.wrap(noOpUIContext, host).confirm("Continue?", "Proceed", { signal: caller.signal }),
			{ code: "HumanInputCancelled" },
		);
		if (boundary === "owner") owner.abort();
		else if (boundary === "rebind") bridge.bind(pendingHost().host);
		else bridge[boundary]();
		caller.abort();
		await rejected;
		assert.equal(requests[0]!.signal.aborted, true);
		bridge.close();
	});
}

for (const outcome of ["answered", "invalid", "failed"] as const) {
	for (const route of ["host", "presentation"] as const) {
		test(`a ${route} dialog ${outcome} by its own host retires without aborting the host signal (#5354)`, async () => {
			const { host } = pendingHost();
			let identity!: HostInputOptions;
			host.select = async (_title, _choices, options) => {
				identity = options;
				if (outcome === "failed") throw new Error("host failed");
				return outcome === "invalid" ? "not a choice" : "chosen";
			};
			const bridge = new HostInputBridge(
				() => "session",
				() => undefined,
			);
			bridge.bind(host);
			const result = bridge
				.wrap(noOpUIContext, route === "presentation" ? host : undefined)
				.select("Where?", ["chosen"]);
			if (outcome === "answered") assert.equal(await result, "chosen");
			else if (outcome === "invalid") await assert.rejects(result, { code: "InvalidHostInput" });
			else await assert.rejects(result, /host failed/);
			assert.equal(identity.signal.aborted, false);
			bridge.cancel();
			bridge.close();
			assert.equal(identity.signal.aborted, false);
		});
	}
}

test("held dialogs keep their deadline and expire without accepting input (#5354)", async () => {
	const sessionId = "held-deadline-session";
	const bridge = new HostInputBridge(
		() => sessionId,
		() => undefined,
	);
	bridge.bind(heldPromptInput);
	const started = Date.now();
	const result = bridge.wrap(noOpUIContext).confirm("Continue?", "Waiting", { timeout: 20 });
	const prompt = heldPrompts().current(sessionId);
	assert.equal(await result, false);
	assert.equal(heldPrompts().current(sessionId), undefined);
	assert.ok(prompt?.expiresAt !== undefined);
	assert.ok(prompt.expiresAt >= started + 20);
	assert.ok(prompt.expiresAt <= Date.now() + 20);
	assert.equal(heldPrompts().cancel({ sessionId, promptId: prompt.promptId }), false);
	bridge.close();
});
