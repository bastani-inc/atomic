import { test } from "bun:test";
import assert from "node:assert/strict";
import { workflowModelCatalogFromContext } from "../../packages/workflows/src/extension/extension-runtime-state.js";
import { buildModelCandidatesFromCatalog } from "../../packages/workflows/src/runs/shared/model-fallback.js";
import type { PiRuntimeModel } from "../../packages/workflows/src/extension/public-types.js";

test("workflow context discovery settles before an immediate Cursor catalog snapshot", async () => {
	let available: PiRuntimeModel[] = [];
	let discoveries = 0;
	const catalog = workflowModelCatalogFromContext({
		modelRegistry: { getAvailable: () => available },
		discoverModelCatalog: async () => {
			discoveries += 1;
			available = [{ provider: "cursor", id: "live-immediate-route" }];
		},
	});
	assert.ok(catalog);
	const [candidate] = await buildModelCandidatesFromCatalog({ primaryModel: "cursor/live-immediate-route", catalog });
	assert.equal(discoveries, 1);
	assert.equal(candidate?.id, "cursor/live-immediate-route");
});

test("workflow context forwards cancellation before reading the model registry", async () => {
	const controller = new AbortController();
	let listed = 0;
	const catalog = workflowModelCatalogFromContext({
		signal: controller.signal,
		modelRegistry: { getAvailable: () => { listed += 1; return []; } },
		discoverModelCatalog: async ({ signal } = {}) => {
			controller.abort(new Error("cancel immediate workflow"));
			if (signal?.aborted) throw signal.reason;
		},
	});
	assert.ok(catalog);
	await assert.rejects(buildModelCandidatesFromCatalog({ primaryModel: "cursor/live-immediate-route", catalog }), /cancel immediate workflow/u);
	assert.equal(listed, 0);
});
