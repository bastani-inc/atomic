import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, createEventBus, DefaultResourceLoader, SessionManager, SettingsManager } from "@bastani/atomic";

// #3105: two sessions sharing a bus must not retire each other's extension resources.
assert.equal(process.versions.bun, undefined);
assert.ok(import.meta.resolve("@bastani/atomic").endsWith("/dist/index.js"));
const root = mkdtempSync(join(tmpdir(), "atomic-shared-bus-"));
const eventBus = createEventBus();
const scopes = [];
const deliveries = [];
const kind = process.argv[2] ?? "bus";
const shared = kind !== "bus";
const policy = "Respect caller custom loader policy  \n";
class HostLoader extends DefaultResourceLoader {
	getSystemPrompt() { return policy; }
}
const settingsManager = SettingsManager.inMemory();
let borrowedLoader;
async function create(name) {
	const cwd = join(root, shared ? "shared" : name);
	mkdirSync(cwd, { recursive: true });
	let resourceLoader = borrowedLoader ?? new (kind === "subclass" ? HostLoader : DefaultResourceLoader)({
		cwd, agentDir: join(cwd, "agent"), settingsManager, eventBus, noExtensions: true, noContextFiles: true,
		extensionFactories: [(pi) => { pi.on("session_start", () => {
			scopes.push(pi.lifecycleScope);
			pi.events.on("sibling-check", () => { deliveries.push(pi.lifecycleScope); });
		}); }],
	});
	if (!borrowedLoader) await resourceLoader.reload();
	if (!borrowedLoader && kind === "facade") {
		const delegate = resourceLoader;
		resourceLoader = Object.fromEntries([
			"getExtensions", "getSkills", "getSkillCatalog", "getPrompts", "getThemes", "getAgentsFiles",
			"getSystemPrompt", "getSystemPromptSource", "getAppendSystemPrompt", "getAppendSystemPromptSources",
			"extendResources", "reload", "supportsTransactionalReload", "prepareReload",
		].filter((key) => typeof delegate[key] === "function").map((key) => [key, delegate[key].bind(delegate)]));
	}
	if (shared) borrowedLoader = resourceLoader;
	return (await createAgentSession({
		cwd, agentDir: join(cwd, "agent"), settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(cwd),
		builtins: { subagents: false, mcp: false, intercom: false, "web-access": false },
	})).session;
}
const a = await create("a");
let b;
try {
	b = await create("b");
	assert.notEqual(scopes[0], scopes[1]);
	if (kind === "subclass") assert.equal(a.resourceLoader.getSystemPrompt(), policy);
	const delivered = async () => {
		deliveries.length = 0;
		eventBus.emit("sibling-check", {});
		await new Promise(resolve => setImmediate(resolve));
		return [...deliveries];
	};
	assert.deepEqual(await delivered(), [scopes[0], scopes[1]]);
	await b.reload();
	assert.equal(scopes[2], scopes[1]);
	await b.dispose();
	assert.deepEqual(await delivered(), [scopes[0]], "closing the sibling leaves the first listener live");
	await a.reload();
	assert.equal(scopes[3], scopes[0]);
	if (kind === "subclass") assert.equal(a.resourceLoader.getSystemPrompt(), policy);
	assert.deepEqual(await delivered(), [scopes[0]], "reload replaces the listener without duplicating it");
	console.log(JSON.stringify({ distinctOwners: true, siblingReloadedAndClosed: true, retainedListener: true }));
} finally {
	await a.dispose();
	await b?.dispose();
	rmSync(root, { recursive: true, force: true });
}
