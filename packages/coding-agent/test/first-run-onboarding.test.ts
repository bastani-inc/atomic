import { beforeAll, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { ONBOARDING_COPY } from "../src/modes/interactive/interactive-onboarding.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function installSubmitHandler(host: Record<string, unknown>): (text: string) => Promise<void> {
  const setup = Reflect.get(InteractiveMode.prototype, "setupEditorSubmitHandler") as (this: Record<string, unknown>) => void;
  setup.call(host);
  return (host.defaultEditor as { onSubmit: (text: string) => Promise<void> }).onSubmit;
}

beforeAll(() => {
  initTheme("dark", false);
});

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

  it("shows verifiable runtime copy without task-routing instructions", () => {
    expect(ONBOARDING_COPY).toContain("verifiable coding agent runtime");
    expect(ONBOARDING_COPY).toContain("Start building a verifiable software factory");
    expect(ONBOARDING_COPY).toContain("Type a message or slash command below to continue normally");
    expect(ONBOARDING_COPY).not.toContain("Paste a ticket");
    expect(ONBOARDING_COPY).not.toContain("/chat");
    expect(ONBOARDING_COPY).not.toMatch(/goal.*ralph|ralph.*goal/);
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

  it("renders first-run notice after the changelog so it stays closest to the input", () => {
    const existingResource = { name: "resource" };
    const children: unknown[] = [existingResource];
    const setOnboardedVersion = vi.fn();
    const host = {
      startupNoticesShown: false,
      changelogMarkdown: "## [0.2.0]\n\n- New workflow updates",
      firstRunOnboardingActive: true,
      firstRunOnboardingNoticeComponents: [] as unknown[],
      chatContainer: {
        children,
        addChild(child: unknown) {
          this.children.push(child);
        },
      },
      settingsManager: {
        getCollapseChangelog: () => false,
        setOnboardedVersion,
      },
      version: "0.2.0",
      getMarkdownThemeWithSettings: () => ({}),
      ui: { requestRender: vi.fn() },
    };
    const showStartupNoticesIfNeeded = Reflect.get(InteractiveMode.prototype, "showStartupNoticesIfNeeded") as (this: typeof host) => void;

    showStartupNoticesIfNeeded.call(host);

    const firstNoticeIndex = host.chatContainer.children.indexOf(host.firstRunOnboardingNoticeComponents[0]);
    expect(firstNoticeIndex).toBeGreaterThan(0);
    expect(host.chatContainer.children.slice(firstNoticeIndex, firstNoticeIndex + host.firstRunOnboardingNoticeComponents.length)).toEqual(host.firstRunOnboardingNoticeComponents);
    expect(setOnboardedVersion).toHaveBeenCalledWith("0.2.0");
    expect(host.ui.requestRender).toHaveBeenCalledTimes(1);
  });

  it("removes rendered onboarding notice components without touching the normal editor", () => {
    const first = { name: "first" };
    const cta = [{ name: "border" }, { name: "copy" }, { name: "bottom" }];
    const last = { name: "last" };
    const host = {
      firstRunOnboardingActive: true,
      firstRunOnboardingNoticeComponents: cta,
      chatContainer: { children: [first, ...cta, last] },
      ui: { requestRender: vi.fn() },
    };
    const clear = Reflect.get(InteractiveMode.prototype, "clearFirstRunOnboardingUi") as (this: typeof host) => void;

    clear.call(host);

    expect(host.firstRunOnboardingActive).toBe(false);
    expect(host.chatContainer.children).toEqual([first, last]);
    expect(host.firstRunOnboardingNoticeComponents).toEqual([]);
    expect(host.ui.requestRender).toHaveBeenCalledTimes(1);
  });

  it("treats first-run text as normal input instead of an onboarding seed", async () => {
    const onInputCallback = vi.fn();
    const host = {
      firstRunOnboardingActive: true,
      defaultEditor: {},
      editor: { setText: vi.fn(), addToHistory: vi.fn() },
      flushPendingBashComponents: vi.fn(),
      onInputCallback,
      pendingUserInputs: [],
      session: { isBashRunning: false, isCompacting: false, isStreaming: false, prompt: vi.fn() },
    };
    const submit = installSubmitHandler(host);

    await submit("Implement ticket ABC");

    expect(onInputCallback).toHaveBeenCalledWith("Implement ticket ABC");
    expect(host.session.prompt).not.toHaveBeenCalled();
    expect(host.editor.addToHistory).toHaveBeenCalledWith("Implement ticket ABC");
  });

  it("treats /chat as an ordinary slash command with no onboarding bypass", async () => {
    const host = {
      firstRunOnboardingActive: true,
      defaultEditor: {},
      editor: { setText: vi.fn(), addToHistory: vi.fn() },
      flushPendingBashComponents: vi.fn(),
      onInputCallback: vi.fn(),
      pendingUserInputs: [],
      session: { isBashRunning: false, isCompacting: false, isStreaming: false, prompt: vi.fn() },
    };
    const submit = installSubmitHandler(host);

    await submit("/chat please explain the repo");

    expect(host.session.prompt).not.toHaveBeenCalled();
    expect(host.onInputCallback).toHaveBeenCalledWith("/chat please explain the repo");
  });
});
