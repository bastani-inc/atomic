import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

describe("Anthropic subscription warning auth failures", () => {
	it("ignores a stale non-OAuth lookup without rejecting the advisory warning path", async () => {
		const authFailure = new Error("stale Anthropic credential");
		const fakeThis = {
			anthropicSubscriptionWarningShown: false,
			settingsManager: { getWarnings: () => ({}) },
			session: {
				modelRuntime: {
					getAuth: vi.fn().mockRejectedValue(authFailure),
					isUsingOAuth: vi.fn().mockReturnValue(false),
				},
			},
			showError: vi.fn(),
			showWarning: vi.fn(),
		};

		const maybeWarn = (
			InteractiveMode as never as {
				prototype: {
					maybeWarnAboutAnthropicSubscriptionAuth: (
						this: typeof fakeThis,
						model: { provider: string },
					) => Promise<void>;
				};
			}
		).prototype.maybeWarnAboutAnthropicSubscriptionAuth;
		await expect(maybeWarn.call(fakeThis, { provider: "anthropic" })).resolves.toBeUndefined();

		expect(fakeThis.session.modelRuntime.getAuth).toHaveBeenCalledTimes(1);
		expect(fakeThis.showError).not.toHaveBeenCalled();
		expect(fakeThis.showWarning).not.toHaveBeenCalled();
		expect(fakeThis.anthropicSubscriptionWarningShown).toBe(false);
	});
});
