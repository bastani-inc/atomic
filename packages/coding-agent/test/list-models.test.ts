import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import { listModels } from "../src/cli/list-models.js";
import { resolveCliModel } from "../src/core/model-resolver-cli.js";
import { createHarness, type Harness } from "./suite/harness.js";

describe("--list-models", () => {
	let harness: Harness | undefined;

	afterEach(async () => {
		vi.restoreAllMocks();
		await harness?.cleanup();
		harness = undefined;
	});

	async function listedRows(search?: string): Promise<string[][]> {
		const lines: string[] = [];
		vi.spyOn(console, "log").mockImplementation((line: unknown) => {
			lines.push(String(line));
		});
		await listModels(harness!.session.modelRuntime, search, harness!.settingsManager);
		return lines.map((line) => line.split("\t"));
	}

	it("prints each model's provider/id, a tab, and the level --model would start it at (#4269)", async () => {
		harness = await createHarness({
			models: [
				{ id: "reasoning-model", name: "Reasoning Model", reasoning: true },
				{ id: "saved-level-model", name: "Saved Level Model", reasoning: true },
				{ id: "plain-model", name: "Plain Model", reasoning: false },
			],
			settings: { defaultThinkingLevel: "high" },
		});
		const provider = harness.models[0].provider;
		harness.settingsManager.setModelThinkingLevel(provider, "saved-level-model", "low");

		const rows = await listedRows();
		assert.deepEqual(rows[0], ["model", "level", "context", "max-out", "images"]);
		assert.deepEqual(
			rows.slice(1).map((row) => row.slice(0, 2)),
			[
				[`${provider}/plain-model`, ""],
				[`${provider}/reasoning-model`, "high"],
				[`${provider}/saved-level-model`, "low"],
			],
		);
		for (const row of rows) assert.equal(row.length, 5, row.join("\t"));

		// The ID and level are exactly what `--model provider/id:level` takes.
		const [reference, level] = rows.find((row) => row[0] === `${provider}/saved-level-model`)!;
		const parsed = resolveCliModel({ cliModel: `${reference}:${level}`, modelRuntime: harness.session.modelRuntime });
		assert.equal(parsed.model?.id, "saved-level-model");
		assert.equal(parsed.thinkingLevel, "low");
	});

	it("writes token limits with one decimal, a lowercase k for thousands and an uppercase M and B above", async () => {
		const limits = [
			[999, "999"],
			[1_000, "1.0k"],
			[99_949, "99.9k"],
			[99_950, "100.0k"],
			[200_000, "200.0k"],
			[999_949, "999.9k"],
			[999_950, "1.0M"],
			[1_000_000, "1.0M"],
			[9_999_999, "10.0M"],
			[1_000_000_000, "1.0B"],
		] as const;
		harness = await createHarness({
			models: limits.map(([tokens], index) => ({
				id: `limit-${index}`,
				contextWindow: tokens,
				maxTokens: tokens,
			})),
		});

		const rows = await listedRows();
		assert.deepEqual(
			rows.slice(1).map((row) => row.slice(2, 4)),
			limits.map(([, text]) => [text, text]),
		);
	});

	it("finds a model by its display name (#4269)", async () => {
		harness = await createHarness({
			models: [
				{ id: "model-x7", name: "Northwind Large" },
				{ id: "model-y2", name: "Southwind Small" },
			],
		});
		const provider = harness.models[0].provider;

		const rows = await listedRows("northwind");
		assert.deepEqual(
			rows.slice(1).map((row) => row[0]),
			[`${provider}/model-x7`],
		);
	});
});
