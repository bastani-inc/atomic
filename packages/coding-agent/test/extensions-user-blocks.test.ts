import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { discoverAndLoadExtensions } from "../src/core/extensions/loader.js";
import { ExtensionRunner } from "../src/core/extensions/runner.js";
import type { UserBlockChange } from "../src/core/extensions/types.js";
import * as userBlocksModule from "../src/core/extensions/user-blocks.js";
import {
	getActiveUserBlockLabel,
	getOpenUserBlocks,
	openUserBlock,
	subscribeUserBlocks,
} from "../src/core/extensions/user-blocks.js";
import { SessionManager } from "../src/core/session-manager.js";
import { createModelRegistry } from "./model-runtime-test-utils.js";
import { createHarness } from "./suite/harness.js";

const ASYNC_BLOCK_HANDLER_DELAY_MS = 150;
const BLOCK_EVENT_WAIT_TIMEOUT_MS = 5_000;

describe("user block door", () => {
	afterEach(() => {
		// Nothing should leak between tests; a leaked block would change the next
		// test's reported state.
		assert.deepEqual(getOpenUserBlocks(), []);
	});

	it("refcounts blocks and lets the oldest label win", () => {
		const first = openUserBlock("Trust project folder?", "project_trust");
		const second = openUserBlock("Approve edit?", "dialog");

		assert.equal(getOpenUserBlocks().length, 2);
		assert.equal(getActiveUserBlockLabel(), "Trust project folder?");

		second.release();
		assert.equal(getOpenUserBlocks().length, 1);
		assert.equal(getActiveUserBlockLabel(), "Trust project folder?");

		first.release();
		assert.equal(getOpenUserBlocks().length, 0);
		assert.equal(getActiveUserBlockLabel(), undefined);
	});

	it("promotes the next oldest when the oldest releases first", () => {
		const first = openUserBlock("A", "dialog");
		const second = openUserBlock("B", "dialog");
		first.release();
		assert.equal(getActiveUserBlockLabel(), "B");
		second.release();
	});

	it("has an idempotent release that is safe in a finally", () => {
		const changes: UserBlockChange[] = [];
		const unsubscribe = subscribeUserBlocks((change) => changes.push(change));
		try {
			const block = openUserBlock("Approve?", "dialog");
			assert.equal(block.released, false);
			block.release();
			block.release();
			block.release();
			assert.equal(block.released, true);
		} finally {
			unsubscribe();
		}

		assert.deepEqual(
			changes.map((change) => change.type),
			["agent_blocked", "agent_unblocked"],
		);
	});

	it("carries the reason sum type through open and release", () => {
		const changes: UserBlockChange[] = [];
		const unsubscribe = subscribeUserBlocks((change) => changes.push(change));
		try {
			for (const reason of ["dialog", "project_trust", "workflow_prompt", "supervisor_ask"] as const) {
				const block = openUserBlock(`label-${reason}`, reason);
				assert.equal(block.reason, reason);
				block.release();
			}
		} finally {
			unsubscribe();
		}
		assert.deepEqual(
			changes.filter((change) => change.type === "agent_blocked").map((change) => change.reason),
			["dialog", "project_trust", "workflow_prompt", "supervisor_ask"],
		);
	});

	it("reports open counts and the active label on every change", () => {
		const changes: UserBlockChange[] = [];
		const unsubscribe = subscribeUserBlocks((change) => changes.push(change));
		const first = openUserBlock("First", "dialog");
		const second = openUserBlock("Second", "dialog");
		second.release();
		first.release();
		unsubscribe();

		assert.deepEqual(
			changes.map((change) => [change.type, change.openBlocks, change.activeLabel]),
			[
				["agent_blocked", 1, "First"],
				["agent_blocked", 2, "First"],
				["agent_unblocked", 1, "First"],
				["agent_unblocked", 0, undefined],
			],
		);
	});

	it("exposes no way to end a block without its handle", () => {
		// Exported names are checked directly: a release-by-id or release-all
		// entry point would let one caller end another caller's wait.
		const exported = Object.keys(userBlocksModule).sort();
		assert.deepEqual(exported, [
			"getActiveUserBlockLabel",
			"getOpenUserBlocks",
			"openUserBlock",
			"subscribeUserBlocks",
		]);
		const block = openUserBlock("Only handle", "dialog");
		const snapshot = getOpenUserBlocks()[0];
		assert.equal(snapshot?.id, block.id);
		// A snapshot is data, not a handle.
		assert.equal(Object.hasOwn(snapshot ?? {}, "release"), false);
		block.release();
	});

	it("contains a throwing subscriber", () => {
		const unsubscribe = subscribeUserBlocks(() => {
			throw new Error("subscriber exploded");
		});
		try {
			const block = openUserBlock("Approve?", "dialog");
			block.release();
			assert.deepEqual(getOpenUserBlocks(), []);
		} finally {
			unsubscribe();
		}
	});
});

describe("agent_blocked and agent_unblocked events", () => {
	let tempDir: string;
	let extensionsDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-blocks-test-"));
		extensionsDir = path.join(tempDir, "extensions");
		fs.mkdirSync(extensionsDir);
	});

	afterEach(() => fs.rmSync(tempDir, { recursive: true, force: true }));

	async function createRunner(source: string): Promise<ExtensionRunner> {
		fs.writeFileSync(path.join(extensionsDir, "e0.ts"), source);
		const result = await discoverAndLoadExtensions([], tempDir, tempDir);
		const sessionManager = SessionManager.inMemory();
		const modelRegistry = await createModelRegistry(AuthStorage.create(path.join(tempDir, "auth.json")));
		return new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
	}

	async function waitFor(predicate: () => boolean, label: string): Promise<void> {
		const deadline = Date.now() + BLOCK_EVENT_WAIT_TIMEOUT_MS;
		while (!predicate()) {
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
	}

	it("publishes agent_blocked and agent_unblocked to extension handlers", async () => {
		const runner = await createRunner(`
			export default (pi) => {
				globalThis.__blockEvents = [];
				pi.on("agent_blocked", (event) => {
					globalThis.__blockEvents.push(["blocked", event.label, event.reason, event.openBlocks]);
				});
				pi.on("agent_unblocked", (event) => {
					globalThis.__blockEvents.push(["unblocked", event.label, event.reason, event.openBlocks]);
				});
			};
		`);
		try {
			const block = openUserBlock("Approve edit?", "dialog");
			await waitFor(() => readBlockEvents().length === 1, "agent_blocked");
			block.release();
			await waitFor(() => readBlockEvents().length === 2, "agent_unblocked");

			assert.deepEqual(readBlockEvents(), [
				["blocked", "Approve edit?", "dialog", 1],
				["unblocked", "Approve edit?", "dialog", 0],
			]);
		} finally {
			runner.detachUserBlocks();
			delete globalThisRecord().__blockEvents;
		}
	});

	it("serializes block events for async handlers", async () => {
		const runner = await createRunner(`
			export default (pi) => {
				globalThis.__blockEvents = [];
				pi.on("agent_blocked", async (event) => {
					await new Promise((resolve) => setTimeout(resolve, ${ASYNC_BLOCK_HANDLER_DELAY_MS}));
					globalThis.__blockEvents.push(["blocked", event.openBlocks, event.activeLabel]);
				});
				pi.on("agent_unblocked", (event) => {
					globalThis.__blockEvents.push(["unblocked", event.openBlocks, event.activeLabel]);
				});
			};
		`);
		try {
			const block = openUserBlock("Approve edit?", "dialog");
			block.release();
			await waitFor(() => readBlockEvents().length === 2, "serialized block events");

			assert.deepEqual(readBlockEvents(), [
				["blocked", 1, "Approve edit?"],
				["unblocked", 0, undefined],
			]);
		} finally {
			runner.detachUserBlocks();
			delete globalThisRecord().__blockEvents;
		}
	});

	it("detaches outgoing runners when the runtime is rebuilt", async () => {
		const events: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_blocked", () => events.push("blocked"));
					pi.on("agent_unblocked", () => events.push("unblocked"));
				},
			],
		});
		try {
			const session = harness.session as unknown as {
				_buildRuntime(options: { activeToolNames?: string[]; includeAllExtensionTools?: boolean }): void;
				getActiveToolNames(): string[];
			};
			const rebuild = () =>
				session._buildRuntime({
					activeToolNames: session.getActiveToolNames(),
					includeAllExtensionTools: true,
				});

			rebuild();
			rebuild();

			const block = openUserBlock("Approve edit?", "dialog");
			block.release();
			await waitFor(() => events.length >= 2, "rebuilt block events");

			assert.deepEqual(events, ["blocked", "unblocked"]);
		} finally {
			harness.cleanup();
		}
	});

	it("stops publishing to a detached runner", async () => {
		const runner = await createRunner(`
			export default (pi) => {
				globalThis.__blockEvents = [];
				pi.on("agent_blocked", (event) => { globalThis.__blockEvents.push(["blocked", event.label]); });
			};
		`);
		try {
			runner.detachUserBlocks();
			const block = openUserBlock("Approve edit?", "dialog");
			block.release();
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.deepEqual(readBlockEvents(), []);
		} finally {
			delete globalThisRecord().__blockEvents;
		}
	});

	it("stops publishing after invalidation", async () => {
		const runner = await createRunner(`
			export default (pi) => {
				globalThis.__blockEvents = [];
				pi.on("agent_blocked", (event) => { globalThis.__blockEvents.push(["blocked", event.label]); });
			};
		`);
		try {
			runner.invalidate();
			const block = openUserBlock("Approve edit?", "dialog");
			block.release();
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.deepEqual(readBlockEvents(), []);
		} finally {
			delete globalThisRecord().__blockEvents;
		}
	});
});

interface BlockEventGlobal {
	__blockEvents?: Array<Array<string | number | undefined>>;
}

function globalThisRecord(): BlockEventGlobal {
	return globalThis as BlockEventGlobal;
}

function readBlockEvents(): Array<Array<string | number | undefined>> {
	return globalThisRecord().__blockEvents ?? [];
}
