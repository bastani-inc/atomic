import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, vi } from "vitest";
import { createEventBus } from "../src/core/event-bus.js";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.js";
import { ExtensionRunner } from "../src/core/extensions/runner.js";
import { noOpUIContext } from "../src/core/extensions/runner-ui.js";
import type { ExtensionMode, SubagentChildPolicy } from "../src/core/extensions/types.js";
import { SessionManager } from "../src/core/session-manager.js";
import { captureHerdrEnvironment } from "../src/extensions/herdr/environment.js";
import herdrExtension, { createHerdrExtension } from "../src/extensions/herdr/index.js";
import type { HerdrDiagnostic } from "../src/extensions/herdr/transport.js";
import { builtInExtensions } from "../src/extensions/index.js";
import { fakeHerdr } from "./helpers/herdr.js";

// #2891: gate before timers, processes, or observer leases are allocated.
test("invalid environment and inherited child/headless modes never acquire reporter resources", async () => {
	const fake = await fakeHerdr();
	try {
		const cases: { env: NodeJS.ProcessEnv; mode: ExtensionMode; ui: boolean; child?: SubagentChildPolicy }[] = [
			{ env: {}, mode: "tui", ui: true },
			{ env: { ...fake.env, HERDR_ENV: "true" }, mode: "tui", ui: true },
			...(["HERDR_ENV", "HERDR_BIN_PATH", "HERDR_PANE_ID", "HERDR_SOCKET_PATH"] as const).flatMap((key) => [
				{ env: { ...fake.env, [key]: undefined }, mode: "tui" as const, ui: true },
				{ env: { ...fake.env, [key]: "" }, mode: "tui" as const, ui: true },
			]),
			...(["print", "rpc", "json"] as const).map((mode) => ({ env: fake.env, mode, ui: true })),
			{ env: fake.env, mode: "tui", ui: false },
			{
				env: fake.env,
				mode: "tui",
				ui: true,
				child: {
					managementActions: "restricted",
					fanoutAuthorized: false,
					inheritProjectContext: true,
					inheritSkills: true,
				},
			},
		];
		for (const scenario of cases) {
			const runtime = createExtensionRuntime();
			const extension = await loadExtensionFromFactory(
				createHerdrExtension({ env: scenario.env }),
				fake.dir,
				createEventBus(),
				runtime,
				"herdr",
			);
			if (!captureHerdrEnvironment(scenario.env)) assert.equal(extension.handlers.size, 0);
			const runner = new ExtensionRunner(
				[extension],
				runtime,
				fake.dir,
				SessionManager.inMemory(),
				{} as never,
				undefined,
				scenario.child,
			);
			runner.setUIContext(scenario.ui ? { ...noOpUIContext } : undefined, scenario.mode);
			const observe = vi.spyOn(runtime.workflowActivityHub, "observeWorkflowActivity");
			const timeout = vi.spyOn(globalThis, "setTimeout");
			const interval = vi.spyOn(globalThis, "setInterval");
			try {
				await runner.emit({ type: "session_start" });
				await runner.emit({ type: "agent_start" });
				await runner.emit({ type: "agent_settled" });
				await runner.emit({ type: "session_shutdown", reason: "quit" });
				assert.equal(observe.mock.calls.length, 0);
				assert.equal(timeout.mock.calls.length, 0);
				assert.equal(interval.mock.calls.length, 0);
			} finally {
				observe.mockRestore();
				timeout.mockRestore();
				interval.mockRestore();
				runner.invalidate();
			}
		}
		assert.deepEqual(await fake.calls(), []);
		assert.deepEqual(captureHerdrEnvironment({ ...fake.env, HERDR_PANE_ID: " w1:p1; rm -rf / " }), {
			bin: fake.bin,
			paneId: " w1:p1; rm -rf / ",
			socketPath: fake.environment.socketPath,
		});
	} finally {
		await fake.dispose();
	}
});

// #2891: shipped metadata and loaded paths, not filesystem package discovery.
// #2416: supersession is a load-time decision now — the resource loader skips
// Herdr's installed `herdr-agent-state` files inside a Herdr pane (see
// herdr-supersession.test.ts), so a loaded path carrying that basename must not
// silence the builtin. Blind deferral is what left the pane reported by nobody
// when the installed asset loaded but silently failed.
test("built-in registration keeps llama first and reports alongside loaded legacy/community reporter paths", async () => {
	assert.equal(builtInExtensions[0].name, "llama.cpp");
	assert.deepEqual(
		builtInExtensions.find((entry) => entry.factory === herdrExtension),
		{ name: "Herdr", factory: herdrExtension, hidden: true, bundled: true },
	);
	const fake = await fakeHerdr();
	try {
		let reported = 0;
		for (const path of ["/loaded/herdr-atomic-reporter/index.ts", "C:\\loaded\\herdr-agent-state.ts"]) {
			const runtime = createExtensionRuntime();
			const diagnostics: HerdrDiagnostic[] = [];
			const extension = await loadExtensionFromFactory(
				createHerdrExtension({
					env: fake.env,
					enabled: () => true,
					diagnostic: (value) => diagnostics.push(value),
				}),
				fake.dir,
				createEventBus(),
				runtime,
				"herdr",
			);
			const conflict = await loadExtensionFromFactory(() => {}, fake.dir, createEventBus(), runtime, path);
			const runner = new ExtensionRunner(
				[extension, conflict],
				runtime,
				fake.dir,
				SessionManager.inMemory(),
				{} as never,
			);
			runner.setUIContext({ ...noOpUIContext }, "tui");
			await runner.emit({ type: "session_start" });
			await runner.emit({ type: "session_start" });
			await runner.emit({ type: "agent_start" });
			await runner.emit({ type: "session_shutdown", reason: "quit" });
			assert.deepEqual(
				diagnostics.filter((entry) => entry.kind === "unsupported"),
				[],
				`a loaded ${path} must not stand the builtin down`,
			);
			assert.deepEqual(runner.createContext().getExtensionPaths?.(), ["herdr", path]);
			// An active builtin takes a workflow-activity lease, and this harness
			// supplies no workflow store, so the hub reports only that the source is
			// absent and the observer was torn down. Nothing else may appear.
			assert.deepEqual([...new Set(runtime.workflowActivityHub.diagnostics().map((entry) => entry.kind))].sort(), [
				"ObserverDisposed",
				"SourceUnavailable",
			]);
			runner.invalidate();
			await fake.waitFor(reported + 1);
			reported = (await fake.calls()).filter((call) => call.phase === "end").length;
		}
		assert.ok(reported > 0, "the builtin is the pane's reporter in both cases");
	} finally {
		await fake.dispose();
	}
});

// #2891: read the real project setting; an omitted setting defaults to enabled.
test("settings opt-out is respected and environment is captured at activation rather than factory creation", async () => {
	const fake = await fakeHerdr();
	const env: NodeJS.ProcessEnv = {};
	const factory = createHerdrExtension({ env });
	Object.assign(env, fake.env);
	await mkdir(join(fake.dir, ".atomic"));
	try {
		for (const optedOut of [true, false]) {
			await writeFile(
				join(fake.dir, ".atomic", "settings.json"),
				JSON.stringify(optedOut ? { herdr: { enabled: false } } : {}),
			);
			const runtime = createExtensionRuntime();
			const extension = await loadExtensionFromFactory(factory, fake.dir, createEventBus(), runtime, "herdr");
			const runner = new ExtensionRunner([extension], runtime, fake.dir, SessionManager.inMemory(), {} as never);
			runner.setUIContext({ ...noOpUIContext }, "tui");
			try {
				await runner.emit({ type: "session_start" });
				await runner.emit({ type: "agent_start" });
				if (optedOut) assert.deepEqual(runtime.workflowActivityHub.diagnostics(), []);
				else await fake.waitFor(1);
			} finally {
				await runner.emit({ type: "session_shutdown", reason: "quit" });
				runner.invalidate();
			}
			assert.equal((await fake.calls()).length, optedOut ? 0 : 4);
		}
	} finally {
		await fake.dispose();
	}
});
