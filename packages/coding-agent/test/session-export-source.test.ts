import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { createHarness } from "./suite/harness.ts";

test("an export writes the session shown when it was asked for, also if another takes its place meanwhile (#6077)", async () => {
	const harness = await createHarness();
	const dir = mkdtempSync(join(tmpdir(), "atomic-export-source-"));
	try {
		const shown = harness.session.sessionManager.getSessionId();
		const exported = harness.session.exportToJsonl(join(dir, "session.jsonl"), { includeShareContext: true });
		// The view now shows another session, as a new unsaved session does on the isolated host.
		const other = SessionManager.inMemory();
		Object.defineProperty(harness.session, "sessionManager", { configurable: true, value: other });
		const header = JSON.parse(readFileSync(await exported, "utf8").split("\n")[0] ?? "") as { id: string };
		assert.notEqual(other.getSessionId(), shown);
		assert.equal(header.id, shown);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		await harness.cleanup();
	}
});
