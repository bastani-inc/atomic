import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import type { SavedHandoff } from "../../packages/intercom/broker/multinode-router.js";
import { fileHandoffStore } from "../../packages/intercom/broker/saved-handoffs.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function directory(): string {
	const root = mkdtempSync(join(tmpdir(), "handoffs-"));
	roots.push(root);
	return root;
}

const handoff: SavedHandoff = {
	identity: "identity",
	handoff: "handoff",
	id: "id",
	alias: "alias",
	aliasToken: "token",
	recovery: "recovery",
	at: 1_700_000_000_000,
};

test("saved hand-overs read back as they were saved, owner-only, and none once none are left (#5607)", () => {
	const path = join(directory(), "handoffs.json");
	const store = fileHandoffStore(path);
	assert.deepEqual(store.load(), [], "nothing saved yet");

	store.save([handoff, { ...handoff, identity: "other", aliasToken: undefined }]);
	const { aliasToken: _token, ...withoutToken } = handoff;
	assert.deepEqual(store.load(), [handoff, { ...withoutToken, identity: "other" }]);
	if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);

	store.save([]);
	assert.equal(existsSync(path), false);
});

test("a saved entry this version cannot use is left out, and an unreadable file gives none (#5607)", () => {
	const path = join(directory(), "handoffs.json");
	writeFileSync(path, JSON.stringify([handoff, { ...handoff, at: "yesterday" }, null, { identity: "x" }]));
	assert.deepEqual(fileHandoffStore(path).load(), [handoff]);
	writeFileSync(path, "{ not json");
	assert.deepEqual(fileHandoffStore(path).load(), []);
});

test("saving into a directory that was removed fails and creates nothing (#5607)", () => {
	const root = directory();
	const intercom = join(root, "intercom");
	const store = fileHandoffStore(join(intercom, "handoffs.json"));

	assert.throws(() => store.save([handoff]));
	assert.equal(existsSync(intercom), false);
});
