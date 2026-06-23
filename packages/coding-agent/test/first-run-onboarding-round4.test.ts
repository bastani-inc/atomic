import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { assessOnboardingRoute } from "../src/modes/interactive/interactive-onboarding.ts";

function installSubmitHandler(host: Record<string, unknown>): (text: string) => Promise<void> {
  const setup = Reflect.get(InteractiveMode.prototype, "setupEditorSubmitHandler") as (this: Record<string, unknown>) => void;
  setup.call(host);
  return (host.defaultEditor as { onSubmit: (text: string) => Promise<void> }).onSubmit;
}

describe("first-run onboarding round 4 regressions", () => {
  it("does not count URL path segments as localized fallback path evidence", () => {
    const bareIssue = assessOnboardingRoute("https://github.com/acme/widget/issues/123", process.cwd());
    const bareDocsUrl = assessOnboardingRoute("https://example.com/docs/setup/install", process.cwd());
    const localPath = assessOnboardingRoute("Fix typo in packages/coding-agent/docs/quickstart.md", process.cwd());

    expect(bareIssue.workflow).toBe("ralph");
    expect(bareDocsUrl.workflow).toBe("ralph");
    expect(bareIssue.touchedAreas).not.toContain("github.com/acme");
    expect(localPath.workflow).toBe("goal");
  });

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
