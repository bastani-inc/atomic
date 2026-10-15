import assert from "node:assert/strict";
import { describe, it, test } from "vitest";
import { registerSessionStoreConformance } from "../../packages/coding-agent/src/core/storage/session/conformance.js";
import { StoreClosedError } from "../../packages/coding-agent/src/core/storage/session/errors.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { SESSION_FORMAT_VERSION } from "../../packages/coding-agent/src/core/storage/session/types.js";

registerSessionStoreConformance({ describe, it }, "MemorySessionStore", async (body) => {
	let store = new MemorySessionStore();
	try {
		await body({
			store,
			reopen: async () => {
				store = await store.reopen();
				return store;
			},
		});
	} finally {
		await store.close().catch((error: Error) => assert.ok(error instanceof StoreClosedError));
	}
});

test("memory sessions commit the header and ordered entries before create resolves", async () => {
	const store = new MemorySessionStore();
	const header = {
		id: "session",
		version: SESSION_FORMAT_VERSION,
		createdAt: "2026-10-15T00:00:00Z",
		cwd: "",
	} as const;
	const entries = [
		{ type: "session_info", id: "name", parentId: null, timestamp: header.createdAt, name: " Name " },
	] as const;
	assert.deepEqual(await store.create(header, entries), { lastSeq: 1 });
	assert.deepEqual(await store.load(header.id), { header, entries, lastSeq: 1 });
	await store.close();
});

test("memory handles share records only through reopen and detach descriptors and nested writes", async () => {
	const store = new MemorySessionStore();
	const header = {
		id: "unusual-π",
		version: SESSION_FORMAT_VERSION,
		createdAt: "2026-10-15T00:00:00Z",
		cwd: "",
	} as const;
	await store.create(header, []);
	const entry = {
		type: "custom" as const,
		id: "entry",
		parentId: null,
		timestamp: header.createdAt,
		customType: "test",
		data: { values: ["original"] },
	};
	await store.append(header.id, [entry], { expectSeq: 0 });
	entry.data.values[0] = "changed";
	const reopened = await store.reopen();
	const expected = { ...entry, data: { values: ["original"] } };
	assert.deepEqual((await reopened.load(header.id)).entries, [expected]);
	const descriptor = store.descriptor as { adapter: string; location: string };
	descriptor.adapter = "changed";
	descriptor.location = "changed";
	assert.deepEqual(store.descriptor, { adapter: "memory", location: ":memory:" });
	const replacement = { ...header, workflow: { runId: "run", stageId: "stage", stageName: "original" } };
	await reopened.replace(header.id, replacement, [expected], { expectSeq: 1 });
	replacement.workflow.stageName = "changed";
	expected.data.values[0] = "changed";
	assert.equal((await store.readHeader(header.id))?.workflow?.stageName, "original");
	assert.deepEqual((await store.load(header.id)).entries, [{ ...entry, data: { values: ["original"] } }]);
	const independent = new MemorySessionStore();
	assert.equal(await independent.readHeader(header.id), undefined);
	await store.close();
	assert.equal((await reopened.load(header.id)).lastSeq, 1);
	await reopened.close();
	await independent.close();
});
