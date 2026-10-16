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
