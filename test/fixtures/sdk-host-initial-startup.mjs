import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { Agent } from "@earendil-works/pi-agent-core";
import { AgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@bastani/atomic";

// #3105: direct public construction must drain initial binding, not only SDK startup.
const root = mkdtempSync(join(tmpdir(), "atomic-initial-start-"));
const failure = process.argv[2] ?? "none";
const entered = Promise.withResolvers();
const release = Promise.withResolvers();
const settingsManager = SettingsManager.inMemory();
const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null });
let active = false;
let shutdowns = 0;
const resourceLoader = new DefaultResourceLoader({
	cwd: root, agentDir: root, settingsManager, noExtensions: true, noSkills: true, noThemes: true,
	noContextFiles: true, noPromptTemplates: true,
	extensionFactories: [(pi) => {
		pi.on("session_start", async () => {
			entered.resolve();
			await release.promise;
			active = true;
			if (failure === "startup") throw new Error("initial startup failed");
		});
		pi.on("session_shutdown", () => {
			shutdowns++;
			active = false;
			if (failure === "cleanup") throw new Error("initial cleanup failed");
		});
	}],
});
await resourceLoader.reload();
const session = new AgentSession({ agent: new Agent({ streamFn: () => { throw new Error("Startup fixture must not invoke a model"); } }), sessionManager: SessionManager.inMemory(root), settingsManager, cwd: root, modelRuntime, resourceLoader });
const startup = session.bindExtensions({}).catch((error) => error);
await entered.promise;
let settled = false;
const close = session.dispose();
const closed = close.then(() => { settled = true; }, (error) => { settled = true; return error; });
await tick();
await tick();
assert.equal(settled, false, "close must wait for independently released startup");
assert.equal(shutdowns, 0);
release.resolve();
const startError = await startup;
const closeError = await closed;
assert.ok(startError instanceof Error);
assert.equal(active, false);
assert.equal(shutdowns, 1);
assert.equal(session.dispose(), close);
if (failure === "cleanup") assert.equal(closeError?.code, "ShutdownFailed");
else assert.equal(closeError, undefined);
console.log(JSON.stringify({ drained: true, active, shutdowns, failure }));
rmSync(root, { recursive: true, force: true });
