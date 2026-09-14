import assert from "node:assert/strict";
import { test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { createToolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import { buildRuntimeAdapters, type PiCodingAgentSdk } from "../../packages/workflows/src/extension/wiring.js";
import { quitRun } from "../../packages/workflows/src/runs/background/quit.js";
import { inspectRun, pauseRun, resumeRun } from "../../packages/workflows/src/runs/background/status.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type { StageStartupSnapshot } from "../../packages/workflows/src/shared/stage-startup.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { renderRunDetail } from "../../packages/workflows/src/tui/run-detail.js";
import { createStageContext, makeMockSession, makeOpts } from "./stage-runner-helpers.js";

// #3040: exercise production preparation, serialized reload, SDK and binding, not a replacement queue.
test("cancelled stalled reload and queued sibling settle callers without releasing or bypassing the reload owner", async () => {
	const gate = Promise.withResolvers<void>();
	let reloads = 0;
	let creates = 0;
	const sdk: PiCodingAgentSdk = {
		getAgentDir: () => "/tmp/atomic-startup-test",
		SettingsManager: { create: () => ({}) },
		DefaultResourceLoader: class {
			async reload() {
				reloads++;
				await gate.promise;
			}
		},
		async createAgentSession() {
			creates++;
			return { session: makeMockSession().session };
		},
	};
	const adapters = buildRuntimeAdapters({}, { sdk });
	const a = createStageContext(makeOpts({ adapters, stageId: "a" }));
	const b = createStageContext(makeOpts({ adapters, stageId: "b" }));
	const first = a.__ensureSession();
	const second = b.__ensureSession();
	let firstSettled = false;
	let secondSettled = false;
	const firstFailure = first.catch(() => {
		firstSettled = true;
	});
	const secondFailure = second.catch(() => {
		secondSettled = true;
	});
	try {
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(reloads, 1);
		await Promise.all([a.abort(), b.abort()]);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(firstSettled, true, "cancelled startup consumer must settle before the loader does");
		assert.equal(secondSettled, true, "queued sibling consumer must settle before the loader does");
		await assert.rejects(a.__ensureSession());
		assert.equal(reloads, 1, "cancellation must not release the active loader");
		assert.equal(creates, 0);
	} finally {
		gate.resolve();
		await Promise.all([firstFailure, secondFailure]);
		await new Promise((resolve) => setTimeout(resolve, 20));
		await Promise.all([a.__dispose(), b.__dispose()]);
	}
	assert.equal(reloads, 1, "cancelled sibling must never enter reload even after the old owner settles");
	assert.equal(creates, 0, "cancelled resource preparation must not create an SDK session");
});

// #3040: independently stalled SDK and binding must retain their creation until late cleanup.
for (const phase of ["sdk", "binding"] as const) {
	test(`${phase} startup exposes its phase and cancels waiters before late disposal`, async () => {
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		let creates = 0;
		let binds = 0;
		let disposals = 0;
		let dispatches = 0;
		const phases: string[] = [];
		const sdk: PiCodingAgentSdk = {
			getAgentDir: () => "/tmp/atomic-startup-test",
			SettingsManager: { create: () => ({}) },
			DefaultResourceLoader: class {
				async reload() {}
			},
			async createAgentSession() {
				creates++;
				if (phase === "sdk") {
					entered.resolve();
					await gate.promise;
				}
				return {
					session: Object.assign(
						makeMockSession({
							async prompt() {
								dispatches++;
								return "ok";
							},
							dispose() {
								disposals++;
							},
						}).session,
						{
							async bindExtensions() {
								binds++;
								if (phase === "binding") {
									entered.resolve();
									await gate.promise;
								}
							},
						},
					),
				};
			},
		};
		const owner = new AbortController();
		const ctx = createStageContext(
			makeOpts({
				adapters: buildRuntimeAdapters({}, { sdk }),
				signal: owner.signal,
				onStartupChange: (snapshot) => phases.push(`${snapshot.phase}:${snapshot.state}`),
			}),
		);
		const prompt = ctx.prompt("fresh reviewer");
		let settled = false;
		const rejected = prompt.catch(() => {
			settled = true;
		});
		try {
			await entered.promise;
			assert.ok(phases.includes(`${phase === "sdk" ? "sdk-creation" : "extension-binding"}:active`));
			owner.abort(new Error("owner cancelled"));
			await new Promise((resolve) => setTimeout(resolve, 20));
			assert.equal(settled, true);
			await assert.rejects(ctx.__ensureSession());
			assert.equal(creates, 1);
			assert.equal(disposals, 0, "do not dispose underneath active creation/binding");
			assert.equal(dispatches, 0);
		} finally {
			gate.resolve();
			await rejected;
			await new Promise((resolve) => setTimeout(resolve, 20));
			await ctx.__dispose();
		}
		assert.equal(disposals, 1);
		assert.equal(binds, phase === "sdk" ? 0 : 1, "late SDK result must not bind");
		assert.equal(dispatches, 0);
		assert.equal(phases.at(-1), `${phase === "sdk" ? "sdk-creation" : "extension-binding"}:cancelled`);
	});
}

// #3040: slow startup is not a failure; pause/resume joins its owner and preserves phase age.
test("slow startup reports every phase through first dispatch without restarting on pause", async () => {
	const gate = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const snapshots: StageStartupSnapshot[] = [];
	let creates = 0;
	let prompts = 0;
	const sdk: PiCodingAgentSdk = {
		getAgentDir: () => "/tmp/atomic-startup-test",
		SettingsManager: { create: () => ({}) },
		DefaultResourceLoader: class {
			async reload() {
				entered.resolve();
				await gate.promise;
			}
		},
		async createAgentSession() {
			creates++;
			return {
				session: Object.assign(
					makeMockSession({
						async prompt() {
							prompts++;
							return "reviewed";
						},
					}).session,
					{ async bindExtensions() {} },
				),
			};
		},
	};
	const ctx = createStageContext(
		makeOpts({ adapters: buildRuntimeAdapters({}, { sdk }), onStartupChange: (s) => snapshots.push(s) }),
	);
	const result = ctx.prompt("review");
	await entered.promise;
	const waiting = snapshots.at(-1)!;
	assert.equal(waiting.phase, "reload-active");
	await ctx.__requestPause();
	await new Promise((resolve) => setTimeout(resolve, 20));
	await ctx.__resume();
	assert.equal(snapshots.at(-1), waiting, "pause/resume must not reset startup age or owner");
	gate.resolve();
	await result;
	assert.equal(creates, 1);
	assert.equal(prompts, 1);
	assert.deepEqual(
		[...new Set(snapshots.map((s) => s.phase))],
		[
			"model-resolution",
			"route-authority",
			"resource-preparation",
			"reload-queued",
			"reload-active",
			"sdk-creation",
			"extension-binding",
			"session-attachment",
			"delivery-readiness",
			"ready",
			"first-dispatch",
		],
	);
	assert.equal(snapshots.at(-1)?.state, "dispatched");
	assert.ok(snapshots.every((s) => s.startedAt === snapshots[0]!.startedAt && s.phaseStartedAt >= s.startedAt));
	await ctx.__dispose();
});

// #3040: supported controls and the actual CLI detail renderer, not just an adapter callback.
test("paused and quit startup stays observable; owner cancellation terminates stalled reviewer siblings", async () => {
	const gate = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	let reloads = 0;
	const sdk: PiCodingAgentSdk = {
		getAgentDir: () => "/tmp/atomic-startup-test",
		SettingsManager: { create: () => ({}) },
		DefaultResourceLoader: class {
			async reload() {
				reloads++;
				entered.resolve();
				await gate.promise;
			}
		},
		async createAgentSession() {
			assert.fail("cancelled resource startup cannot create sessions");
		},
	};
	const store = createStore();
	const controls = createStageControlRegistry();
	const tools = createToolControlRegistry();
	const owner = new AbortController();
	const runId = crypto.randomUUID();
	const definition = workflow({
		name: "startup-review",
		description: "startup regression",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await Promise.all(
				["reviewer-a", "reviewer-b"].map((name) => ctx.stage(name, { group: "default" }).prompt("fresh review")),
			);
			return {};
		},
	});
	const execution = run(
		definition,
		{},
		{
			runId,
			store,
			adapters: buildRuntimeAdapters({}, { sdk }),
			stageControlRegistry: controls,
			toolControlRegistry: tools,
			durableBackend: new InMemoryDurableBackend(),
			signal: owner.signal,
		},
	);
	const deps = { store, stageControlRegistry: controls, toolControlRegistry: tools };
	try {
		await entered.promise;
		await new Promise((resolve) => setTimeout(resolve, 20));
		const before = store.runs().find((r) => r.id === runId)!;
		assert.deepEqual(
			before.stages.map((s) => s.startup?.phase),
			["reload-active", "reload-queued"],
		);
		const detail = inspectRun(runId, deps);
		assert.ok(detail.ok);
		const text = renderRunDetail(detail.detail, { now: Date.now() + 20_000, width: 120 });
		assert.match(text, /startup reload-active \(20s total, 20s on current step; active\)/);
		assert.match(text, /startup reload-queued/);
		assert.equal((await pauseRun(runId, deps)).ok, true);
		assert.equal(store.runs().find((r) => r.id === runId)?.status, "paused");
		assert.equal((await resumeRun(runId, deps)).ok, true);
		assert.equal(reloads, 1);
		assert.equal((await quitRun(runId, deps)).ok, true);
		assert.equal(store.runs().find((r) => r.id === runId)?.status, "paused");
		owner.abort(new Error("owner stopped"));
		await execution;
		const cancelled = store.runs().find((r) => r.id === runId)!;
		assert.equal(cancelled.status, "killed");
		assert.ok(cancelled.stages.every((s) => s.startup?.state === "cancelled"));
		assert.ok(cancelled.stages.every((s) => s.startup?.ownershipPending === true));
		assert.equal(reloads, 1);
	} finally {
		owner.abort();
		gate.resolve();
		await execution;
		await Promise.all(controls.forRun(runId).map((handle) => handle.dispose?.()));
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.equal(reloads, 1);
	assert.ok(
		store
			.runs()
			.find((r) => r.id === runId)!
			.stages.every((s) => s.startup?.ownershipPending === false),
	);
});

// #3040: explicit model selection takes the fallback path rather than ensureSession's fast path.
test("explicit-model startup cancellation does not wait for SDK creation or start a competing candidate", async () => {
	const gate = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	let creates = 0;
	let disposals = 0;
	const ctx = createStageContext(
		makeOpts({
			stageOptions: { model: "anthropic/primary", fallbackModels: ["anthropic/fallback"] },
			adapters: {
				agentSession: {
					async create() {
						creates++;
						entered.resolve();
						await gate.promise;
						return makeMockSession({
							dispose() {
								disposals++;
							},
						}).session;
					},
				},
			},
		}),
	);
	let settled = false;
	const prompt = ctx.prompt("review").catch(() => {
		settled = true;
	});
	try {
		await entered.promise;
		await ctx.abort();
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(settled, true);
		assert.equal(creates, 1);
		assert.equal(disposals, 0);
	} finally {
		gate.resolve();
		await prompt;
		await new Promise((resolve) => setTimeout(resolve, 20));
		await ctx.__dispose();
	}
	assert.equal(creates, 1);
	assert.equal(disposals, 1);
});

// #3040 / #3041: an attached identity must not bypass the unfinished readiness owner.
test("concurrent ensure cannot bypass readiness and cancellation fences its late completion", async () => {
	const gate = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	let prompts = 0;
	let disposals = 0;
	const ctx = createStageContext(
		makeOpts({
			adapters: {
				agentSession: {
					async create() {
						return makeMockSession({
							async prompt() {
								prompts++;
								return "wrong";
							},
							dispose() {
								disposals++;
							},
						}).session;
					},
				},
			},
			onSessionReady: async () => {
				entered.resolve();
				await gate.promise;
			},
		}),
	);
	const prompt = ctx.prompt("review");
	void prompt.catch(() => {});
	await entered.promise;
	let joined = false;
	const second = ctx.__ensureSession().then(() => {
		joined = true;
	});
	void second.catch(() => {});
	try {
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(joined, false, "attachment alone does not authorize a consumer");
		await ctx.abort();
		await assert.rejects(prompt);
		await assert.rejects(second);
		await ctx.__dispose();
		assert.equal(disposals, 0, "disposal cannot race unfinished readiness side effects");
	} finally {
		gate.resolve();
		await Promise.allSettled([prompt, second]);
		await new Promise((resolve) => setTimeout(resolve, 20));
		await ctx.__dispose();
	}
	assert.equal(prompts, 0);
	assert.equal(disposals, 1);
});

// #3040 / #3041: eager explicit-model attachment is not readiness authorization.
test("explicit-model eager ensure and concurrent prompt join readiness success", async () => {
	const gate = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	let prompts = 0;
	let creates = 0;
	const ctx = createStageContext(
		makeOpts({
			stageOptions: { model: "anthropic/primary" },
			adapters: {
				agentSession: {
					async create() {
						creates++;
						return makeMockSession({
							async prompt() {
								prompts++;
								return "ok";
							},
						}).session;
					},
				},
			},
			onSessionReady: async () => {
				entered.resolve();
				await gate.promise;
			},
		}),
	);
	const ensure = ctx.__ensureSession();
	await entered.promise;
	const prompt = ctx.prompt("review");
	try {
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(prompts, 0);
	} finally {
		gate.resolve();
		await Promise.allSettled([ensure, prompt]);
		await ctx.__dispose();
	}
	assert.equal(prompts, 1);
	assert.equal(creates, 1);
});

// #3040: cancellation delegates attached readiness cleanup to the retained owner, even on rejection.
test("rejected readiness after disposal releases the session exactly once", async () => {
	const gate = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	let disposals = 0;
	let prompts = 0;
	let latest: StageStartupSnapshot | undefined;
	const ctx = createStageContext(
		makeOpts({
			adapters: {
				agentSession: {
					async create() {
						return makeMockSession({
							dispose() {
								disposals++;
							},
							async prompt() {
								prompts++;
								return "wrong";
							},
						}).session;
					},
				},
			},
			onSessionReady: async () => {
				entered.resolve();
				await gate.promise;
			},
			onStartupChange: (snapshot) => {
				latest = snapshot;
			},
		}),
	);
	const prompt = ctx.prompt("review");
	void prompt.catch(() => {});
	await entered.promise;
	await ctx.abort();
	await ctx.__dispose();
	assert.equal(disposals, 0);
	assert.equal(latest?.ownershipPending, true);
	gate.reject(new Error("readiness persistence failed"));
	await Promise.allSettled([prompt]);
	await new Promise((resolve) => setTimeout(resolve, 20));
	await ctx.__dispose();
	assert.equal(disposals, 1);
	assert.equal(prompts, 0);
	assert.equal(latest?.ownershipPending, false);
});

// #3040 / #3041: neither cancelled nor rejected explicit-model readiness may dispatch.
for (const outcome of ["cancel", "reject"] as const) {
	test(`explicit-model eager ensure fences concurrent prompt on readiness ${outcome}`, async () => {
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		let prompts = 0;
		let creates = 0;
		let disposals = 0;
		const ctx = createStageContext(
			makeOpts({
				stageOptions: { model: "anthropic/primary" },
				adapters: {
					agentSession: {
						async create() {
							creates++;
							return makeMockSession({
								async prompt() {
									prompts++;
									return "wrong";
								},
								dispose() {
									disposals++;
								},
							}).session;
						},
					},
				},
				onSessionReady: async () => {
					entered.resolve();
					await gate.promise;
				},
			}),
		);
		const ensure = ctx.__ensureSession();
		void ensure.catch(() => {});
		await entered.promise;
		const prompt = ctx.prompt("review");
		void prompt.catch(() => {});
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(prompts, 0);
		if (outcome === "cancel") {
			await ctx.abort();
			gate.resolve();
		} else gate.reject(new Error("readiness persistence failed"));
		await assert.rejects(ensure);
		await assert.rejects(prompt);
		await new Promise((resolve) => setTimeout(resolve, 20));
		await ctx.__dispose();
		assert.equal(creates, 1);
		assert.equal(prompts, 0);
		assert.equal(disposals, 1);
	});
}

// #3040: failed readiness cleanup must never authorize a competing owner.
for (const failure of ["shutdown", "dispose"] as const) {
	test(`readiness rejection after cancellation keeps failed ${failure} cleanup sticky`, async () => {
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		let disposals = 0;
		let shutdowns = 0;
		let creates = 0;
		let prompts = 0;
		let latest: StageStartupSnapshot | undefined;
		const ctx = createStageContext(
			makeOpts({
				stageOptions: { model: "anthropic/primary", fallbackModels: ["anthropic/fallback"] },
				adapters: {
					agentSession: {
						async create() {
							creates++;
							return Object.assign(
								makeMockSession({
									async prompt() {
										prompts++;
										return "wrong";
									},
									dispose() {
										disposals++;
										if (failure === "dispose") throw new Error("dispose failed");
									},
								}).session,
								{
									extensionRunner: {
										hasHandlers: () => true,
										async emit() {
											shutdowns++;
											if (failure === "shutdown") throw new Error("shutdown failed");
										},
									},
								},
							);
						},
					},
				},
				onSessionReady: async () => {
					entered.resolve();
					await gate.promise;
				},
				onStartupChange: (snapshot) => {
					latest = snapshot;
				},
			}),
		);
		const ensure = ctx.__ensureSession();
		void ensure.catch(() => {});
		await entered.promise;
		const prompt = ctx.prompt("review");
		void prompt.catch(() => {});
		await ctx.abort();
		await ctx.__dispose();
		gate.reject(new Error("readiness persistence failed"));
		await Promise.allSettled([ensure, prompt]);
		await new Promise((resolve) => setTimeout(resolve, 20));
		await ctx.__dispose();
		await assert.rejects(ctx.__ensureSession(), /failed binding cleanup/);
		await assert.rejects(ctx.prompt("must not recover"));
		assert.equal(latest?.ownershipPending, true);
		assert.equal(latest?.settledAt, undefined);
		assert.equal(disposals, 1, "cleanup still attempts disposal after shutdown rejection");
		assert.equal(shutdowns, 1);
		assert.equal(creates, 1);
		assert.equal(prompts, 0);
	});
}
