import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { ENV_OFFLINE, getEnvValue, setEnvValue } from "../src/config.ts";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.ts";
import "../src/modes/interactive/interactive-model-routing.ts";
import { shouldRefreshCatalogsOnStartup } from "../src/modes/interactive/interactive-startup.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const originalOffline = getEnvValue(ENV_OFFLINE);

// The cache-first selector builds the real ScopedModelsSelectorComponent synchronously, and that
// component reads the global theme while rendering its header, so the suite needs a theme loaded.
beforeAll(() => initTheme("dark"));

afterEach(() => {
	if (originalOffline === undefined) delete process.env[ENV_OFFLINE];
	else setEnvValue(ENV_OFFLINE, originalOffline);
	vi.restoreAllMocks();
});

test("offline deferred startup skips the catalog refresh", () => {
	setEnvValue(ENV_OFFLINE, "1");
	expect(shouldRefreshCatalogsOnStartup()).toBe(false);
});

test("offline model candidate startup restores caches without catalog network refresh", async () => {
	setEnvValue(ENV_OFFLINE, "1");
	const refresh = vi.fn(async () => ({ aborted: false, errors: new Map() }));
	const mode = {
		session: {
			scopedModels: [],
			modelRuntime: {
				refresh,
				getAvailableSnapshot: () => [],
			},
		},
	};

	await InteractiveModeBase.prototype.getModelCandidates.call(mode as never);

	expect(refresh).toHaveBeenCalledWith(expect.objectContaining({ allowNetwork: false }));
	expect(refresh.mock.calls[0]?.[0]).toMatchObject({ signal: expect.any(AbortSignal) });
});

test("footer provider count uses the current snapshot without refreshing catalogs", async () => {
	const refresh = vi.fn();
	const setAvailableProviderCount = vi.fn();
	const mode = {
		session: {
			scopedModels: [],
			modelRuntime: {
				refresh,
				getAvailableSnapshot: () => [{ provider: "one" }, { provider: "one" }, { provider: "two" }],
			},
		},
		footerDataProvider: { setAvailableProviderCount },
	};

	await InteractiveModeBase.prototype.updateAvailableProviderCount.call(mode as never);

	expect(refresh).not.toHaveBeenCalled();
	expect(setAvailableProviderCount).toHaveBeenCalledWith(2);
});
test("offline scoped-model selector starts a cache-only background refresh", async () => {
	setEnvValue(ENV_OFFLINE, "1");
	const refresh = vi.fn(async () => ({ aborted: false, errors: new Map() }));
	const showSelector = vi.fn(
		(factory: (done: () => void) => { component: object; focus: object; dispose?: () => void }) => {
			let dispose: (() => void) | undefined;
			const created = factory(() => dispose?.());
			dispose = created.dispose;
			return created;
		},
	);
	const mode = {
		session: { scopedModels: [], modelRuntime: { refresh, getAvailableSnapshot: () => [] } },
		settingsManager: { getEnabledModels: () => undefined },
		showSelector,
		ui: { requestRender: vi.fn() },
	};

	InteractiveModeBase.prototype.showModelsSelector.call(mode as never);

	await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
	expect(refresh).toHaveBeenCalledWith(
		expect.objectContaining({ allowNetwork: false, signal: expect.any(AbortSignal) }),
	);
	expect(showSelector).toHaveBeenCalledOnce();
});
