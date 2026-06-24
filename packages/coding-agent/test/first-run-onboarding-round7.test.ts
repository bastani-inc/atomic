import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import {
  ONBOARDING_PLACEHOLDER,
  isExistingAbsolutePathSeed,
} from "../src/modes/interactive/interactive-onboarding.ts";

function installSubmitHandler(host: Record<string, unknown>): (text: string) => Promise<void> {
  const setup = Reflect.get(InteractiveMode.prototype, "setupEditorSubmitHandler") as (this: Record<string, unknown>) => void;
  setup.call(host);
  return (host.defaultEditor as { onSubmit: (text: string) => Promise<void> }).onSubmit;
}

async function initHostWithOptions(
  options: { initialMessage?: string; initialMessages?: string[] },
  configureSettings?: (settingsManager: SettingsManager) => void,
  storedAuthProviders: string[] = [],
) {
  const settingsManager = SettingsManager.inMemory();
  settingsManager.setQuietStartup(true);
  configureSettings?.(settingsManager);
  const host = {
    isInitialized: false,
    options,
    version: "9.9.9-test",
    session: {
      state: { messages: [] },
      modelRegistry: {
        getError: () => undefined,
        authStorage: { list: () => storedAuthProviders },
      },
    },
    settingsManager,
    registerSignalHandlers: vi.fn(),
    getChangelogForDisplay: Reflect.get(InteractiveMode.prototype, "getChangelogForDisplay"),
    reportInstallTelemetry: vi.fn(),
    ui: { addChild: vi.fn(), setFocus: vi.fn(), start: vi.fn(), requestRender: vi.fn() },
    headerContainer: { addChild: vi.fn(), children: [] },
    chatContainer: { children: [], addChild: vi.fn() },
    pendingMessagesContainer: {},
    statusContainer: {},
    renderWidgets: vi.fn(),
    widgetContainerAbove: {},
    usageMeter: {},
    editorContainer: {},
    footer: {},
    widgetContainerBelow: {},
    editor: {},
    setupKeyHandlers: vi.fn(),
    setupEditorSubmitHandler: vi.fn(),
    isFirstRunOnboardingEligible: Reflect.get(InteractiveMode.prototype, "isFirstRunOnboardingEligible"),
    firstRunOnboardingActive: false,
    firstRunOnboardingHeaderComponents: [],
    defaultEditor: { setPlaceholder: vi.fn() },
    themeController: { applyFromSettings: vi.fn().mockResolvedValue(undefined) },
    rebindCurrentSession: vi.fn().mockResolvedValue(undefined),
    renderInitialMessages: vi.fn(),
    footerDataProvider: { onBranchChange: vi.fn() },
    updateAvailableProviderCount: vi.fn().mockResolvedValue(undefined),
    setupAutocompleteProvider: vi.fn(),
  };
  const init = Reflect.get(InteractiveMode.prototype, "init") as (this: typeof host) => Promise<void>;
  await init.call(host);
  return host;
}

describe("first-run onboarding round 7 regressions", () => {
  it("starts onboarding for a fresh install with no returning-user evidence", async () => {
    const host = await initHostWithOptions({});

    expect(host.settingsManager.getFirstRunOnboardingStartedVersion()).toBe("9.9.9-test");
    expect(host.settingsManager.getOnboardedVersion()).toBeUndefined();
    expect(host.firstRunOnboardingActive).toBe(true);
    expect(host.defaultEditor.setPlaceholder).toHaveBeenCalledWith(ONBOARDING_PLACEHOLDER);
  });

  it("marks copied settings with lastChangelogVersion as an onboarded returning user", async () => {
    const host = await initHostWithOptions({}, (settingsManager) => {
      settingsManager.setLastChangelogVersion("0.9.1");
    });

    expect(host.settingsManager.getFirstRunOnboardingStartedVersion()).toBeUndefined();
    expect(host.settingsManager.getOnboardedVersion()).toBe("9.9.9-test");
    expect(host.firstRunOnboardingActive).toBe(false);
    expect(host.defaultEditor.setPlaceholder).not.toHaveBeenCalled();
  });

  it("still starts onboarding when stored auth is the only prior state", async () => {
    const host = await initHostWithOptions({}, undefined, ["github-copilot"]);

    expect(host.settingsManager.getFirstRunOnboardingStartedVersion()).toBe("9.9.9-test");
    expect(host.settingsManager.getOnboardedVersion()).toBeUndefined();
    expect(host.firstRunOnboardingActive).toBe(true);
    expect(host.defaultEditor.setPlaceholder).toHaveBeenCalledWith(ONBOARDING_PLACEHOLDER);
  });

  it("keeps unfinished onboarding active even after auth and changelog state exist", async () => {
    const host = await initHostWithOptions({}, (settingsManager) => {
      settingsManager.setLastChangelogVersion("9.9.9-test");
      settingsManager.setFirstRunOnboardingStartedVersion("9.9.9-test");
    }, ["github-copilot"]);

    expect(host.settingsManager.getFirstRunOnboardingStartedVersion()).toBe("9.9.9-test");
    expect(host.settingsManager.getOnboardedVersion()).toBeUndefined();
    expect(host.firstRunOnboardingActive).toBe(true);
    expect(host.defaultEditor.setPlaceholder).toHaveBeenCalledWith(ONBOARDING_PLACEHOLDER);
  });

  it("keeps completed onboarding skipped even when copied settings have lastChangelogVersion", async () => {
    const host = await initHostWithOptions({}, (settingsManager) => {
      settingsManager.setLastChangelogVersion("0.9.1");
      settingsManager.setOnboardedVersion("0.9.1");
    });

    expect(host.settingsManager.getFirstRunOnboardingStartedVersion()).toBeUndefined();
    expect(host.firstRunOnboardingActive).toBe(false);
    expect(host.defaultEditor.setPlaceholder).not.toHaveBeenCalled();
  });

  it("persists the start marker during initial-message runs without activating onboarding", async () => {
    for (const options of [{ initialMessage: "run this once" }, { initialMessages: ["run this once"] }]) {
      const host = await initHostWithOptions(options);

      expect(host.settingsManager.getFirstRunOnboardingStartedVersion()).toBe("9.9.9-test");
      expect(host.settingsManager.getOnboardedVersion()).toBeUndefined();
      expect(host.firstRunOnboardingActive).toBe(false);
      expect(host.defaultEditor.setPlaceholder).not.toHaveBeenCalled();
      expect(host.isFirstRunOnboardingEligible.call({
        ...host,
        options: {},
        session: { state: { messages: [] } },
      })).toBe(true);
    }
  });

  it("clears active onboarding after resuming an empty existing session without marking onboarded", async () => {
    const cta = [{ name: "border" }, { name: "copy" }];
    const host = {
      loadingAnimation: undefined,
      statusContainer: { clear: vi.fn() },
      runtimeHost: { switchSession: vi.fn().mockResolvedValue({ cancelled: false }) },
      renderCurrentSessionState: vi.fn(function(this: { session: { state: { messages: string[] } } }) {
        this.session.state.messages = [];
      }),
      showStatus: vi.fn(),
      firstRunOnboardingActive: true,
      firstRunOnboardingSeedInFlight: false,
      firstRunOnboardingHeaderComponents: cta,
      clearFirstRunOnboardingUi: Reflect.get(InteractiveMode.prototype, "clearFirstRunOnboardingUi"),
      isFirstRunOnboardingEligible: vi.fn(() => true),
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

    await expect(resume.call(host, "empty-session.jsonl")).resolves.toEqual({ cancelled: false });

    expect(host.isFirstRunOnboardingEligible).not.toHaveBeenCalled();
    expect(host.firstRunOnboardingActive).toBe(false);
    expect(host.firstRunOnboardingHeaderComponents).toEqual([]);
    expect(host.headerContainer.children).toEqual([{ name: "top" }, { name: "bottom" }]);
    expect(host.defaultEditor.setPlaceholder).toHaveBeenCalledWith(undefined);
    expect(host.settingsManager.setOnboardedVersion).not.toHaveBeenCalled();
  });

  it("completes onboarding when the seed is handed to the normal agent session", async () => {
    const onInputCallback = vi.fn();
    const host = {
      pendingUserInputs: [],
      onInputCallback,
      flushPendingBashComponents: vi.fn(),
      showStatus: vi.fn(),
      footer: { invalidate: vi.fn() },
      updateEditorBorderColor: vi.fn(),
      session: { setThinkingLevel: vi.fn() },
      completeFirstRunOnboarding: vi.fn(),
    };
    const handleSeed = Reflect.get(InteractiveMode.prototype, "handleOnboardingWorkflowSeed") as (
      this: typeof host,
      seed: string,
    ) => Promise<void>;

    await expect(handleSeed.call(host, "Fix a small bug")).resolves.toBeUndefined();

    expect(onInputCallback.mock.calls[0]?.[0]).toContain("Original task seed");
    expect(onInputCallback.mock.calls[0]?.[0]).toContain("Fix a small bug");
    expect(onInputCallback.mock.calls[0]?.[0]).toContain("Start the selected workflow");
    expect(host.session.setThinkingLevel).toHaveBeenCalledWith("high");
    expect(host.completeFirstRunOnboarding).toHaveBeenCalledTimes(1);
  });

  it("routes outside-cwd absolute paths as raw seeds without reading them as specs", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "atomic-onboarding-cwd-"));
    const outside = mkdtempSync(join(tmpdir(), "atomic-onboarding-outside-"));
    const outsideSpec = join(outside, "outside spec.md");
    writeFileSync(outsideSpec, "OUTSIDE SECRET SPEC BODY");
    const submitHost = {
      firstRunOnboardingActive: true,
      firstRunOnboardingSeedInFlight: false,
      defaultEditor: {},
      editor: { setText: vi.fn(), addToHistory: vi.fn() },
      handleOnboardingWorkflowSeed: vi.fn().mockResolvedValue(undefined),
      showError: vi.fn(),
      sessionManager: { getCwd: () => cwd },
      session: { isBashRunning: false, isCompacting: false, isStreaming: false, prompt: vi.fn() },
    };
    const submit = installSubmitHandler(submitHost);

    await submit(outsideSpec);

    expect(isExistingAbsolutePathSeed(outsideSpec)).toBe(true);
    expect(submitHost.handleOnboardingWorkflowSeed).toHaveBeenCalledWith(outsideSpec);
    expect(submitHost.session.prompt).not.toHaveBeenCalled();
  });
});
