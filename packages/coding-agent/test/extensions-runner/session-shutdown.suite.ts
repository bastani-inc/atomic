/** Tests for ExtensionRunner session shutdown lifecycle helpers. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { loadExtensions } from "../../src/core/extensions/loader.ts";
import { emitSessionBeforeShutdownEvent, ExtensionRunner } from "../../src/core/extensions/runner.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

describe("ExtensionRunner session_before_shutdown", () => {
	let tempDir: string;
	let extensionsDir: string;
	let sessionManager: SessionManager;
	let modelRegistry: ModelRegistry;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runner-session-shutdown-test-"));
		extensionsDir = path.join(tempDir, "extensions");
		fs.mkdirSync(extensionsDir);
		sessionManager = SessionManager.inMemory();
		const authStorage = AuthStorage.create(path.join(tempDir, "auth.json"));
		modelRegistry = ModelRegistry.create(authStorage);
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns cancellation from pre-shutdown handlers", async () => {
		const extPath = path.join(extensionsDir, "before-shutdown.ts");
		fs.writeFileSync(
			extPath,
			`export default function(pi) {
	pi.on("session_before_shutdown", (event) => ({ cancel: event.reason === "quit" }));
}`,
		);

		const result = await loadExtensions([extPath], tempDir);
		const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);

		expect(
			await emitSessionBeforeShutdownEvent(runner, { type: "session_before_shutdown", reason: "quit" }),
		).toEqual({ cancelled: true, emitted: true });
	});

	it("reports no emission when no pre-shutdown handlers are registered", async () => {
		const result = await loadExtensions([], tempDir);
		const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);

		expect(
			await emitSessionBeforeShutdownEvent(runner, { type: "session_before_shutdown", reason: "quit" }),
		).toEqual({ cancelled: false, emitted: false });
	});
});
