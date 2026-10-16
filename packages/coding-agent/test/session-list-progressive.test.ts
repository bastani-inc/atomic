import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { type SessionInfo, SessionManager } from "../src/core/session-manager.js";

test("publishes sorted partial sessions without leaking hidden sessions or other directories", async () => {
	const dir = mkdtempSync(join(tmpdir(), "atomic-progressive-"));
	try {
		for (let index = 0; index < 15; index++) {
			const session = await SessionManager.create(index === 14 ? "/other" : process.cwd(), dir, {
				internal: index === 13,
				...(index === 13
					? { workflow: { runId: "run-progressive", stageId: "stage-hidden", stageName: "hidden" } }
					: {}),
			});
			await session.appendMessage({ role: "user", content: `message ${index}`, timestamp: index + 1 });
		}
		const partials: SessionInfo[][] = [];
		const sessions = await SessionManager.list(process.cwd(), dir, (_loaded, _total, partial) => {
			if (partial) partials.push([...partial]);
		});
		assert.ok(partials.length >= 2);
		assert.deepEqual(partials.at(-1), sessions);
		for (const partial of partials) {
			assert.ok(partial.every((session) => !session.internal && session.cwd === process.cwd()));
			assert.deepEqual(
				partial.map((session) => session.modified.getTime()),
				partial.map((session) => session.modified.getTime()).sort((a, b) => b - a),
			);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("rejects an aborted session scan rather than returning an empty successful list", async () => {
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(SessionManager.list(process.cwd(), undefined, undefined, controller.signal), {
		name: "AbortError",
	});
});
