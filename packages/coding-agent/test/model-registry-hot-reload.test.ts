import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import type { SettingsManager } from "../src/core/settings-manager.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const tempDirs: string[] = [];
afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function writeModels(path: string, ids: string[]): void {
	writeFileSync(
		path,
		JSON.stringify({
			providers: {
				configured: {
					api: "openai-completions",
					baseUrl: "https://example.test/v1",
					apiKey: "local",
					models: ids.map((id) => ({ id })),
				},
			},
		}),
	);
}

describe("model config hot reload", () => {
	test("reloads the configured models.json file on every refresh", async () => {
		const directory = mkdtempSync(join(tmpdir(), "atomic-model-reload-"));
		tempDirs.push(directory);
		const modelsPath = join(directory, "models.json");
		writeModels(modelsPath, ["before"]);
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath,
			allowModelNetwork: false,
		});
		expect(runtime.getModel("configured", "before")).toBeDefined();

		writeModels(modelsPath, ["after"]);
		await runtime.refresh({ allowNetwork: false });

		expect(runtime.getModel("configured", "before")).toBeUndefined();
		expect(runtime.getModel("configured", "after")).toBeDefined();
	});

	test("refreshes the model config from every newly opened /model picker", async () => {
		initTheme("dark");
		const refresh = vi.fn(async () => ({ aborted: false, errors: new Map() }));
		const runtime = {
			getError: () => undefined,
			getAvailableSnapshot: () => [],
			getModel: () => undefined,
			refresh,
		} as unknown as ModelRuntime;
		const tui = { requestRender: vi.fn() } as unknown as TUI;
		const settings = { setDefaultModelAndProvider: vi.fn() } as unknown as SettingsManager;
		const openPicker = () =>
			new ModelSelectorComponent(
				tui,
				undefined,
				settings,
				runtime,
				[],
				() => {},
				() => {},
			);

		openPicker();
		await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
		openPicker();
		await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
	});
});
