import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
  NORMAL_CHAT_TRANSITION_COPY,
  ONBOARDING_COPY,
  ONBOARDING_PLACEHOLDER,
} from "../src/modes/interactive/interactive-onboarding.ts";

function installSubmitHandler(host: Record<string, unknown>): (text: string) => Promise<void> {
  const setup = Reflect.get(InteractiveMode.prototype, "setupEditorSubmitHandler") as (this: Record<string, unknown>) => void;
  setup.call(host);
  return (host.defaultEditor as { onSubmit: (text: string) => Promise<void> }).onSubmit;
}

describe("first-run onboarding", () => {
  it("stores onboarding start and completion separately from lastChangelogVersion", () => {
    const manager = SettingsManager.inMemory();
    manager.setLastChangelogVersion("0.1.0");
    manager.setFirstRunOnboardingStartedVersion("0.2.0");
    manager.setOnboardedVersion("0.3.0");

    expect(manager.getLastChangelogVersion()).toBe("0.1.0");
    expect(manager.getFirstRunOnboardingStartedVersion()).toBe("0.2.0");
    expect(manager.getOnboardedVersion()).toBe("0.3.0");
  });

  it("gates first-run onboarding on an empty started session and missing onboardedVersion", () => {
    const isEligible = Reflect.get(InteractiveMode.prototype, "isFirstRunOnboardingEligible") as (this: {
      session: { state: { messages: string[] } };
      settingsManager: {
        getFirstRunOnboardingStartedVersion: () => string | undefined;
        getOnboardedVersion: () => string | undefined;
      };
      options: { initialMessage?: string; initialMessages?: string[] };
    }) => boolean;
    const settingsManager = {
      getFirstRunOnboardingStartedVersion: () => "0.2.0",
      getOnboardedVersion: () => undefined,
    };

    expect(ONBOARDING_COPY).toContain("Paste a ticket description");
    expect(ONBOARDING_COPY).toContain("first run /login");
    expect(ONBOARDING_PLACEHOLDER).toContain("Paste a ticket");
    expect(isEligible.call({ session: { state: { messages: [] } }, settingsManager, options: {} })).toBe(true);
    expect(isEligible.call({ session: { state: { messages: ["old"] } }, settingsManager, options: {} })).toBe(false);
    expect(isEligible.call({ session: { state: { messages: [] } }, settingsManager: { ...settingsManager, getOnboardedVersion: () => "0.1.0" }, options: {} })).toBe(false);
    expect(isEligible.call({ session: { state: { messages: [] } }, settingsManager: { ...settingsManager, getFirstRunOnboardingStartedVersion: () => undefined }, options: {} })).toBe(false);
    expect(isEligible.call({ session: { state: { messages: [] } }, settingsManager, options: { initialMessage: "run once" } })).toBe(false);
    expect(isEligible.call({ session: { state: { messages: [] } }, settingsManager, options: { initialMessages: ["one"] } })).toBe(false);
  });

  it("uses a separate onboarding-start marker after changelog startup records the current version", () => {
    const manager = SettingsManager.inMemory();
    const host = {
      session: { state: { messages: [] } },
      settingsManager: manager,
      reportInstallTelemetry: vi.fn(),
      hadLastChangelogVersionAtStartup: Boolean(manager.getLastChangelogVersion()),
    };
    const getChangelogForDisplay = Reflect.get(InteractiveMode.prototype, "getChangelogForDisplay") as (this: typeof host) => string | undefined;
    const isEligible = Reflect.get(InteractiveMode.prototype, "isFirstRunOnboardingEligible") as (this: typeof host) => boolean;

    expect(getChangelogForDisplay.call(host)).toBeUndefined();
    expect(manager.getLastChangelogVersion()).toBeTruthy();
    expect(isEligible.call({ ...host, options: {} })).toBe(false);
    manager.setFirstRunOnboardingStartedVersion("0.2.0");
    expect(isEligible.call({ ...host, options: {} })).toBe(true);

    const upgraded = SettingsManager.inMemory();
    upgraded.setLastChangelogVersion("0.1.0");
    expect(isEligible.call({ ...host, settingsManager: upgraded, hadLastChangelogVersionAtStartup: true, options: {} })).toBe(false);
  });

  it("removes rendered onboarding header components when onboarding completes", () => {
    const first = { name: "first" };
    const cta = [{ name: "border" }, { name: "copy" }, { name: "bottom" }];
    const last = { name: "last" };
    const host = {
      version: "0.2.0",
      firstRunOnboardingActive: true,
      firstRunOnboardingHeaderComponents: cta,
      headerContainer: { children: [first, ...cta, last] },
      settingsManager: { setOnboardedVersion: vi.fn() },
      defaultEditor: { setPlaceholder: vi.fn() },
      ui: { requestRender: vi.fn() },
    };
    const complete = Reflect.get(InteractiveMode.prototype, "completeFirstRunOnboarding") as (this: typeof host) => void;

    complete.call(host);

    expect(host.firstRunOnboardingActive).toBe(false);
    expect(host.headerContainer.children).toEqual([first, last]);
    expect(host.firstRunOnboardingHeaderComponents).toEqual([]);
    expect(host.settingsManager.setOnboardedVersion).toHaveBeenCalledWith("0.2.0");
    expect(host.defaultEditor.setPlaceholder).toHaveBeenCalledWith(undefined);
    expect(host.ui.requestRender).toHaveBeenCalledTimes(1);
  });

  it("/chat exits onboarding and sends a message through normal input", async () => {
    const onInputCallback = vi.fn();
    const host = {
      firstRunOnboardingActive: true,
      defaultEditor: {},
      editor: { setText: vi.fn(), addToHistory: vi.fn() },
      completeFirstRunOnboarding: vi.fn(),
      showStatus: vi.fn(),
      flushPendingBashComponents: vi.fn(),
      onInputCallback,
      pendingUserInputs: [],
      session: { isBashRunning: false, isCompacting: false, isStreaming: false, prompt: vi.fn() },
    };
    const submit = installSubmitHandler(host);

    await submit("/chat please explain the repo");

    expect(host.completeFirstRunOnboarding).toHaveBeenCalledTimes(1);
    expect(host.showStatus).toHaveBeenCalledWith(NORMAL_CHAT_TRANSITION_COPY);
    expect(onInputCallback).toHaveBeenCalledWith("please explain the repo");
    expect(host.session.prompt).not.toHaveBeenCalled();
  });

  it("slash commands other than /chat pass through without completing onboarding", async () => {
    const onInputCallback = vi.fn();
    const host = {
      firstRunOnboardingActive: true,
      defaultEditor: {},
      editor: { setText: vi.fn(), addToHistory: vi.fn() },
      completeFirstRunOnboarding: vi.fn(),
      handleOnboardingWorkflowSeed: vi.fn(),
      showOAuthSelector: vi.fn(),
      flushPendingBashComponents: vi.fn(),
      onInputCallback,
      pendingUserInputs: [],
      sessionManager: { getCwd: () => process.cwd() },
      session: { isBashRunning: false, isCompacting: false, isStreaming: false, prompt: vi.fn() },
    };
    const submit = installSubmitHandler(host);

    await submit("/login");
    await submit("/workflow status");

    expect(host.showOAuthSelector).toHaveBeenCalledWith("login");
    expect(onInputCallback).toHaveBeenCalledWith("/workflow status");
    expect(host.completeFirstRunOnboarding).not.toHaveBeenCalled();
    expect(host.handleOnboardingWorkflowSeed).not.toHaveBeenCalled();
  });

  it("treats cwd-local absolute spec paths with spaces as onboarding seeds instead of slash commands", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "atomic onboarding "));
    const specPath = join(cwd, "spec with spaces.md");
    writeFileSync(specPath, "# Local spec\n\nFix the local onboarding route.");
    const host = {
      firstRunOnboardingActive: true,
      defaultEditor: {},
      editor: { setText: vi.fn(), addToHistory: vi.fn() },
      handleOnboardingWorkflowSeed: vi.fn().mockResolvedValue(undefined),
      showError: vi.fn(),
      sessionManager: { getCwd: () => cwd },
      session: { isBashRunning: false, isCompacting: false, isStreaming: false, prompt: vi.fn() },
    };
    const submit = installSubmitHandler(host);

    await submit(specPath);

    expect(host.handleOnboardingWorkflowSeed).toHaveBeenCalledWith(specPath);
    expect(host.session.prompt).not.toHaveBeenCalled();
    expect(host.editor.setText).toHaveBeenCalledWith("");
  });

  it("does not complete onboarding when handoff fails", async () => {
    const host = {
      firstRunOnboardingActive: true,
      defaultEditor: {},
      editor: { setText: vi.fn(), addToHistory: vi.fn() },
      handleOnboardingWorkflowSeed: vi.fn().mockRejectedValue(new Error("no auth")),
      completeFirstRunOnboarding: vi.fn(),
      showError: vi.fn(),
      session: { isBashRunning: false, isCompacting: false, isStreaming: false, prompt: vi.fn() },
    };
    const submit = installSubmitHandler(host);

    await submit("Implement ticket ABC");

    expect(host.handleOnboardingWorkflowSeed).toHaveBeenCalledWith("Implement ticket ABC");
    expect(host.completeFirstRunOnboarding).not.toHaveBeenCalled();
    expect(host.showError).toHaveBeenCalledWith("no auth");
    expect(host.editor.setText).toHaveBeenLastCalledWith("Implement ticket ABC");
  });
});
