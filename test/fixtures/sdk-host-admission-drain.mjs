import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@bastani/atomic";

// #3105: bounded observations of actual built preflight/reload drain, never timeout-as-success.
assert.equal(process.versions.bun, undefined);
assert.ok(import.meta.resolve("@bastani/atomic").endsWith("/dist/index.js"));
const root = mkdtempSync(join(tmpdir(), "atomic-admission-drain-"));
const scenario = process.argv[2];
assert.ok(["prompt", "reload", "compact"].includes(scenario));
const entered = Promise.withResolvers();
const release = Promise.withResolvers();
const settingsManager = SettingsManager.inMemory();
const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null });
await modelRuntime.setRuntimeApiKey("anthropic", "fixture-only", {});
const active = new Set();
const history = [];
let factories = 0;
const resourceLoader = new DefaultResourceLoader({
	cwd: root, agentDir: join(root, "agent"), settingsManager,
	noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
	extensionFactories: [(atomic) => {
		const id = ++factories;
		atomic.on("session_start", () => { active.add(id); history.push(["start", id]); });
		atomic.on("session_shutdown", () => { active.delete(id); history.push(["stop", id]); });
		if (scenario === "prompt") atomic.on("before_agent_start", async () => { entered.resolve(); await release.promise; });
		if (scenario === "compact") atomic.on("session_before_compact", async () => { entered.resolve(); await release.promise; return { compactedText: "retained" }; });
	}],
});
const { session } = await createAgentSession({
	cwd: root, agentDir: join(root, "agent"), settingsManager, modelRuntime,
	model: modelRuntime.getModels("anthropic")[0], resourceLoader, sessionManager: SessionManager.inMemory(root),
	builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
});
let providerCalls = 0;
modelRuntime.streamSimple = () => {
	providerCalls++;
	throw new Error("provider sentinel");
};
await session.sessionManager.appendMessage({ role: "user", content: Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n"), timestamp: 0 });
const before = session.sessionManager.getEntries().length;
const operation = scenario === "compact" ? session.compact() : scenario === "prompt" ? session.prompt("verbatim  ") : session.reload({
	beforeSessionStart: async () => { entered.resolve(); await release.promise; },
});
const result = operation.then(() => undefined, (error) => error);
try {
	await entered.promise;
	let closed = false;
	const closing = session.dispose();
	void closing.then(() => { closed = true; });
	assert.equal(session.dispose(), closing);
	await tick();
	assert.equal(closed, false, "cleanup must remain pending until the admitted callback settles");
	release.resolve();
	await closing;
	const error = await result;
	assert.equal(error?.code, "SessionClosed");
	assert.equal(providerCalls, 0);
	if (scenario === "compact") {
		assert.equal(session.sessionManager.getEntries().length, before);
		await assert.rejects(session.compact(), { code: "SessionClosed" });
	}
	assert.equal(active.size, 0);
	if (scenario === "reload") assert.ok(!history.some(([event, id]) => event === "start" && id === 2));
	assert.equal(session.dispose(), closing);
	console.log(JSON.stringify({ scenario, drained: true, providerCalls, active: active.size }));
} finally {
	release.resolve();
	await result;
	await session.dispose();
	rmSync(root, { recursive: true, force: true });
}
