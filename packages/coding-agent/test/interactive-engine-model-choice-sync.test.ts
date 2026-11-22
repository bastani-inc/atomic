import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, test } from "vitest";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { IsolatedInteractiveRuntime } from "../src/modes/interactive-engine/isolated-runtime.ts";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import { createEngineHostPair, type EngineHostPair } from "./helpers/in-process-engine-pair.ts";
import { createHarness } from "./suite/harness.ts";

const pairs: EngineHostPair[] = [];

afterEach(async () => {
	while (pairs.length > 0) await pairs.pop()?.cleanup();
});

async function modelPair(changeLevelOnSelect = false) {
	const pair = await createEngineHostPair({
		models: [
			{ id: "current-model", reasoning: true },
			{ id: "other-model", reasoning: true },
		],
		engineExtensions: changeLevelOnSelect
			? [
					(atomic) => {
						atomic.on("model_select", () => atomic.setThinkingLevel("low"));
					},
				]
			: [],
	});
	pairs.push(pair);
	await pair.engine.session.bindExtensions({ shutdownHandler: () => {} });
	await pair.runtime.session.bindExtensions({ shutdownHandler: () => {} });
	await pair.engine.session.setThinkingLevel("medium");
	await pair.runtime.initializeFromEngine();
	await pair.drain();
	return pair;
}

test.each([false, true])(
	"model cycling keeps a newer engine thinking level with persist %s (#5237)",
	async (persist) => {
		const pair = await modelPair(true);
		const result = await pair.runtime.session.cycleModel("forward", { persist });
		await pair.drain();

		assert.deepEqual(Object.keys(result ?? {}).sort(), ["isScoped", "model", "thinkingLevel"]);
		assert.equal(result?.model.id, "other-model");
		assert.equal(result?.thinkingLevel, "medium");
		assert.equal(result?.isScoped, false);
		assert.equal(pair.engine.session.thinkingLevel, "low");
		assert.equal(pair.runtime.session.thinkingLevel, "low");
		if (persist) {
			assert.equal(pair.engine.settingsManager.getDefaultThinkingLevel(), "medium");
			assert.equal(pair.hostHarness.settingsManager.getDefaultThinkingLevel(), "medium");
		}
	},
);

test.each([false, true])(
	"model selection persists the applied level with an explicit choice %s (#5237)",
	async (explicit) => {
		const pair = await modelPair(true);
		await pair.runtime.session.setThinkingLevel("high");
		const other = pair.engine.getModel("other-model")!;
		await pair.runtime.session.setModel(other, {
			persist: true,
			...(explicit ? { thinkingLevel: "high" as const } : {}),
		});
		await pair.drain();

		assert.equal(pair.engine.session.thinkingLevel, "low");
		assert.equal(pair.runtime.session.thinkingLevel, "low");
		for (const settings of [pair.engine.settingsManager, pair.hostHarness.settingsManager]) {
			assert.equal(settings.getModelThinkingLevel(other.provider, other.id), "high");
			assert.equal(settings.getDefaultThinkingLevel(), "high");
		}
	},
);

test("model selection does not persist a transient thinking change after its answer (#5237)", async () => {
	const pair = await modelPair();
	const other = pair.engine.getModel("other-model")!;
	const answered = Promise.withResolvers<void>();
	pair.holdHostTrafficFrom((record) => {
		const matches = record.type === "response" && record.command === "set_model";
		if (matches) answered.resolve();
		return matches;
	});
	const selection = pair.runtime.session.setModel(other, { persist: true, thinkingLevel: "high" });
	try {
		await answered.promise;
		await pair.engine.session.setThinkingLevel("medium");
		await pair.drain();
	} finally {
		await pair.releaseHostTraffic();
		await selection;
	}
	await pair.drain();

	assert.equal(pair.engine.session.thinkingLevel, "medium");
	assert.equal(pair.runtime.session.thinkingLevel, "medium");
	for (const settings of [pair.engine.settingsManager, pair.hostHarness.settingsManager]) {
		assert.equal(settings.getModelThinkingLevel(other.provider, other.id), "high");
		assert.equal(settings.getDefaultThinkingLevel(), "high");
	}
});

test.each(["set", "cycle"] as const)(
	"a %s answer keeps a newer engine model in the same read (#5237)",
	async (operation) => {
		const pair = await modelPair();
		const current = pair.engine.getModel("current-model")!;
		const other = pair.engine.getModel("other-model")!;
		const answered = Promise.withResolvers<void>();
		pair.holdHostTrafficFrom((record) => {
			const matches = record.type === "response" && record.command === `${operation}_model`;
			if (matches) answered.resolve();
			return matches;
		});
		const selection =
			operation === "set" ? pair.runtime.session.setModel(other) : pair.runtime.session.cycleModel("forward");
		try {
			await answered.promise;
			await pair.engine.session.setModel(current);
			await pair.drain();
		} finally {
			await pair.releaseHostTraffic();
			await selection;
		}
		await pair.drain();

		assert.equal(pair.engine.session.model?.id, current.id);
		assert.equal(pair.runtime.session.model?.id, current.id);
	},
);

test.each(["setThinkingLevel", "cycleThinkingLevel", "engineMutation"] as const)(
	"an engine resync does not overwrite a newer %s state (#5237)",
	async (kind) => {
		const pair = await modelPair();
		const other = pair.engine.getModel("other-model")!;
		const stateHeld = Promise.withResolvers<void>();
		pair.holdHostTrafficFrom((record) => {
			const matches = record.type === "response" && record.command === "get_state";
			if (matches) stateHeld.resolve();
			return matches;
		});

		const resync = pair.runtime.initializeFromEngine();
		await stateHeld.promise;

		let pendingHostChange: Promise<unknown> | undefined;
		if (kind === "setThinkingLevel") {
			pendingHostChange = pair.runtime.session.setThinkingLevel("high");
		} else if (kind === "cycleThinkingLevel") {
			pendingHostChange = pair.runtime.session.cycleThinkingLevel();
		} else {
			await pair.engine.session.setModel(other);
			await pair.engine.session.setThinkingLevel("high");
		}

		await pair.releaseHostTraffic();
		await Promise.all([resync, pendingHostChange]);
		await pair.drain();

		assert.equal(pair.runtime.session.model?.id, pair.engine.session.model?.id);
		assert.equal(pair.runtime.session.thinkingLevel, pair.engine.session.thinkingLevel);
		assert.notEqual(pair.runtime.session.thinkingLevel, "medium");
	},
);

test("an engine resync over a child process does not overwrite a concurrent thinking level change (#5237)", async () => {
	const hostHarness = await createHarness({
		models: [
			{ id: "current-model", reasoning: true },
			{ id: "other-model", reasoning: true },
		],
	});
	const childScript = join(hostHarness.tempDir, "engine-resync-child.mts");
	const runtimeUrl = pathToFileURL(join(import.meta.dirname, "../src/core/agent-session-runtime.ts")).href;
	const jsonEventUrl = pathToFileURL(join(import.meta.dirname, "../src/modes/json-event.ts")).href;
	const handlerUrl = pathToFileURL(join(import.meta.dirname, "../src/modes/rpc/rpc-command-handler.ts")).href;
	const schedulerUrl = pathToFileURL(join(import.meta.dirname, "../src/modes/rpc/rpc-input-scheduler.ts")).href;
	const harnessUrl = pathToFileURL(join(import.meta.dirname, "./suite/harness.ts")).href;
	writeFileSync(
		childScript,
		[
			`import { createInterface } from "node:readline";`,
			`import { AgentSessionRuntime } from ${JSON.stringify(runtimeUrl)};`,
			`import { toJsonEvent } from ${JSON.stringify(jsonEventUrl)};`,
			`import { createRpcCommandHandler } from ${JSON.stringify(handlerUrl)};`,
			`import { createRpcInputScheduler } from ${JSON.stringify(schedulerUrl)};`,
			`import { createHarness } from ${JSON.stringify(harnessUrl)};`,
			`const out = (record) => process.stdout.write(JSON.stringify(record) + "\\n");`,
			`const engine = await createHarness({ models: [{ id: "current-model", reasoning: true }, { id: "other-model", reasoning: true }] });`,
			`await engine.session.bindExtensions({ shutdownHandler: () => {} });`,
			`await engine.session.setModel(engine.getModel("current-model"));`,
			`await engine.session.setThinkingLevel("low");`,
			`const runtimeHost = new AgentSessionRuntime(engine.session, { cwd: engine.tempDir, agentDir: engine.tempDir }, async () => { throw new Error("unused"); });`,
			`const handle = createRpcCommandHandler({ runtimeHost, getSession: () => engine.session, rebindSession: async () => {}, output: out, detachCompaction: true });`,
			`engine.session.subscribe((event) => out(toJsonEvent(event)));`,
			`const schedule = createRpcInputScheduler(async (line) => {`,
			`	const response = await handle(JSON.parse(line));`,
			`	if (response) out(response);`,
			`});`,
			`createInterface({ input: process.stdin }).on("line", schedule);`,
		].join("\n"),
	);

	const client = new RpcClient({ cliPath: childScript, requestTimeoutMs: 30_000 });
	await client.start();
	try {
		const local = new AgentSessionRuntime(
			hostHarness.session,
			{ cwd: hostHarness.tempDir, agentDir: hostHarness.tempDir } as never,
			async () => {
				throw new Error("unused runtime factory");
			},
		);
		const runtime = new IsolatedInteractiveRuntime(
			local,
			async () => {
				throw new Error("unused runtime factory");
			},
			client,
		);
		await runtime.session.bindExtensions({ shutdownHandler: () => {} });
		await runtime.initializeFromEngine();
		assert.equal(runtime.session.thinkingLevel, "low");

		const resync = runtime.initializeFromEngine();
		await new Promise<void>((resolve) => setImmediate(resolve));
		const change = runtime.session.setThinkingLevel("high");
		await Promise.all([resync, change]);

		const state = await client.getState();
		assert.equal(state.thinkingLevel, "high");
		assert.equal(runtime.session.thinkingLevel, "high");
	} finally {
		await client.stop();
		await hostHarness.cleanup().catch(() => {});
	}
});
