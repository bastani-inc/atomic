import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "vitest";
import type { HostInputFormRequest } from "../../packages/coding-agent/src/core/extensions/ui-types.js";
import { EngineInputFormService } from "../../packages/coding-agent/src/modes/interactive-engine/engine-input-form.js";

for (const kind of ["circular", "bigint"] as const) {
	test(`a ${kind} input form rejects without retaining an abort listener (#5245)`, async () => {
		const controller = new AbortController();
		const circular: { self?: object } = {};
		circular.self = circular;
		const request = {
			title: "demo",
			fields: [
				{ name: "value", type: "string", initialValue: "", schema: kind === "circular" ? circular : { const: 1n } },
			],
		} as HostInputFormRequest;
		const lines: string[] = [];
		const service = new EngineInputFormService((line) => lines.push(line));
		let result: Promise<Record<string, string> | undefined> | undefined;
		assert.doesNotThrow(() => {
			result = service.open(request, controller.signal);
		});
		assert.ok(result);
		await assert.rejects(result);
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		controller.abort();
		assert.deepEqual(lines, []);
		service.dispose();
	});
}

test("a failed input form write rejects and releases its listener (#5245)", async () => {
	const controller = new AbortController();
	let writes = 0;
	const service = new EngineInputFormService(() => {
		writes += 1;
		throw new Error("write failed");
	});
	let result: Promise<Record<string, string> | undefined> | undefined;
	assert.doesNotThrow(() => {
		result = service.open({ title: "demo", fields: [] }, controller.signal);
	});
	assert.ok(result);
	await assert.rejects(result, /write failed/);
	controller.abort();
	assert.equal(writes, 1);
	service.dispose();
});
