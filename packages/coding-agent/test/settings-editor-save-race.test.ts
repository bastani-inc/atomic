import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import { FileSettingsStorage } from "../src/core/settings-storage.js";

/**
 * An editor saves settings.json without Atomic's lock. These tests save it the way an editor does while Atomic is
 * between reading the file under its lock and replacing it.
 */
describe("a settings save keeps what an editor saved while it was writing", () => {
	let root: string;
	let agentDir: string;
	let cwd: string;
	const globalPath = () => join(agentDir, "settings.json");
	const readJson = (): Record<string, unknown> => JSON.parse(readFileSync(globalPath(), "utf-8"));
	const editorSave = (settings: Record<string, unknown>) => writeFileSync(globalPath(), JSON.stringify(settings));
	const withKey = (current: string | undefined, key: string, value: unknown): string =>
		JSON.stringify({ ...(current === undefined ? {} : JSON.parse(current)), [key]: value }, null, 2);

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "atomic-settings-editor-race-"));
		agentDir = join(root, "agent");
		cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		writeFileSync(globalPath(), JSON.stringify({ theme: "dark" }));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("merges its change into the editor's save instead of replacing it (withPrimaryWriteLock)", () => {
		const storage = new FileSettingsStorage(cwd, agentDir);
		let calls = 0;
		storage.withPrimaryWriteLock("global", (current) => {
			calls += 1;
			if (calls === 1) editorSave({ theme: "light", editorKey: "kept" });
			return withKey(current, "defaultThinkingLevel", "high");
		});
		assert.deepEqual(readJson(), { theme: "light", editorKey: "kept", defaultThinkingLevel: "high" });
		assert.equal(calls, 2, "the change was merged again into the file the editor saved");
	});

	it("merges its change into the editor's save instead of replacing it (withPrimaryWriteLockAsync)", async () => {
		const storage = new FileSettingsStorage(cwd, agentDir);
		let calls = 0;
		await storage.withPrimaryWriteLockAsync("global", (current) => {
			calls += 1;
			if (calls === 1) editorSave({ theme: "light", editorKey: "kept" });
			return withKey(current, "defaultThinkingLevel", "high");
		});
		assert.deepEqual(readJson(), { theme: "light", editorKey: "kept", defaultThinkingLevel: "high" });
	});

	it("merges its change into the editor's save instead of replacing it (withLock and withLockAsync)", async () => {
		const storage = new FileSettingsStorage(cwd, agentDir);
		let calls = 0;
		storage.withLock("global", (current) => {
			calls += 1;
			if (calls === 1) editorSave({ theme: "light", editorKey: "sync" });
			return withKey(current, "first", 1);
		});
		assert.deepEqual(readJson(), { theme: "light", editorKey: "sync", first: 1 });
		calls = 0;
		await storage.withLockAsync("global", (current) => {
			calls += 1;
			if (calls === 1) editorSave({ theme: "light", editorKey: "async" });
			return withKey(current, "second", 2);
		});
		assert.deepEqual(readJson(), { theme: "light", editorKey: "async", second: 2 });
	});

	it("gives up rather than overwrite a file an editor keeps saving, leaving the editor's last save", () => {
		const storage = new FileSettingsStorage(cwd, agentDir);
		let calls = 0;
		assert.throws(
			() =>
				storage.withPrimaryWriteLock("global", (current) => {
					calls += 1;
					editorSave({ theme: "light", save: calls });
					return withKey(current, "defaultThinkingLevel", "high");
				}),
			/changed while it was being saved/,
		);
		assert.deepEqual(readJson(), { theme: "light", save: calls });
	});
});
