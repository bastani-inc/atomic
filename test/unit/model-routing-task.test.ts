import assert from "node:assert/strict";
import { test } from "vitest";
import {
	MODEL_ROUTING_TASK_BYTES,
	modelRoutingTask,
	TRUNCATED_MARKER,
	truncateToBytes,
} from "../../packages/coding-agent/src/core/model-routing-task.js";

const size = (text: string) => Buffer.byteLength(JSON.stringify(text), "utf8");

test("small tasks and exact byte-boundary tasks remain verbatim", () => {
	for (const task of ["", "  task\n", "x".repeat(MODEL_ROUTING_TASK_BYTES - 2)]) {
		assert.equal(modelRoutingTask(task), task);
	}
});

for (const unit of ["a", "界", "😀", '"\\\n\t\u0000']) {
	test(`routing excerpts bound JSON bytes without splitting Unicode: ${JSON.stringify(unit)}`, () => {
		const task = `START ${unit.repeat(20_000)} END`;
		const excerpt = modelRoutingTask(task);
		assert.ok(size(excerpt) <= MODEL_ROUTING_TASK_BYTES);
		assert.match(excerpt, /START/);
		assert.match(excerpt, /END/);
		assert.ok(excerpt.includes(TRUNCATED_MARKER));
		assert.equal(excerpt.isWellFormed(), true);
		assert.equal(modelRoutingTask(task), excerpt);
	});
}

test("multiple, nested, mixed-case and unclosed protected spans survive in source order", () => {
	const first = "<keepContext>one<KEEPCONTEXT>two</keepContext>three</keepContext>";
	const second = "<keepContext>four</keepContext>";
	const unclosed = "<keepContext>five";
	const task = `${"a".repeat(20_000)}${first}${"b".repeat(20_000)}${second}${"c".repeat(20_000)}${unclosed}`;
	const excerpt = modelRoutingTask(task);
	assert.ok(size(excerpt) <= MODEL_ROUTING_TASK_BYTES);
	for (const span of [first, second, unclosed]) {
		assert.equal(excerpt.split(span).length, 2);
	}
	assert.ok(excerpt.indexOf(first) < excerpt.indexOf(second));
	assert.ok(excerpt.indexOf(second) < excerpt.indexOf(unclosed));
});

test("oversized protected content is truncated with a marker instead of sent whole", () => {
	for (const close of ["", "</keepContext>"]) {
		const task = `start<keepContext>${"x".repeat(30_000)}${close}end`;
		const excerpt = modelRoutingTask(task);
		assert.ok(size(excerpt) <= MODEL_ROUTING_TASK_BYTES);
		assert.match(excerpt, /<keepContext>x+/);
		assert.ok(excerpt.endsWith(TRUNCATED_MARKER));
	}
});

test("a smaller budget bounds the excerpt; a budget below the marker yields empty text", () => {
	const task = `START ${"界".repeat(5_000)} END`;
	assert.ok(size(modelRoutingTask(task, 500)) <= 500);
	assert.equal(truncateToBytes(task, 4), "");
	const cut = truncateToBytes("😀".repeat(1_000), 101);
	assert.equal(cut.isWellFormed(), true);
	assert.ok(size(cut) <= 101);
});
