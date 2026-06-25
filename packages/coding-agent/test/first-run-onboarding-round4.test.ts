import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

function installSubmitHandler(host: Record<string, unknown>): (text: string) => Promise<void> {
  const setup = Reflect.get(InteractiveMode.prototype, "setupEditorSubmitHandler") as (this: Record<string, unknown>) => void;
  setup.call(host);
  return (host.defaultEditor as { onSubmit: (text: string) => Promise<void> }).onSubmit;
}

describe("first-run onboarding round 4 regressions", () => {
  it("clears active onboarding UI after resuming a non-fresh session without marking onboarded", async () => {
    const cta = [{ name: "border" }, { name: "copy" }];
    const host = {
      loadingAnimation: undefined,
      statusContainer: { clear: vi.fn() },
      runtimeHost: { switchSession: vi.fn().mockResolvedValue({ cancelled: false }) },
      renderCurrentSessionState: vi.fn(function(this: { session: { state: { messages: string[] } } }) {
        this.session.state.messages = ["old message"];
      }),
      showStatus: vi.fn(),
      firstRunOnboardingActive: true,
      firstRunOnboardingSeedInFlight: false,
      firstRunOnboardingHeaderComponents: cta,
      clearFirstRunOnboardingUi: Reflect.get(InteractiveMode.prototype, "clearFirstRunOnboardingUi"),
      isFirstRunOnboardingEligible: vi.fn(() => false),
      headerContainer: { children: [{ name: "top" }, ...cta, { name: "bottom" }] },
      defaultEditor: { setPlaceholder: vi.fn() },
      ui: { requestRender: vi.fn() },
      settingsManager: { setOnboardedVersion: vi.fn() },
      session: { state: { messages: [] } },
      createProjectTrustContext: vi.fn(),
      handleFatalRuntimeError: vi.fn(),
    };
    const resume = Reflect.get(InteractiveMode.prototype, "handleResumeSession") as (
      this: typeof host,
      sessionPath: string,
    ) => Promise<{ cancelled: boolean }>;

    await expect(resume.call(host, "session.jsonl")).resolves.toEqual({ cancelled: false });

    expect(host.firstRunOnboardingActive).toBe(false);
    expect(host.firstRunOnboardingHeaderComponents).toEqual([]);
    expect(host.headerContainer.children).toEqual([{ name: "top" }, { name: "bottom" }]);
    expect(host.defaultEditor.setPlaceholder).toHaveBeenCalledWith(undefined);
    expect(host.settingsManager.setOnboardedVersion).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith("Resumed session");
  });

  it("clears active onboarding UI after importing a session without marking onboarded", async () => {
    const cta = [{ name: "border" }, { name: "copy" }];
    const host = {
      loadingAnimation: undefined,
      statusContainer: { clear: vi.fn() },
      runtimeHost: { importFromJsonl: vi.fn().mockResolvedValue({ cancelled: false }) },
      renderCurrentSessionState: vi.fn(function(this: { session: { state: { messages: string[] } } }) {
        this.session.state.messages = ["imported message"];
      }),
      showStatus: vi.fn(),
      showError: vi.fn(),
      showExtensionConfirm: vi.fn().mockResolvedValue(true),
      firstRunOnboardingActive: true,
      firstRunOnboardingSeedInFlight: true,
      pendingFirstRunOnboardingSeed: "stashed seed",
      firstRunOnboardingHeaderComponents: cta,
      clearFirstRunOnboardingUi: Reflect.get(InteractiveMode.prototype, "clearFirstRunOnboardingUi"),
      headerContainer: { children: [{ name: "top" }, ...cta, { name: "bottom" }] },
      defaultEditor: { setPlaceholder: vi.fn() },
      ui: { requestRender: vi.fn() },
      settingsManager: { setOnboardedVersion: vi.fn() },
      session: { state: { messages: [] } },
      promptForMissingSessionCwd: vi.fn(),
      handleFatalRuntimeError: vi.fn(),
      getPathCommandArgument: Reflect.get(InteractiveMode.prototype, "getPathCommandArgument"),
    };
    const importCommand = Reflect.get(InteractiveMode.prototype, "handleImportCommand") as (
      this: typeof host,
      text: string,
    ) => Promise<void>;

    await importCommand.call(host, "/import imported.jsonl");

    expect(host.runtimeHost.importFromJsonl).toHaveBeenCalledWith("imported.jsonl");
    expect(host.firstRunOnboardingActive).toBe(false);
    expect(host.firstRunOnboardingSeedInFlight).toBe(false);
    expect(host.pendingFirstRunOnboardingSeed).toBeUndefined();
    expect(host.firstRunOnboardingHeaderComponents).toEqual([]);
    expect(host.headerContainer.children).toEqual([{ name: "top" }, { name: "bottom" }]);
    expect(host.defaultEditor.setPlaceholder).toHaveBeenCalledWith(undefined);
    expect(host.settingsManager.setOnboardedVersion).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith("Session imported from: imported.jsonl");
  });

  it("ignores duplicate onboarding seed submits while routing is in flight", async () => {
    let resolveSeed!: () => void;
    const firstSeed = new Promise<void>((resolve) => {
      resolveSeed = resolve;
    });
    const host = {
      firstRunOnboardingActive: true,
      firstRunOnboardingSeedInFlight: false,
      defaultEditor: {},
      editor: { setText: vi.fn(), addToHistory: vi.fn() },
      handleOnboardingWorkflowSeed: vi.fn().mockReturnValue(firstSeed),
      showError: vi.fn(),
      session: { isBashRunning: false, isCompacting: false, isStreaming: false, prompt: vi.fn() },
    };
    const submit = installSubmitHandler(host);

    const first = submit("Implement ticket ABC");
    const second = submit("Implement ticket ABC");

    expect(host.handleOnboardingWorkflowSeed).toHaveBeenCalledTimes(1);
    expect(host.editor.addToHistory).toHaveBeenCalledTimes(1);
    resolveSeed();
    await Promise.all([first, second]);
    expect(host.firstRunOnboardingSeedInFlight).toBe(false);
  });
});
