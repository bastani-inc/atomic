import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { JsonlSessionStore } from "../src/core/storage/session/jsonl-session-store.js";
import { createHarness } from "./suite/harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

for (const outcome of ["startup-rejection", "publication-rejection", "success"] as const) {
	test.each(["", "reload-session-id"])(`reload isolates writes (${outcome}, ID %j)`, async (id) => {
		const directory = mkdtempSync(join(tmpdir(), "reload-session-writes-"));
		const store = await JsonlSessionStore.open(directory, { exactDirectory: true });
		const otherStore = await JsonlSessionStore.open(join(directory, "other"), { exactDirectory: true });
		const header = { id, version: 4 as const, createdAt: new Date().toISOString(), cwd: directory };
		await store.create(header, []);
		await otherStore.create(header, []);
		const manager = await SessionManager.open(store, id);
		const target = await manager.appendCustomEntry("original", {});
		await manager.appendSessionInfo("original name");
		await manager.appendLabelChange(target, "original label");
		let loaded = await createTestExtensionsResult([]);
		const loader = createTestResourceLoader({ extensionsResult: loaded });
		loader.getExtensions = () => loaded;
		const harness = await createHarness({ sessionManager: manager, resourceLoader: loader });
		const baseline = manager.getEntries();
		let isolatedDuringStartup = false;
		let reopenedStore: JsonlSessionStore | undefined;
		const factory: ExtensionFactory = (pi) => {
			pi.on("session_start", async () => {
				await pi.appendEntry("candidate entry", { saved: true });
				await pi.setSessionName("candidate name");
				await pi.setLabel(target, "candidate label");
				await pi.appendEntry("candidate tail", { saved: true });
				isolatedDuringStartup =
					manager.getEntries().length === baseline.length &&
					harness.eventsOfType("entry_appended").length === 0 &&
					harness.eventsOfType("session_info_changed").length === 0;
				if (outcome === "startup-rejection") throw new Error("candidate startup rejected");
			});
		};
		loader.prepareReload = async () => {
			const candidate = await createTestExtensionsResult([factory]);
			return {
				loader: createTestResourceLoader({ extensionsResult: candidate }),
				activate: () => {},
				commit: () => {
					if (outcome === "publication-rejection") throw new Error("candidate publication rejected");
					loaded = candidate;
				},
			};
		};
		try {
			await harness.session.bindExtensions({});
			const original = harness.session.extensionRunner;
			if (outcome === "success") {
				await harness.session.reload();
				assert.notEqual(harness.session.extensionRunner, original);
			} else {
				await assert.rejects(harness.session.reload(), /candidate .* rejected|Extension startup failed/);
				assert.equal(harness.session.extensionRunner, original);
			}
			reopenedStore = await JsonlSessionStore.open(directory, { exactDirectory: true });
			const reopened = await SessionManager.open(reopenedStore, id);
			assert.equal(reopened.getSessionId(), id);
			assert.deepEqual((await otherStore.load(id)).entries, []);
			if (outcome === "success") {
				assert.deepEqual(
					reopened
						.getEntries()
						.slice(baseline.length)
						.map((entry) => entry.type),
					["custom", "session_info", "label", "custom"],
				);
				assert.equal(reopened.getSessionName(), "candidate name");
				assert.equal(reopened.getLabel(target), "candidate label");
				assert.equal(harness.eventsOfType("entry_appended").length, 2);
				assert.equal(harness.eventsOfType("session_info_changed").length, 1);
			} else {
				assert.deepEqual(reopened.getEntries(), baseline);
				assert.equal(reopened.getSessionName(), "original name");
				assert.equal(reopened.getLabel(target), "original label");
				assert.equal(harness.eventsOfType("entry_appended").length, 0);
				assert.equal(harness.eventsOfType("session_info_changed").length, 0);
			}
			assert.equal(isolatedDuringStartup, true, "candidate writes and notifications stay isolated during startup");
		} finally {
			await harness.cleanup();
			await store.close();
			await otherStore.close();
			await reopenedStore?.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});
}
