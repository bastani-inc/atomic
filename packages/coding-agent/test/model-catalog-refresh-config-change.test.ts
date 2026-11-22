import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelsRefreshResult } from "@bastani/atomic-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { refreshModelCatalogs } from "../src/modes/interactive/model-catalog-refresh.ts";

/**
 * Reach the catalog pass a `ModelRuntime.refresh()` runs. `runRefresh` loads
 * models.json and applies it *before* this call, so gating here holds a pass
 * open that has already consumed the old file.
 */
interface RuntimeInternals {
	models: { refresh(options?: { signal?: AbortSignal }): Promise<ModelsRefreshResult> };
}

const tempDirs: string[] = [];

function writeModels(path: string, apiKey: string, modelId: string): void {
	writeFileSync(
		path,
		JSON.stringify({
			providers: {
				configured: {
					api: "openai-completions",
					baseUrl: "https://example.test/v1",
					apiKey,
					models: [{ id: modelId }],
				},
			},
		}),
	);
}

async function createRuntime(modelsPath: string): Promise<ModelRuntime> {
	return ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath, allowModelNetwork: false });
}

function createModelsPath(): string {
	const directory = mkdtempSync(join(tmpdir(), "atomic-catalog-config-"));
	tempDirs.push(directory);
	return join(directory, "models.json");
}

async function waitForPasses(counter: () => number, count: number): Promise<void> {
	for (let attempt = 0; attempt < 200 && counter() < count; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

beforeEach(() => {
	// Every catalog pass here is local: the assertions are about which pass a
	// caller joins and which models.json it read, never about a live endpoint.
	vi.stubEnv("ATOMIC_OFFLINE", "1");
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("model catalog refresh across a models.json change", () => {
	it("counts an external models.json edit as a catalog-input change", async () => {
		const modelsPath = createModelsPath();
		writeModels(modelsPath, "old-key", "old-model");
		const runtime = await createRuntime(modelsPath);
		const start = runtime.getCatalogInputsGeneration();
		expect(typeof start).toBe("number");

		// Nothing in the runtime writes this file, so the generation samples it. A
		// same-length rewrite is the case an mtime or a size would miss.
		expect(runtime.getCatalogInputsGeneration()).toBe(start);
		expect(await runtime.getCatalogInputsGenerationAsync()).toBe(start);
		writeModels(modelsPath, "new-key", "new-model");
		const afterEdit = runtime.getCatalogInputsGeneration();
		expect(afterEdit).toBeGreaterThan(start);
		expect(await runtime.getCatalogInputsGenerationAsync()).toBe(afterEdit);

		// Rewriting the same content is not a change, so repeated reads keep sharing.
		writeModels(modelsPath, "new-key", "new-model");
		expect(runtime.getCatalogInputsGeneration()).toBe(afterEdit);
		expect(await runtime.getCatalogInputsGenerationAsync()).toBe(afterEdit);
	});

	it("gives requests in the same tick one key, and a request after an edit another", async () => {
		const modelsPath = createModelsPath();
		writeModels(modelsPath, "old-key", "old-model");
		const runtime = await createRuntime(modelsPath);

		const [first, second] = await Promise.all([runtime.readCatalogInputsKey(), runtime.readCatalogInputsKey()]);
		expect(second).toBe(first);
		const oldSha256 = createHash("sha256").update(readFileSync(modelsPath)).digest("hex");
		expect(first.endsWith(`:${oldSha256}`)).toBe(true);

		// Alternating sync and async observations of the unchanged file keep the same generation.
		const genBefore = runtime.getCatalogInputsGeneration();
		expect(await runtime.getCatalogInputsGenerationAsync()).toBe(genBefore);
		expect(runtime.getCatalogInputsGeneration()).toBe(genBefore);

		writeModels(modelsPath, "new-key", "new-model");
		const afterEditKey = await runtime.readCatalogInputsKey();
		const newSha256 = createHash("sha256").update(readFileSync(modelsPath)).digest("hex");
		expect(afterEditKey).not.toBe(first);
		expect(afterEditKey.endsWith(`:${newSha256}`)).toBe(true);
		expect(runtime.getCatalogInputsGeneration()).toBeGreaterThan(genBefore);
	});

	it("does not answer a post-edit request with the pass that loaded the old models.json", async () => {
		const modelsPath = createModelsPath();
		writeModels(modelsPath, "old-key", "old-model");
		const runtime = await createRuntime(modelsPath);
		expect(runtime.getModel("configured", "old-model")).toBeDefined();

		const internals = runtime as unknown as RuntimeInternals;
		let passes = 0;
		let releaseFirstPass!: () => void;
		const firstPassGate = new Promise<void>((resolve) => {
			releaseFirstPass = resolve;
		});
		vi.spyOn(internals.models, "refresh").mockImplementation(async () => {
			passes++;
			if (passes === 1) await firstPassGate;
			return { aborted: false, errors: new Map<string, Error>() };
		});

		const startupController = new AbortController();
		const startupRefresh = refreshModelCatalogs(runtime, { signal: startupController.signal });
		await waitForPasses(() => passes, 1);
		expect(passes).toBe(1);

		// The user edits models.json while that pass is still running: a new model
		// id and a new provider key, both of which the running pass cannot know.
		writeModels(modelsPath, "new-key", "new-model");

		const selectorController = new AbortController();
		const selectorRefresh = refreshModelCatalogs(runtime, { signal: selectorController.signal });
		// A joined request would leave this at one pass forever; the wait fails loudly
		// rather than racing a second pass that never starts.
		await waitForPasses(() => passes, 2);
		expect(passes).toBe(2);

		await expect(selectorRefresh).resolves.toMatchObject({ aborted: false });
		expect(runtime.getModel("configured", "new-model")).toBeDefined();
		expect(runtime.getModel("configured", "old-model")).toBeUndefined();
		await expect(runtime.getAuth("configured")).resolves.toMatchObject({ auth: { apiKey: "new-key" } });

		releaseFirstPass();
		await expect(startupRefresh).resolves.toMatchObject({ aborted: false });
		// The abandoned pass republishes from the runtime's current config rather
		// than restoring the file it read.
		expect(runtime.getModel("configured", "new-model")).toBeDefined();
	});

	it("still shares one pass between concurrent callers while models.json is unchanged", async () => {
		const modelsPath = createModelsPath();
		writeModels(modelsPath, "stable-key", "stable-model");
		const runtime = await createRuntime(modelsPath);

		const internals = runtime as unknown as RuntimeInternals;
		let passes = 0;
		let releasePass!: () => void;
		const passGate = new Promise<void>((resolve) => {
			releasePass = resolve;
		});
		vi.spyOn(internals.models, "refresh").mockImplementation(async () => {
			passes++;
			await passGate;
			return { aborted: false, errors: new Map<string, Error>() };
		});

		const startupController = new AbortController();
		const selectorController = new AbortController();
		const startupRefresh = refreshModelCatalogs(runtime, { signal: startupController.signal });
		await waitForPasses(() => passes, 1);
		const keyReads = vi.spyOn(runtime, "readCatalogInputsKey");
		const selectorRefresh = refreshModelCatalogs(runtime, { signal: selectorController.signal });
		await keyReads.mock.results[0]?.value;
		await new Promise((resolve) => setImmediate(resolve));

		expect(passes).toBe(1);

		releasePass();
		await expect(startupRefresh).resolves.toMatchObject({ aborted: false });
		await expect(selectorRefresh).resolves.toMatchObject({ aborted: false });
		expect(passes).toBe(1);
	});
});
