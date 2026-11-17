import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "vitest";
import type { HostInputFormRequest } from "../../packages/coding-agent/src/core/extensions/ui-types.js";
import { EngineInputFormService } from "../../packages/coding-agent/src/modes/interactive-engine/engine-input-form.js";

for (const kind of ["circular", "bigint"] as const) {
	test(`a ${kind} input form rejects without retaining an abort listener (#5224)`, async () => {
		const controller = new AbortController();
		const circular: { self?: object } = {};
		circular.self = circular;
		const request = {
			title: "demo",
			fields: [
				{
					name: "value",
					type: "string",
					initialValue: "",
					description: (kind === "circular" ? circular : 1n) as unknown as string,
				},
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

test("an aborted input form settles at once even when its close frame cannot be written (#5224)", async () => {
	const controller = new AbortController();
	let failWrites = false;
	const lines: string[] = [];
	const service = new EngineInputFormService((line) => {
		if (failWrites) throw new Error("write failed on close");
		lines.push(line);
	});
	const result = service.open({ title: "demo", fields: [] }, controller.signal);
	await Promise.resolve();
	assert.equal(lines.length, 1);
	const uncaught: unknown[] = [];
	const onUncaught = (error: unknown) => uncaught.push(error);
	process.prependListener("uncaughtException", onUncaught);
	try {
		failWrites = true;
		controller.abort();
		await new Promise((resolve) => setTimeout(resolve, 20));
	} finally {
		process.removeListener("uncaughtException", onUncaught);
	}
	const settled = await Promise.race([
		result.then((values) => ({ values })),
		new Promise((resolve) => setTimeout(() => resolve("pending"), 100)),
	]);
	assert.deepEqual(settled, { values: undefined });
	assert.deepEqual(uncaught.map(String), []);
	failWrites = false;
	service.handleLine(
		JSON.stringify({ type: "engine_input_form_submit", componentId: "input_form_1", values: { late: "x" } }),
	);
	assert.equal(await result, undefined);
	service.dispose();
});

test("a settled input form no longer holds an engine record, however it ends (#5224)", async () => {
	const lines: string[] = [];
	const service = new EngineInputFormService((line) => lines.push(line));
	const openForms = () => (service as unknown as { active: Map<string, unknown> }).active.size;
	const controller = new AbortController();
	const submitted = service.open({ title: "submit", fields: [] });
	const cancelled = service.open({ title: "cancel", fields: [] });
	const failed = service.open({ title: "error", fields: [] });
	const aborted = service.open({ title: "abort", fields: [] }, controller.signal);
	await Promise.resolve();
	assert.equal(openForms(), 4);
	service.handleLine(JSON.stringify({ type: "engine_input_form_submit", componentId: "input_form_1", values: {} }));
	service.handleLine(JSON.stringify({ type: "engine_input_form_cancel", componentId: "input_form_2" }));
	service.handleLine(JSON.stringify({ type: "engine_input_form_error", componentId: "input_form_3", message: "no" }));
	controller.abort();
	assert.deepEqual(await submitted, {});
	assert.equal(await cancelled, undefined);
	await assert.rejects(failed, /no/);
	assert.equal(await aborted, undefined);
	assert.equal(openForms(), 0);
	service.dispose();
});

test("a failed input form write rejects and releases its listener (#5224)", async () => {
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
