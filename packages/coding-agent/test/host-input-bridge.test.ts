import assert from "node:assert/strict";
import { test } from "vitest";
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
