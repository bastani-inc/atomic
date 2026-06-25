import { describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

initTheme("dark");

function installSubmitHandler(host: Record<string, unknown>): (text: string) => Promise<void> {
  const setup = Reflect.get(InteractiveMode.prototype, "setupEditorSubmitHandler") as (this: Record<string, unknown>) => void;
  setup.call(host);
  return (host.defaultEditor as { onSubmit: (text: string) => Promise<void> }).onSubmit;
}

describe("first-run onboarding /new", () => {
  it("clears a stashed onboarding seed without completing onboarding", async () => {
    const settingsManager = SettingsManager.inMemory();
    const host = {
      firstRunOnboardingActive: true,
      firstRunOnboardingSeedInFlight: true,
      pendingFirstRunOnboardingSeed: "Implement the old ticket",
      defaultEditor: {},
      editor: { setText: vi.fn(), addToHistory: vi.fn() },
      sessionManager: { getCwd: vi.fn(() => process.cwd()) },
      loadingAnimation: undefined,
      statusContainer: { clear: vi.fn() },
      runtimeHost: { newSession: vi.fn().mockResolvedValue({ cancelled: false }) },
      handleClearCommand: Reflect.get(InteractiveMode.prototype, "handleClearCommand"),
      clearPendingFirstRunOnboardingSeed: Reflect.get(InteractiveMode.prototype, "clearPendingFirstRunOnboardingSeed"),
      renderCurrentSessionState: vi.fn(),
      chatContainer: { addChild: vi.fn() },
      ui: { requestRender: vi.fn() },
      handleFatalRuntimeError: vi.fn(),
      settingsManager,
    };
    const submit = installSubmitHandler(host);

    await submit("/new");

    expect(host.runtimeHost.newSession).toHaveBeenCalledTimes(1);
    expect(host.pendingFirstRunOnboardingSeed).toBeUndefined();
    expect(host.firstRunOnboardingSeedInFlight).toBe(false);
    expect(host.firstRunOnboardingActive).toBe(true);
    expect(settingsManager.getOnboardedVersion()).toBeUndefined();
    expect(host.renderCurrentSessionState).toHaveBeenCalledTimes(1);
  });
});
