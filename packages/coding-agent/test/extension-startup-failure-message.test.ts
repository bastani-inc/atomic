import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { ModelRuntime } from "../src/core/model-runtime.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { ExtensionStartupError } from "../src/index.js";

const CAUSE = "Cannot read properties of undefined (reading 'fg')";

async function startupFailureOf(extensionFactories: ((pi: ExtensionFactoryApi) => void)[]): Promise<unknown> {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-startup-failure-message-"));
	try {
		const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null });
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir: join(cwd, "agent"),
			settingsManager: SettingsManager.inMemory(),
			noExtensions: true,
			noContextFiles: true,
			extensionFactories,
		});
		await loader.reload();
		try {
			await createAgentSession({
				cwd,
				agentDir: join(cwd, "agent"),
				resourceLoader: loader,
				modelRuntime,
				sessionManager: SessionManager.inMemory(cwd),
				extensionBindings: { mode: "rpc" },
			});
		} catch (error) {
			return error;
		}
		throw new Error("session creation did not fail");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

type ExtensionFactoryApi = Parameters<
	NonNullable<ConstructorParameters<typeof DefaultResourceLoader>[0]["extensionFactories"]>[number]
>[0];

test("a session_start failure names the failing extension and its cause on every string surface (#3807)", async () => {
	const error = await startupFailureOf([
		(pi) => {
			pi.on("session_start", () => {
				throw new TypeError(CAUSE);
			});
		},
	]);

	assert.ok(error instanceof ExtensionStartupError);
	assert.equal(error.failures.length, 1);
	assert.deepEqual(JSON.parse(JSON.stringify(error.failures)), [
		{ extensionPath: "<inline:1>", event: "session_start", message: CAUSE },
	]);
	const expected = `Extension startup failed: <inline:1>: ${CAUSE}`;
	assert.equal(error.message, expected);
	assert.equal(String(error), `ExtensionStartupError: ${expected}`);
	assert.deepEqual(
		error.errors.map((member) => (member as Error).message),
		[`<inline:1>: ${CAUSE}`],
	);
});

test("every failing extension is named in one startup error, in load order (#3807)", async () => {
	const error = await startupFailureOf([
		(pi) => {
			pi.on("session_start", () => {
				throw new TypeError(CAUSE);
			});
		},
		(pi) => {
			pi.on("session_start", () => {
				throw new Error("second extension failed");
			});
		},
	]);

	assert.ok(error instanceof ExtensionStartupError);
	assert.deepEqual(
		error.failures.map((failure) => [failure.extensionPath, failure.message]),
		[
			["<inline:1>", CAUSE],
			["<inline:2>", "second extension failed"],
		],
	);
	assert.equal(error.message, `Extension startup failed: <inline:1>: ${CAUSE}; <inline:2>: second extension failed`);
});
