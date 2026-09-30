// #3105: real built exports, independent releases, natural exit (no private teardown).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Agent } from "@earendil-works/pi-agent-core";
import { AgentSession, createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "../../packages/coding-agent/dist/index.js";

const mode = process.argv[2];
const cwd = mkdtempSync(join(tmpdir(), "sdk-factory-rollback-"));
const settingsManager = SettingsManager.inMemory({ sessionSummary: { enabled: false } });
const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth"), modelsPath: null, allowModelNetwork: false });
const options = { cwd, agentDir: cwd, settingsManager, modelRuntime, sessionManager: SessionManager.inMemory(cwd), tools: [], builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false } };
const defer = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const held = defer(), entered = defer(), selectedWork = defer(), admitted = defer(), cleanupWork = defer();
const primary = new Error("factory primary"), cleanup = new Error("factory cleanup");
const live = new Set(), log = [];
const causes = (error) => error instanceof AggregateError ? [error, ...error.errors.flatMap(causes)] : error?.cause ? [error, ...causes(error.cause)] : [error];
let operation, session;
try {
	if (mode.startsWith("drain-")) {
		// File and inline factories use the same public API behavior; the file factory
		// receives this fixture state via a temporary module, not a production seam.
		const state = { held, entered, live, log, primary, cleanup, mode };
		const factory = async (pi, state) => {
			pi.on("session_shutdown", () => { state.log.push("shutdown"); for (const timer of state.live) clearInterval(timer); state.live.clear(); if (state.mode.endsWith("error")) throw state.cleanup; });
			pi.events.on("acquire", async () => {
				state.log.push("started"); state.entered.resolve(); await state.held.promise;
				pi.events.on("late-subscription", () => {});
				state.live.add(setInterval(() => {}, 1000)); state.log.push("acquired");
			});
			pi.events.emit("acquire", {});
			if (state.mode === "drain-control") { state.held.resolve(); await delay(10); }
			throw state.primary;
		};
		const key = `rollback-${cwd}`;
		globalThis[key] = state;
		const file = join(cwd, "factory.mjs");
		writeFileSync(file, `export default pi => (${factory.toString()})(pi, globalThis[${JSON.stringify(key)}]);`);
		const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, noExtensions: true,
			...(mode === "drain-path" ? { additionalExtensionPaths: [file] } : { extensionFactories: [(pi) => factory(pi, state)] }),
		});
		operation = createAgentSession({ ...options, resourceLoader }).then((result) => { session = result.session; }, (error) => error);
		await entered.promise; await delay(25);
		const before = [...log]; held.resolve();
		const error = await operation;
		delete globalThis[key];
		await session?.dispose();
		if (mode !== "drain-control") assert.deepEqual(before, ["started"]);
		assert.deepEqual(log, ["started", "acquired", "shutdown"]);
		assert.equal(live.size, 0);
		if (mode.endsWith("error")) { assert.ok(causes(error).includes(primary)); assert.ok(causes(error).includes(cleanup)); }
		else assert.equal(error, undefined);
	} else if (mode.startsWith("peer-")) {
		let generation = 0, deliveries = 0, peer;
		const reloading = mode === "peer-ordinary" || mode.startsWith("peer-transaction");
		class Loader extends DefaultResourceLoader {
			supportsTransactionalReload() { return mode.startsWith("peer-transaction"); }
			async reload() { await super.reload(); if (generation > 1) throw primary; }
			async prepareReload() { await this.reload(); throw primary; }
		}
		const LoaderClass = reloading || mode === "peer-replay" ? Loader : DefaultResourceLoader;
		const resourceLoader = new LoaderClass({ cwd, agentDir: cwd, settingsManager, noExtensions: true, extensionFactories: [
			(pi) => { const id = ++generation; peer = pi; pi.events.on("peer", () => { deliveries++; }); pi.on("session_shutdown", () => { log.push(`peer${id}`); }); },
			(pi) => { const id = generation; pi.on("session_shutdown", async () => { log.push(`held${id}`); if ((!reloading && mode !== "peer-replay") || id > 1) { entered.resolve(); await held.promise; } if (mode === "peer-error") throw cleanup; }); if (mode === "peer-replay" && id > 1) throw primary; },
		] });
		if (reloading || mode === "peer-replay") await resourceLoader.reload();
		if (reloading) { session = new AgentSession({ agent: new Agent({ streamFn: () => { throw new Error("Rollback fixture must not invoke a model"); } }), cwd, settingsManager, modelRuntime, resourceLoader, sessionManager: options.sessionManager }); await session.bindExtensions({}); }
		operation = (reloading ? session.reload() : createAgentSession({ ...options, resourceLoader, initialContextTransform() { throw primary; } })).then(() => undefined, (error) => error);
		await entered.promise;
		let closed = false, closing;
		if (mode === "peer-transaction-overlap") { await session.abort(); closing = session.dispose().then(() => { closed = true; }); await delay(25); assert.equal(closed, false, "terminal close escaped rollback"); }
		let execError, subscriptionError, emitError;
		try { await peer.exec(process.execPath, ["-e", "process.stdout.write('fresh')"]); } catch (error) { execError = error; }
		try { peer.events.on("fresh", () => {}); } catch (error) { subscriptionError = error; }
		try { peer.events.emit("peer", {}); } catch (error) { emitError = error; }
		held.resolve(); const error = await operation;
		await closing;
		assert.ok(execError, "closing peer admitted exec"); assert.ok(subscriptionError, "closing peer admitted subscription"); assert.ok(emitError, "closing peer admitted emission"); assert.equal(deliveries, 0);
		assert.ok(causes(error).includes(primary)); if (mode === "peer-error") assert.ok(causes(error).includes(cleanup));
		const id = reloading || mode === "peer-replay" ? 2 : 1;
		assert.equal(log.filter((entry) => entry === `peer${id}`).length, 1); assert.equal(log.filter((entry) => entry === `held${id}`).length, 1);
		if (mode === "peer-replay") assert.ok(!log.includes("peer1"));
	} else if (mode.startsWith("subset")) {
		let selected, omitted, other, unrelatedError, completed = false;
		const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, noExtensions: true, extensionFactories: [
			(pi) => { selected = pi; pi.events.on("selected", async () => { await selectedWork.promise; }); pi.events.emit("selected", {}); pi.on("session_start", () => { if (mode === "subset-startup") throw primary; }); },
			(pi) => { omitted = pi; pi.on("session_shutdown", () => { log.push("peer-shutdown"); for (const timer of live) clearInterval(timer); live.clear(); }); pi.events.on("omitted", async () => { admitted.resolve(); await held.promise; pi.events.on("late", () => {}); try { other.events.on("unrelated", () => {}); } catch (error) { unrelatedError = error; } live.add(setInterval(() => {}, 1000)); log.push("acquired"); }); pi.events.emit("omitted", {}); },
			(pi) => { other = pi; pi.on("session_shutdown", async () => { log.push("last-shutdown"); entered.resolve(); await cleanupWork.promise; }); },
		], extensionsOverride: (result) => ({ ...result, extensions: result.extensions.slice(0, 1) }) });
		operation = createAgentSession({ ...options, resourceLoader }).then((result) => { session = result.session; completed = true; }, (error) => { completed = true; return error; });
		await admitted.promise; await delay(25);
		assert.deepEqual(log, [], "all closing work must precede any shutdown");
		assert.equal((await selected.exec(process.execPath, ["-e", "process.stdout.write('selected')"])).stdout, "selected");
		held.resolve(); await entered.promise;
		assert.ok(unrelatedError); assert.throws(() => omitted.events.on("fresh", () => {}), /closed|stale/i);
		cleanupWork.resolve(); if (mode === "subset-startup") selectedWork.resolve();
		for (let i = 0; i < 100 && !completed; i++) await delay(10);
		assert.ok(completed, "omitted cleanup waited on selected work");
		const error = await operation;
		if (mode === "subset-startup") { assert.ok(error instanceof AggregateError); assert.ok(causes(error).some((cause) => cause.message.includes(primary.message))); } else assert.equal(error, undefined);
		assert.deepEqual(log, ["acquired", "last-shutdown", "peer-shutdown"]); assert.equal(live.size, 0);
		selectedWork.resolve(); await session?.dispose();
	} else throw new Error(`unknown scenario ${mode}`);
	console.log(JSON.stringify({ mode, verified: true, log }));
} finally {
	held.resolve(); selectedWork.resolve(); cleanupWork.resolve();
	await operation; await session?.dispose().catch(() => {});
	for (const timer of live) clearInterval(timer);
	rmSync(cwd, { recursive: true, force: true });
}
