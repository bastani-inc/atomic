import type { TUI } from "@bastani/atomic-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getProviderBrandStyle,
	openRouterGlow,
	startBrandAnimation,
} from "../src/modes/interactive/components/provider-brand.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("provider brand styles", () => {
	beforeEach(() => {
		vi.stubEnv("COLORTERM", "truecolor");
		initTheme("dark");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		initTheme("dark");
	});

	describe("getProviderBrandStyle", () => {
		it("styles OpenRouter only", () => {
			expect(getProviderBrandStyle("radius")).toBeUndefined();
			expect(getProviderBrandStyle("openrouter")).toBe(openRouterGlow);
			expect(getProviderBrandStyle("anthropic")).toBeUndefined();
		});
	});

	describe("startBrandAnimation", () => {
		it("requests a render every 50 ms while animating and stops when told to", () => {
			vi.useFakeTimers();
			try {
				const requestRender = vi.fn();
				let animating = true;
				const stop = startBrandAnimation({ requestRender } as unknown as TUI, () => animating);

				vi.advanceTimersByTime(49);
				expect(requestRender).toHaveBeenCalledTimes(0);
				vi.advanceTimersByTime(1);
				expect(requestRender).toHaveBeenCalledTimes(1);
				vi.advanceTimersByTime(100);
				expect(requestRender).toHaveBeenCalledTimes(3);

				animating = false;
				vi.advanceTimersByTime(200);
				expect(requestRender).toHaveBeenCalledTimes(3);

				animating = true;
				vi.advanceTimersByTime(50);
				expect(requestRender).toHaveBeenCalledTimes(4);

				stop();
				vi.advanceTimersByTime(500);
				expect(requestRender).toHaveBeenCalledTimes(4);
			} finally {
				vi.useRealTimers();
			}
		});

		it("works with timers that cannot be unref'd", () => {
			const handle = 7 as unknown as ReturnType<typeof setInterval>;
			const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockReturnValue(handle);
			const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});

			const stop = startBrandAnimation({ requestRender: () => {} } as unknown as TUI, () => true);
			stop();

			expect(setIntervalSpy).toHaveBeenCalledTimes(1);
			expect(setIntervalSpy.mock.calls[0]?.[1]).toBe(50);
			expect(clearIntervalSpy).toHaveBeenCalledWith(handle);
		});
	});
});
