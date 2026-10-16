import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import { StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { moduleDir, spawnProcess } from "../helpers/runtime.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

for (const boundary of ["tool", "task", "prompt", "ui", "checkpoint", "finalize"] as const) {
	test(`cached stage metadata failure reaches the next ${boundary} boundary before live work`, async () => {
		const backend = await createMemoryTestBackend();
		const failure = new StorageUnavailableError(
			{ adapter: "memory", location: "tracked-write" },
			new Error("rejected"),
		);
		let replay = false;
		let callbacks = 0;
		let observed: Error | undefined;
		const definition = workflow({
			name: `tracked-${boundary}`,
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				const cached = ctx.stage("cached");
				if (!replay) {
					await cached.complete("saved");
					return {};
				}
				try {
					if (boundary === "tool")
						await ctx.tool("next", {}, async () => {
							callbacks++;
							return "next";
						});
					if (boundary === "task") await ctx.task("next", { prompt: "next" });
					if (boundary === "prompt") await ctx.stage("next").prompt("next");
					if (boundary === "ui") await ctx.ui.input("next");
					if (boundary === "checkpoint") await ctx.stage("next").complete("next");
				} catch (error) {
					assert.ok(error instanceof Error);
					observed = error;
					throw error;
				}
				return {};
			},
		});
		const options = {
			runId: `tracked-${boundary}`,
			durableBackend: backend,
			ui: {
				input: async () => {
					callbacks++;
					return "next";
				},
				confirm: async () => false,
				select: async <T extends string>(_message: string, options: readonly T[]) => options[0]!,
				editor: async () => "",
				custom: async () => assert.fail("custom UI is not used by this workflow"),
			},
			adapters: {
				complete: {
					complete: async (text: string) => {
						if (replay) callbacks++;
						return text;
					},
				},
				prompt: {
					prompt: async () => {
						callbacks++;
						return "next";
					},
				},
			},
		};
		const seeded = await run(definition, {}, { ...options, store: createStore() });
		assert.equal(seeded.status, "completed", JSON.stringify(seeded));
		const commit = backend.commitCheckpoint.bind(backend);
		let metadataWrites = 0;
		backend.commitCheckpoint = async (checkpoint, commitOptions) => {
			if (checkpoint.checkpointId.startsWith("stage-replay-meta:")) {
				metadataWrites++;
				throw failure;
			}
			await commit(checkpoint, commitOptions);
		};
		replay = true;
		const result = await run(definition, {}, { ...options, store: createStore() });
		assert.equal(result.status, "failed");
		assert.equal(metadataWrites, 1);
		assert.equal(callbacks, 0);
		if (boundary !== "finalize") assert.equal(observed, failure);
		assert.equal(
			backend.listCheckpoints(options.runId).some((checkpoint) => checkpoint.kind === "ui"),
			false,
		);
		assert.equal(
			backend
				.listCheckpoints(options.runId)
				.some((checkpoint) => checkpoint.kind === "stage" && checkpoint.name === "next" && "output" in checkpoint),
			false,
		);
	});
}

test("an in-flight tool checkpoint observes a later cached-stage write failure", async () => {
	const backend = await createMemoryTestBackend();
	const failure = new StorageUnavailableError({ adapter: "memory", location: "in-flight" }, new Error("rejected"));
	let replay = false;
	let observed: Error | undefined;
	const definition = workflow({
		name: "in-flight-tracked-checkpoint",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			if (!replay) {
				await ctx.stage("cached").complete("saved");
				return {};
			}
			try {
				await ctx.tool("in-flight", {}, async () => {
					ctx.stage("cached");
					return "uncommitted";
				});
			} catch (error) {
				assert.ok(error instanceof Error);
				observed = error;
			}
			return {};
		},
	});
	const options = {
		runId: "in-flight-tracked-checkpoint",
		durableBackend: backend,
		adapters: { complete: { complete: async (text: string) => text } },
	};
	assert.equal((await run(definition, {}, { ...options, store: createStore() })).status, "completed");
	const commit = backend.commitCheckpoint.bind(backend);
	backend.commitCheckpoint = async (checkpoint, commitOptions) => {
		if (checkpoint.checkpointId.startsWith("stage-replay-meta:")) throw failure;
		await commit(checkpoint, commitOptions);
	};
	replay = true;
	assert.equal((await run(definition, {}, { ...options, store: createStore() })).status, "failed");
	assert.equal(observed, failure);
	assert.equal(
		backend
			.listCheckpoints(options.runId)
			.some((checkpoint) => checkpoint.kind === "tool" && checkpoint.output === "uncommitted"),
		false,
	);
});

test("a throwing tool rethrows failed cached-stage metadata before its diagnostic checkpoint", async () => {
	const backend = await createMemoryTestBackend();
	const failure = new StorageUnavailableError({ adapter: "memory", location: "throwing-tool" }, new Error("rejected"));
	const callbackError = new RangeError("callback failed");
	let replay = false;
	let observed: Error | undefined;
	let metadataWrites = 0;
	const definition = workflow({
		name: "throwing-tracked-checkpoint",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			if (!replay) {
				await ctx.stage("cached").complete("saved");
				return {};
			}
			try {
				await ctx.tool("throwing", {}, async () => {
					ctx.stage("cached");
					throw callbackError;
				});
			} catch (error) {
				assert.ok(error instanceof Error);
				observed = error;
			}
			return {};
		},
	});
	const options = {
		runId: "throwing-tracked-checkpoint",
		durableBackend: backend,
		adapters: { complete: { complete: async (text: string) => text } },
	};
	assert.equal((await run(definition, {}, { ...options, store: createStore() })).status, "completed");
	const append = backend.journal.append.bind(backend.journal);
	backend.journal.append = async (lease, event, appendOptions) => {
		if (
			event.type === "CheckpointRecorded" &&
			typeof event.payload === "object" &&
			event.payload !== null &&
			!Array.isArray(event.payload) &&
			typeof event.payload.checkpointId === "string" &&
			event.payload.checkpointId.startsWith("stage-replay-meta:")
		) {
			metadataWrites++;
			throw failure;
		}
		return append(lease, event, appendOptions);
	};
	replay = true;
	assert.equal((await run(definition, {}, { ...options, store: createStore() })).status, "failed");
	assert.equal(metadataWrites, 1);
	assert.equal(observed, failure);
	assert.equal(
		backend.listCheckpoints(options.runId).filter((checkpoint) => checkpoint.checkpointId.startsWith("tool-failure:"))
			.length,
		0,
	);
});

for (const cached of [false, true]) {
	test(`throwing tools retain callback failure after ${cached ? "pending" : "no"} replay metadata`, async () => {
		const backend = await createMemoryTestBackend();
		const callbackError = new RangeError("callback failed");
		const metadataEntered = Promise.withResolvers<void>();
		const metadataRelease = Promise.withResolvers<void>();
		const writes: string[] = [];
		let replay = false;
		let observed: Error | undefined;
		const definition = workflow({
			name: "throwing-checkpoint-order",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				if (!replay) {
					await ctx.stage("cached").complete("saved");
					return {};
				}
				try {
					await ctx.tool("throwing", {}, async () => {
						if (cached) ctx.stage("cached");
						throw callbackError;
					});
				} catch (error) {
					assert.ok(error instanceof Error);
					observed = error;
					throw error;
				}
				return {};
			},
		});
		const options = {
			runId: `throwing-checkpoint-order-${cached}`,
			durableBackend: backend,
			adapters: { complete: { complete: async (text: string) => text } },
		};
		assert.equal((await run(definition, {}, { ...options, store: createStore() })).status, "completed");
		const append = backend.journal.append.bind(backend.journal);
		backend.journal.append = async (lease, event, appendOptions) => {
			if (
				event.type === "CheckpointRecorded" &&
				typeof event.payload === "object" &&
				event.payload !== null &&
				!Array.isArray(event.payload) &&
				typeof event.payload.checkpointId === "string"
			) {
				if (event.payload.checkpointId.startsWith("stage-replay-meta:")) {
					metadataEntered.resolve();
					await metadataRelease.promise;
					writes.push("metadata");
				}
				if (event.payload.checkpointId.startsWith("tool-failure:")) writes.push("diagnostic");
			}
			return append(lease, event, appendOptions);
		};
		replay = true;
		const execution = run(definition, {}, { ...options, store: createStore() });
		try {
			if (cached) {
				await metadataEntered.promise;
				assert.equal(observed, undefined);
				assert.deepEqual(writes, []);
				assert.equal(
					backend
						.listCheckpoints(options.runId)
						.some((checkpoint) => checkpoint.checkpointId.startsWith("tool-failure:")),
					false,
				);
			}
		} finally {
			metadataRelease.resolve();
			await execution;
		}
		assert.equal((await execution).status, "failed");
		assert.equal(observed, callbackError);
		assert.deepEqual(writes, cached ? ["metadata", "diagnostic"] : ["diagnostic"]);
		const diagnostics = backend
			.listCheckpoints(options.runId)
			.filter((checkpoint) => checkpoint.kind === "tool" && checkpoint.checkpointId.startsWith("tool-failure:"));
		assert.equal(diagnostics.length, 1);
		const diagnostic = diagnostics[0];
		assert.ok(diagnostic?.kind === "tool");
		assert.equal(diagnostic.throwingFailureError, callbackError.message);
	});
}

const CACHED_STAGE_UI_CHILD_TIMEOUT_MS = 20_000;
test("cached-stage UI drains pending metadata and returns from successive prompts", async () => {
	const child = spawnProcess([
		process.execPath,
		"--import",
		"jiti/register",
		join(moduleDir(import.meta.url), "../fixtures/journal-cached-stage-ui.ts"),
	]);
	const stdout = new Response(child.stdout).text();
	const stderr = new Response(child.stderr).text();
	let timedOut = false;
	const deadline = setTimeout(() => {
		timedOut = true;
		child.kill("SIGKILL");
	}, CACHED_STAGE_UI_CHILD_TIMEOUT_MS);
	try {
		const code = await child.exited;
		assert.equal(timedOut, false, "UI child exceeded its parent deadline");
		assert.equal(code, 0, (await stdout) + (await stderr));
		assert.equal((await stdout).trim(), "cached-stage-ui-drained");
	} finally {
		clearTimeout(deadline);
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited;
		await stdout;
		await stderr;
	}
});
