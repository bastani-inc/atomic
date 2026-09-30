// #3105: built Node lifecycle boundaries; no forced exit or private teardown.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick, setTimeout as delay } from "node:timers/promises";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	AgentSession, createAgentSession, createEventBus, DefaultResourceLoader,
	ModelRuntime, SessionManager, SettingsManager,
} from "../../packages/coding-agent/dist/index.js";

const mode = process.argv[2];
const cwd = mkdtempSync(join(tmpdir(), "sdk-cleanup-boundaries-"));
const settingsManager = SettingsManager.inMemory({ sessionSummary: { enabled: false } });
const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth"), modelsPath: null, allowModelNetwork: false });
const builtins = { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false };
const options = { cwd, agentDir: cwd, settingsManager, modelRuntime, tools: [], builtins, sessionManager: SessionManager.inMemory(cwd) };
let session;
let child;
let restore = () => {};
let release = () => {};
const defer = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const causes = (error) => error instanceof AggregateError ? [error, ...error.errors.flatMap(causes)] : error?.cause ? [error, ...causes(error.cause)] : [error];
try {
	if (mode.startsWith("getter-")) {
		const primary = new Error("extension view unavailable");
		const cleanup = new Error("acquisition cleanup failed");
		let unavailable = false;
		let generation = 0;
		const active = new Set();
		const stopped = [];
		restore = () => { unavailable = false; };
		class Loader extends DefaultResourceLoader {
			supportsTransactionalReload() { return mode.includes("transaction"); }
			getExtensions() { if (unavailable) throw primary; return super.getExtensions(); }
			async reload() { await super.reload(); if (generation > 1 && mode !== "getter-control" && mode !== "getter-after-transfer") unavailable = true; }
			async prepareReload() { await this.reload(); throw primary; }
		}
		const resourceLoader = new Loader({ cwd, agentDir: cwd, settingsManager, noExtensions: true, extensionFactories: [(pi) => {
			const id = ++generation;
			active.add(id);
			pi.on("session_shutdown", () => { active.delete(id); stopped.push(id); if (mode.endsWith("cleanup") && id > 1) throw cleanup; });
		}] });
		let error;
		if (mode === "getter-creation") {
			// Custom discovery is caller-preloaded; only replayed factories belong to creation.
			await resourceLoader.reload();
			await createAgentSession({ ...options, resourceLoader, systemPromptTransform() { unavailable = true; throw primary; } }).then((result) => { session = result.session; }, (failure) => { error = failure; });
		} else {
			await resourceLoader.reload();
			session = new AgentSession({ agent: new Agent({ streamFn: () => { throw new Error("Cleanup fixture must not invoke a model"); } }), cwd, settingsManager, modelRuntime, resourceLoader, sessionManager: options.sessionManager });
			await session.bindExtensions({});
			await session.reload({ beforeSessionStart() { if (mode === "getter-after-transfer") { unavailable = true; throw primary; } } }).catch((failure) => { error = failure; });
		}
		restore();
		if (mode === "getter-control") assert.equal(error, undefined);
		else { assert.ok(causes(error).includes(primary)); if (mode.endsWith("cleanup")) assert.ok(causes(error).includes(cleanup)); }
		assert.deepEqual([...active], mode.includes("transaction") || mode === "getter-creation" ? [1] : mode === "getter-control" || mode === "getter-after-transfer" ? [2] : []);
		const closed = await session?.dispose().catch((failure) => failure);
		if (mode.endsWith("cleanup")) assert.equal(closed.code, "ShutdownFailed");
		else assert.equal(closed, undefined);
		assert.deepEqual([...active], mode === "getter-creation" ? [1] : []);
		assert.ok(stopped.includes(2));
	} else if (mode.startsWith("spawn-")) {
		const started = defer();
		let generation = 0;
		let completed = false;
		let settled = false;
		let cleanupAPI;
		let freshDeliveries = 0;
		const eventBus = createEventBus();
		const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, eventBus, noExtensions: true, extensionFactories: [(pi) => {
			const id = ++generation;
			pi.events.on("fresh-during-cleanup", () => { freshDeliveries++; });
			pi.on("session_shutdown", async () => {
				if (mode.startsWith("spawn-candidate") && id === 1) return;
				cleanupAPI = pi;
				child = pi.exec(process.execPath, ["-e", 'const fs=require("node:fs");fs.writeFileSync("started","");const t=setInterval(()=>{if(fs.existsSync("release")){clearInterval(t);process.stdout.write("complete");}},10);']);
				void child.then(() => { settled = true; });
				while (!existsSync(join(cwd, "started"))) await delay(10);
				started.resolve();
				if (mode.endsWith("control")) await child;
				if (mode.endsWith("error")) throw new Error("shutdown primary");
			});
			if (mode === "spawn-factory") throw new Error("factory primary");
			if (mode.startsWith("spawn-candidate") && id > 1) pi.on("session_start", () => { throw new Error("startup primary"); });
		}] });
		const creating = createAgentSession({ ...options, resourceLoader });
		const operation = creating.then(async (result) => {
			session = result.session;
			if (mode === "spawn-factory") return;
			if (mode.startsWith("spawn-candidate")) await session.reload();
			else await session.dispose();
		});
		const outcome = operation.then(() => { completed = true; }, (error) => { completed = true; return error; });
		await started.promise;
		await delay(40);
		const premature = completed;
		assert.equal(settled, false);
		assert.throws(() => cleanupAPI.events.on("new-subscription", () => {}), /closed|stale|no longer active/i);
		eventBus.emit("fresh-during-cleanup");
		await tick();
		assert.equal(freshDeliveries, 0);
		const closing = mode.startsWith("spawn-candidate") ? session.dispose().catch((error) => error) : undefined;
		writeFileSync(join(cwd, "release"), "");
		assert.equal((await child).stdout, "complete");
		const error = await outcome;
		const closeError = await closing;
		assert.equal(premature, false, "teardown returned while cleanup child was live");
		if (mode.endsWith("error")) { assert.equal(error.code, "ShutdownFailed"); assert.match(causes(error).map(String).join("\n"), /shutdown primary/); }
		if (mode.startsWith("spawn-candidate")) assert.match(causes(error).map(String).join("\n"), /startup primary/);
		if (mode === "spawn-candidate-error") assert.equal(closeError.code, "ShutdownFailed");
	} else if (mode.startsWith("release-")) {
		assert.equal(typeof global.gc, "function", "run this fixture with --expose-gc");
		const bus = createEventBus();
		let released = 0;
		// Precreate the injected fault: V8 lazy Error stacks can themselves retain
		// throwing callback frames until inspected, independently of release ledgers.
		const releaseError = new Error("release failed");
		const eventBus = { emit: bus.emit, on(channel, handler) {
			const unsubscribe = bus.on(channel, handler);
			return () => { unsubscribe(); released++; if (mode.endsWith("throwing")) throw releaseError; };
		} };
		let api;
		const held = defer();
		const entered = defer();
		release = held.resolve;
		const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, eventBus, noExtensions: true, extensionFactories: [(pi) => {
			api = pi;
			pi.on("session_shutdown", async () => { entered.resolve(); await held.promise; });
		}] });
		({ session } = await createAgentSession({ ...options, resourceLoader }));
		const handles = [];
		const weak = Array.from({ length: 100 }, (_, index) => {
			const payload = { bytes: new Uint8Array(100_000) };
			const ref = new WeakRef(payload);
			handles.push(api.events.on(`ephemeral-${index}`, () => assert.ok(payload.bytes)));
			return ref;
		});
		const publisher = api.registerWorkflowActivityPublisher();
		const lifetime = session.resourceLoader.getExtensions().extensions[0][Symbol.for("atomic.extension-api-lifetime.v1")];
		assert.equal(lifetime.releases.size, 101);
		const closing = session.dispose().then(() => undefined, (error) => error);
		await entered.promise;
		if (!mode.startsWith("release-invalidate")) {
			for (const unsubscribe of handles) {
				if (mode === "release-throwing") assert.throws(unsubscribe, /release failed/);
				else unsubscribe();
				unsubscribe();
			}
			publisher.dispose();
			assert.equal(lifetime.releases.size, 0);
			for (let n = 0; n < 8; n++) { await tick(); global.gc(); }
			assert.equal(weak.filter((ref) => ref.deref()).length, 0, "manual release retained callback captures");
		}
		release();
		const closeError = await closing;
		if (mode === "release-invalidate-throwing") {
			assert.equal(closeError.code, "ShutdownFailed");
			assert.ok(causes(closeError).includes(releaseError));
		}
		else assert.equal(closeError, undefined);
		for (let n = 0; n < 8; n++) { await tick(); global.gc(); }
		assert.equal(weak.filter((ref) => ref.deref()).length, 0, "disposed session retained callback captures");
		assert.equal(lifetime.releases.size, 0);
		assert.equal(released, 100);
		for (const unsubscribe of handles) unsubscribe();
		publisher.dispose();
		assert.equal(released, 100);
	} else throw new Error(`Unknown scenario: ${mode}`);
	console.log(JSON.stringify({ mode, verified: true }));
} finally {
	restore();
	release();
	writeFileSync(join(cwd, "release"), "");
	await child?.catch(() => {});
	await session?.dispose().catch(() => {});
	rmSync(cwd, { recursive: true, force: true });
}
