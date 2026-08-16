import assert from "node:assert/strict";
import { test } from "vitest";
import {
	boundedToolPayload,
	boundedToolPayloadRecord,
	boundedToolPayloadText,
	isToolPayloadArray,
	isToolPayloadCallable,
	isToolPayloadObject,
	isToolPayloadObjectLike,
	TOOL_PAYLOAD_MAX_KEYS,
	TOOL_PAYLOAD_TRUNCATION_MARKER,
} from "../../packages/workflows/src/shared/tool-payload-bounds.js";

const WIDE_KEY_COUNT = 200_000;
/** The implementation must stop controlled per-key work far below the payload width. */
const EXPECTED_MAX_KEY_INSPECTIONS = TOOL_PAYLOAD_MAX_KEYS;
interface ProxyWorkCounters {
	ownKeys: number;
	descriptors: number;
	gets: number;
}

function wideEnumerableProxy(): { readonly value: object; readonly counters: ProxyWorkCounters } {
	const keys = Array.from({ length: WIDE_KEY_COUNT }, (_, index) => `wide-${index}`);
	const counters: ProxyWorkCounters = { ownKeys: 0, descriptors: 0, gets: 0 };
	const value = new Proxy(
		{},
		{
			ownKeys() {
				counters.ownKeys += 1;
				return keys;
			},
			getOwnPropertyDescriptor() {
				counters.descriptors += 1;
				return { configurable: true, enumerable: true };
			},
			get(_target, key) {
				counters.gets += 1;
				return typeof key === "string" && key.startsWith("wide-") ? "value" : undefined;
			},
		},
	);
	return { value, counters };
}

function assertBoundedProxyWork(counters: ProxyWorkCounters, label: string): void {
	assert.ok(counters.ownKeys <= 1, `${label}: ownKeys trap ran ${counters.ownKeys} times`);
	assert.ok(
		counters.descriptors <= EXPECTED_MAX_KEY_INSPECTIONS,
		`${label}: inspected ${counters.descriptors} descriptors`,
	);
	assert.ok(counters.gets <= EXPECTED_MAX_KEY_INSPECTIONS + 2, `${label}: read ${counters.gets} values`);
}

test("payload boundary guards classify hostile object and callable values", () => {
	const jsonObject = { toJSON: () => ({ ok: true }) };
	assert.equal(isToolPayloadObject(jsonObject as never), true);
	assert.equal(isToolPayloadObjectLike(jsonObject as never), true);
	assert.equal(isToolPayloadCallable(jsonObject.toJSON as never), true);
	assert.equal(isToolPayloadArray([] as never), true);
	assert.equal(isToolPayloadObject([] as never), false);

	const throwingObject = {};
	Object.defineProperty(throwingObject, "toJSON", {
		enumerable: true,
		get() {
			throw new Error("hostile toJSON getter");
		},
	});
	assert.equal(boundedToolPayload(throwingObject as never), "<unreadable>");
});

test("wide hostile objects bound descriptor and value work on retention and text paths", () => {
	const retained = wideEnumerableProxy();
	boundedToolPayload(retained.value as never, 32);
	assertBoundedProxyWork(retained.counters, "boundedToolPayload");

	const record = wideEnumerableProxy();
	boundedToolPayloadRecord(record.value as never, 32);
	assertBoundedProxyWork(record.counters, "boundedToolPayloadRecord");

	const text = wideEnumerableProxy();
	const rendered = boundedToolPayloadText(text.value as never, 32);
	assertBoundedProxyWork(text.counters, "boundedToolPayloadText");
	assert.ok(rendered.includes(TOOL_PAYLOAD_TRUNCATION_MARKER));
});

test("truncation marker never overwrites an emitted author key", () => {
	const payload = { "…": "author-value", first: "x", second: "y", tail: "z" };
	for (const retained of [boundedToolPayload(payload as never, 22), boundedToolPayloadRecord(payload as never, 22)]) {
		const record = retained as { readonly [key: string]: string };
		assert.equal(record["…"], "author-value");
		assert.equal(record["…1"], TOOL_PAYLOAD_TRUNCATION_MARKER);
	}
});
