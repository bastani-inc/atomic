import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { JsonlSessionStore } from "../src/core/storage/session/jsonl-session-store.js";
import { createSessionManager } from "../src/main-session.ts";
import { buildInteractiveEngineArgs } from "../src/modes/interactive-engine/engine-args.ts";

for (const disableMcp of [false, true]) {
	test(`interactive engine preserves MCP policy and wildcard selections with --no-mcp ${disableMcp}`, () => {
		const parsed = parseArgs([
			"--tools",
			"read,codemode,mcp__evidence__*",
			"--exclude-tools",
			"mcp__*__e*",
			...(disableMcp ? ["--no-mcp"] : []),
		]);
		const child = parseArgs(buildInteractiveEngineArgs(parsed, SessionManager.inMemory(), {}));
		assert.equal(child.noMcp, parsed.noMcp);
		assert.deepEqual(child.tools, parsed.tools);
		assert.deepEqual(child.excludeTools, parsed.excludeTools);
		assert.deepEqual(child.diagnostics, []);
	});
}

test.each(["", "shared-engine-id"])("engine startup resumes ID %j from the selected store", async (id) => {
	const cwd = mkdtempSync(join(tmpdir(), "engine-args-identity-"));
	const originalDirectory = join(cwd, "original");
	const selectedDirectory = join(cwd, "selected");
	const originalStore = await JsonlSessionStore.open(originalDirectory, { exactDirectory: true });
	const selectedStore = await JsonlSessionStore.open(selectedDirectory, { exactDirectory: true });
	const header = { id, version: 4 as const, createdAt: new Date().toISOString(), cwd };
	try {
		await originalStore.create(header, []);
		await selectedStore.create(header, []);
		const original = await SessionManager.open(originalStore, id);
		const selected = await SessionManager.open(selectedStore, id);
		await original.appendSessionInfo("original conversation");
		await selected.appendSessionInfo("selected conversation");
		const parsed = parseArgs(["--session-dir", originalDirectory]);
		const childArgs = parseArgs(buildInteractiveEngineArgs(parsed, selected, {}));
		const resumed = await createSessionManager(childArgs, cwd, childArgs.sessionDir, SettingsManager.inMemory());
		assert.equal(resumed.getSessionId(), id);
		assert.equal(resumed.getSessionDir(), selectedDirectory);
		assert.deepEqual(resumed.getEntries(), selected.getEntries());
		assert.deepEqual((await originalStore.load(id)).entries, original.getEntries());
	} finally {
		await originalStore.close();
		await selectedStore.close();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test.each(["", "imported-engine-id"])(
	"engine imports unsaved context with ID %j without creating session storage (#3683)",
	async (id) => {
		const cwd = mkdtempSync(join(tmpdir(), "engine-args-import-"));
		const directory = join(cwd, "unsaved-sessions");
		const source = await JsonlSessionStore.open(join(cwd, "exports"), { exactDirectory: true });
		const header = { id, version: 4 as const, createdAt: new Date().toISOString(), cwd };
		try {
			await source.create(header, []);
			const exported = await SessionManager.open(source, id);
			await exported.appendMessage({ role: "user", content: "remember this imported context", timestamp: 1 });
			const path = exported.getSessionFile()!;
			const original = readFileSync(path, "utf8");
			const parsed = parseArgs(["--no-session", "--session-dir", directory, "--import", path]);
			const host = await createSessionManager(parsed, cwd, directory, SettingsManager.inMemory());
			const childArgs = parseArgs(buildInteractiveEngineArgs(parsed, host, {}));
			const child = await createSessionManager(childArgs, cwd, childArgs.sessionDir, SettingsManager.inMemory());
			assert.deepEqual(child.buildSessionContext().messages, exported.buildSessionContext().messages);
			assert.equal(child.getSessionId(), id);
			assert.equal(host.isPersisted(), false);
			assert.equal(child.isPersisted(), false);
			assert.equal(child.getSessionFile(), undefined);
			await child.appendMessage({ role: "user", content: "still unsaved", timestamp: 2 });
			assert.equal(existsSync(directory), false);
			assert.equal(readFileSync(path, "utf8"), original);
		} finally {
			await source.close();
			rmSync(cwd, { recursive: true, force: true });
		}
	},
);
