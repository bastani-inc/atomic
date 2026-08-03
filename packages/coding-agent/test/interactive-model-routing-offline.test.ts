import { afterEach, expect, test, vi } from "vitest";
import { ENV_OFFLINE, getEnvValue, setEnvValue } from "../src/config.ts";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.ts";
import "../src/modes/interactive/interactive-model-routing.ts";
import { shouldRefreshCatalogsOnStartup } from "../src/modes/interactive/interactive-startup.ts";

const originalOffline = getEnvValue(ENV_OFFLINE);

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
test("offline scoped-model selector refresh stays cache-only", async () => {
	setEnvValue(ENV_OFFLINE, "1");
	const refresh = vi.fn(async () => ({ aborted: false, errors: new Map() }));
	const showStatus = vi.fn();
	const mode = {
		session: { scopedModels: [], modelRuntime: { refresh, getAvailableSnapshot: () => [] } },
		settingsManager: { getEnabledModels: () => undefined },
		showStatus,
	};

	await InteractiveModeBase.prototype.showModelsSelector.call(mode as never);

	expect(refresh).toHaveBeenCalledWith({ allowNetwork: false });
	expect(showStatus).toHaveBeenCalledWith("No models available");
});
