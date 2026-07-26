import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const tempDirs: string[] = [];
afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function writeModels(path: string, ids: string[]): void {
	writeFileSync(path, JSON.stringify({
		providers: {
			layered: {
				api: "openai-completions",
				baseUrl: "https://example.test/v1",
				apiKey: "local",
				models: ids.map((id) => ({ id })),
			},
		},
	}));
}

describe("model registry layered hot reload", () => {
	test("reloads legacy and primary models.json layers on every refresh", async () => {
		const directory = mkdtempSync(join(tmpdir(), "atomic-model-reload-"));
		tempDirs.push(directory);
		const legacy = join(directory, "legacy-models.json");
		const primary = join(directory, "primary-models.json");
		writeModels(legacy, ["legacy"]);
		writeModels(primary, ["primary-before"]);
		const registry = ModelRegistry.create(AuthStorage.inMemory(), [legacy, primary]);
		expect(registry.find("layered", "legacy")).toBeDefined();
		expect(registry.find("layered", "primary-before")).toBeDefined();

		writeModels(primary, ["primary-after"]);
		await registry.refresh({ allowNetwork: false });

		expect(registry.find("layered", "legacy")).toBeDefined();
		expect(registry.find("layered", "primary-before")).toBeUndefined();
		expect(registry.find("layered", "primary-after")).toBeDefined();
	});

	test("reloads model layers from every newly opened /model picker", async () => {
		initTheme("dark");
		const refresh = vi.fn(async () => ({ aborted: false, errors: new Map() }));
		const registry = {
			getError: () => undefined,
			getAvailable: () => [],
			find: () => undefined,
			refresh,
		};
		const tui = { requestRender: vi.fn() };
		const openPicker = () => new ModelSelectorComponent(
			tui as never, undefined, {} as never, registry as never, [], () => {}, () => {},
		);

		openPicker();
		await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
		openPicker();
		await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
	});
});
