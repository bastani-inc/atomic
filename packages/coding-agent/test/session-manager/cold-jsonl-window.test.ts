import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

const stamp = new Date(0).toISOString();
const historical = JSON.stringify({
	type: "message",
	id: "u",
	parentId: null,
	timestamp: stamp,
	message: { role: "user", timestamp: 0, content: "large archived message " + "x".repeat(2 * 1024 * 1024) },
});
async function sessionFile(line: string) {
	const dir = await mkdtemp(join(tmpdir(), "atomic-cold-jsonl-"));
	const file = join(dir, "session.jsonl");
	await writeFile(
		file,
		[
			JSON.stringify({ type: "session", version: 4, id: "old", createdAt: stamp, cwd: dir }),
			line,
			JSON.stringify({
				type: "compaction",
				id: "c",
				parentId: "u",
				timestamp: stamp,
				summary: "C",
				firstKeptEntryId: null,
				tokensBefore: 100,
				details: { strategy: "verbatim-lines" },
			}),
		].join("\n") + "\n",
	);
	return { dir, file };
}

test("cold JSONL resume indexes a valid oversized retired turn without decoding its whole body (#5554)", async () => {
	const { dir, file } = await sessionFile(historical);
	const parse = JSON.parse;
	let count = 0;
	const spy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
		if (text.length > 1024 * 1024 && text.includes("large archived message")) count++;
		return parse(text, reviver);
	});
	try {
		const m = await SessionManager.open(file);
		try {
			assert.equal(m.getEntry("u"), undefined);
			assert.equal(m.getLeafId(), "c");
			assert.equal(count, 0);
		} finally {
			await m.getSessionStore().close();
		}
	} finally {
		spy.mockRestore();
		await rm(dir, { recursive: true, force: true });
	}
});
test("a malformed oversized JSONL row keeps the native parser diagnostic (#5554)", async () => {
	const malformed = historical + "broken";
	const { dir, file } = await sessionFile(malformed);
	let native = "";
	try {
		JSON.parse(malformed);
	} catch (e) {
		native = (e as Error).message;
	}
	try {
		await assert.rejects(SessionManager.open(file), (error: Error) => {
			let cause: unknown = error;
			while (cause instanceof Error) {
				if (cause.name === "SyntaxError" && cause.message === native) return true;
				cause = cause.cause;
			}
			return false;
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
