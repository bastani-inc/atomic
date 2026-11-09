import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getProviderBrandStyle,
	openRouterGlow,
	radiusShimmer,
	startBrandAnimation,
} from "../src/modes/interactive/components/provider-brand.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type Rgb = readonly [number, number, number];

const LOGO_COLORS: readonly Rgb[] = [
	[0x4d, 0x9a, 0xbf],
	[0x83, 0xcc, 0xd2],
	[0xf1, 0xbe, 0x57],
	[0xf0, 0x90, 0x82],
];

function charColors(styled: string): { char: string; rgb: Rgb }[] {
	return [...styled.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m(.)/gu)].map((match) => ({
		char: match[4] as string,
		rgb: [Number(match[1]), Number(match[2]), Number(match[3])],
	}));
}

function expectColor(actual: Rgb, expected: Rgb): void {
	for (const [index, channel] of actual.entries()) {
		expect(Math.abs(channel - (expected[index] as number))).toBeLessThanOrEqual(1);
	}
}

function mix(from: Rgb, to: Rgb, amount: number): Rgb {
	return from.map((channel, index) => channel + ((to[index] as number) - channel) * amount) as unknown as Rgb;
}

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
		it("styles Radius and OpenRouter only", () => {
			expect(getProviderBrandStyle("radius")).toBe(radiusShimmer);
			expect(getProviderBrandStyle("openrouter")).toBe(openRouterGlow);
			expect(getProviderBrandStyle("anthropic")).toBeUndefined();
		});
	});

	describe("radiusShimmer", () => {
		it("starts each four-character band on a Radius logo color and wraps after sixteen characters", () => {
			const colors = charColors(radiusShimmer("abcdefghijklmnopq", 0));

			expect(colors.map(({ char }) => char).join("")).toBe("abcdefghijklmnopq");
			expectColor(colors[0]?.rgb as Rgb, LOGO_COLORS[0] as Rgb);
			expectColor(colors[4]?.rgb as Rgb, LOGO_COLORS[1] as Rgb);
			expectColor(colors[8]?.rgb as Rgb, LOGO_COLORS[2] as Rgb);
			expectColor(colors[12]?.rgb as Rgb, LOGO_COLORS[3] as Rgb);
			expectColor(colors[16]?.rgb as Rgb, LOGO_COLORS[0] as Rgb);
		});

		it("blends toward the next color with a smoothstep inside a band", () => {
			const colors = charColors(radiusShimmer("abcd", 0));

			expectColor(colors[1]?.rgb as Rgb, mix(LOGO_COLORS[0] as Rgb, LOGO_COLORS[1] as Rgb, 0.15625));
			expectColor(colors[2]?.rgb as Rgb, mix(LOGO_COLORS[0] as Rgb, LOGO_COLORS[1] as Rgb, 0.5));
			expectColor(colors[3]?.rgb as Rgb, mix(LOGO_COLORS[0] as Rgb, LOGO_COLORS[1] as Rgb, 0.84375));
		});

		it("blends the last band back into the first color", () => {
			const colors = charColors(radiusShimmer("abcdefghijklmnop", 0));

			expectColor(colors[14]?.rgb as Rgb, mix(LOGO_COLORS[3] as Rgb, LOGO_COLORS[0] as Rgb, 0.5));
		});

		it("flows left to right at ten characters per second", () => {
			const colors = charColors(radiusShimmer("abcdefgh", 400));

			expectColor(colors[4]?.rgb as Rgb, LOGO_COLORS[0] as Rgb);
			expectColor(colors[0]?.rgb as Rgb, LOGO_COLORS[3] as Rgb);
			expectColor(colors[7]?.rgb as Rgb, mix(LOGO_COLORS[0] as Rgb, LOGO_COLORS[1] as Rgb, 0.84375));
		});

		it("repeats every 1.6 seconds", () => {
			expect(radiusShimmer("Radius", 1600)).toBe(radiusShimmer("Radius", 0));
			expect(radiusShimmer("Radius", 3200)).toBe(radiusShimmer("Radius", 0));
			expect(radiusShimmer("Radius", 800)).not.toBe(radiusShimmer("Radius", 0));
		});

		it("closes the foreground color after the text", () => {
			expect(radiusShimmer("Radius", 0).endsWith("s\x1b[39m")).toBe(true);
		});

		it("uses 256-color codes in a 256-color terminal", () => {
			vi.stubEnv("COLORTERM", "");
			vi.stubEnv("TERM", "linux");
			vi.stubEnv("WT_SESSION", "");
			initTheme("dark");

			const styled = radiusShimmer("Radius", 0);
			expect(styled).toContain("\x1b[38;5;");
			expect(styled).not.toContain("\x1b[38;2;");
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
