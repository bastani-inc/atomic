import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

describe("Anthropic subscription warning auth failures", () => {
	it("reports a stale OAuth lookup without rejecting the advisory warning path", async () => {
		const authFailure = new Error("stale Anthropic OAuth credential");
		const fakeThis = {
			anthropicSubscriptionWarningShown: false,
			settingsManager: { getWarnings: () => ({}) },
			session: {
				modelRuntime: {
					getAuth: vi.fn().mockRejectedValue(authFailure),
					isUsingOAuth: vi.fn().mockReturnValue(true),
				},
			},
			showError: vi.fn(),
			showWarning: vi.fn(),
		};

		const maybeWarn = (InteractiveMode as never as {
			prototype: {
				maybeWarnAboutAnthropicSubscriptionAuth: (
					this: typeof fakeThis,
					model: { provider: string },
				) => Promise<void>;
			};
		}).prototype.maybeWarnAboutAnthropicSubscriptionAuth;
		await expect(maybeWarn.call(fakeThis, { provider: "anthropic" })).resolves.toBeUndefined();

		expect(fakeThis.showError).toHaveBeenCalledWith(
			"Could not check Anthropic subscription authentication: stale Anthropic OAuth credential",
		);
		expect(fakeThis.showWarning).not.toHaveBeenCalled();
		// The warning remains eligible and the same session can retry after credentials are repaired.
		expect(fakeThis.anthropicSubscriptionWarningShown).toBe(false);
		fakeThis.session.modelRuntime.getAuth.mockResolvedValue({ auth: { type: "oauth" } });
		await expect(maybeWarn.call(fakeThis, { provider: "anthropic" })).resolves.toBeUndefined();
		expect(fakeThis.showWarning).toHaveBeenCalledTimes(1);
	});
});
