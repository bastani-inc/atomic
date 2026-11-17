import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";
import {
	FileSettingsStorage,
	SettingsFileChangedError,
	writeSettingsFile,
	writeSettingsFileAsync,
} from "../src/core/settings-storage.js";
import type { SettingsScope } from "../src/core/settings-types.js";

const realRenameSync = fs.renameSync;
const realRename = fs.promises.rename;

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
		vi.restoreAllMocks();
		syncBuiltinESMExports();
		rmSync(root, { recursive: true, force: true });
	});

	/**
	 * On Windows a rename another process's handle refuses (EPERM) is tried again for about two seconds. The editor saves
	 * while the first attempt is refused.
	 */
	const onWindowsRefusingTheFirstRename = async <T>(run: () => T | Promise<T>): Promise<T> => {
		const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
		Object.defineProperty(process, "platform", { ...platform, value: "win32" });
		const refuse = (to: string) => {
			if (!to.endsWith(join("agent", "settings.json")) || refused) return false;
			refused = true;
			editorSave({ theme: "light", editorKey: "during the retry" });
			return true;
		};
		let refused = false;
		const eperm = () => Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
		vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
			if (refuse(String(to))) throw eperm();
			realRenameSync(from, to);
		});
		vi.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
			if (refuse(String(to))) throw eperm();
			await realRename(from, to);
		});
		syncBuiltinESMExports();
		try {
			return await run();
		} finally {
			Object.defineProperty(process, "platform", platform);
		}
	};

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

	it("does not replace a file an editor saved while Windows refused the first rename (writeSettingsFile)", async () => {
		const read = readFileSync(globalPath(), "utf-8");
		await onWindowsRefusingTheFirstRename(() =>
			assert.throws(
				() => writeSettingsFile(globalPath(), JSON.stringify({ theme: "dark", atomic: 1 }), { content: read }),
				SettingsFileChangedError,
			),
		);
		assert.deepEqual(readJson(), { theme: "light", editorKey: "during the retry" });
	});

	it("does not replace a file an editor saved while Windows refused the first rename (writeSettingsFileAsync)", async () => {
		const read = readFileSync(globalPath(), "utf-8");
		await onWindowsRefusingTheFirstRename(() =>
			assert.rejects(
				writeSettingsFileAsync(globalPath(), JSON.stringify({ theme: "dark", atomic: 1 }), { content: read }),
				SettingsFileChangedError,
			),
		);
		assert.deepEqual(readJson(), { theme: "light", editorKey: "during the retry" });
	});

	it("merges its change into a file an editor saved while Windows refused the first rename", async () => {
		const storage = new FileSettingsStorage(cwd, agentDir);
		await onWindowsRefusingTheFirstRename(() =>
			storage.withPrimaryWriteLock("global", (current) => withKey(current, "defaultThinkingLevel", "high")),
		);
		assert.deepEqual(readJson(), { theme: "light", editorKey: "during the retry", defaultThinkingLevel: "high" });
		await onWindowsRefusingTheFirstRename(() =>
			storage.withPrimaryWriteLockAsync("global", (current) => withKey(current, "steeringMode", "all")),
		);
		assert.equal(readJson().steeringMode, "all");
	});

	it("says on stderr that a save at exit was given up to an editor, without throwing", () => {
		/** An editor saves the file on every attempt, and the save started before exit never finishes. */
		class EditorKeepsSaving extends FileSettingsStorage {
			override async withPrimaryWriteLockAsync(): Promise<void> {
				await new Promise<never>(() => {});
			}
			override withPrimaryWriteLockAtExit(
				scope: SettingsScope,
				fn: (currentPrimary: string | undefined) => string | undefined,
			): void {
				let save = 0;
				super.withPrimaryWriteLockAtExit(scope, (current) => {
					save += 1;
					editorSave({ theme: "light", save });
					return fn(current);
				});
			}
		}
		const manager = SettingsManager.fromStorage(new EditorKeepsSaving(cwd, agentDir));
		manager.setTheme("solarized");
		const written: string[] = [];
		vi.spyOn(fs, "writeSync").mockImplementation((fd: number, text: unknown) => {
			if (fd === 2) written.push(String(text));
			return String(text).length;
		});
		syncBuiltinESMExports();
		(SettingsManager as unknown as { saveUnsavedWritesAtExit(): void }).saveUnsavedWritesAtExit();
		assert.equal(written.length, 1, "one line on stderr");
		assert.match(
			written[0]!,
			/could not save your global settings before exiting: .*changed while it was being saved/,
		);
		assert.notEqual(readJson().theme, "solarized", "the editor's save stands");
	});

	it("keeps a save that gave up to an editor pending, and saves it at the next flush", async () => {
		/** An editor saves the file on every attempt of the first two saves: a flush's write and its retry. */
		class EditorSavesTwice extends FileSettingsStorage {
			private busy = 2;
			override async withPrimaryWriteLockAsync(
				scope: SettingsScope,
				fn: (currentPrimary: string | undefined) => string | undefined,
			): Promise<void> {
				const editing = this.busy > 0;
				this.busy -= 1;
				let save = 0;
				await super.withPrimaryWriteLockAsync(scope, (current) => {
					if (editing) editorSave({ theme: "light", save: ++save });
					return fn(current);
				});
			}
		}
		const manager = SettingsManager.fromStorage(new EditorSavesTwice(cwd, agentDir));
		manager.setDefaultThinkingLevel("high");
		await manager.flush();
		assert.equal(readJson().defaultThinkingLevel, undefined, "the save and the flush's retry gave up to the editor");
		assert.match(String(manager.drainErrors()[0]?.error.message), /changed while it was being saved/);

		await manager.flush();
		assert.equal(readJson().defaultThinkingLevel, "high", "the next flush saved it");
		assert.equal(readJson().theme, "light", "into the editor's file");
	});
});

describe("a save keeps the keys it does not change exactly as they are on disk", () => {
	it("keeps an ignored legacy routerModel and keys Atomic does not know when it saves another setting", async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-settings-raw-keys-"));
		try {
			const agentDir = join(root, "agent");
			mkdirSync(agentDir, { recursive: true });
			const path = join(agentDir, "settings.json");
			const saved = {
				decisionModel: "auto",
				routerModel: "openai/gpt-6.1-sol",
				queueMode: "all",
				extensionSetting: { nested: true },
			};
			writeFileSync(path, JSON.stringify(saved));
			const manager = SettingsManager.create(join(root, "project"), agentDir);
			manager.setTheme("light");
			await manager.flush();
			assert.deepEqual(JSON.parse(readFileSync(path, "utf-8")), { ...saved, theme: "light" });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
