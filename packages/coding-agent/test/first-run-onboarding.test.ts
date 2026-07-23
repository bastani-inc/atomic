import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Component } from "@earendil-works/pi-tui";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { ONBOARDING_COPY } from "../src/modes/interactive/interactive-onboarding.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type SubmitHandlerHost = {
  defaultEditor?: { onSubmit?: (text: string) => Promise<void> };
};

function installSubmitHandler<T extends SubmitHandlerHost>(host: T): (text: string) => Promise<void> {
  const setup = Reflect.get(InteractiveMode.prototype, "setupEditorSubmitHandler") as (this: T) => void;
  setup.call(host);
  const onSubmit = host.defaultEditor?.onSubmit;
  if (!onSubmit) {
    throw new Error("setupEditorSubmitHandler did not install an onSubmit handler");
  }
  return onSubmit;
}

type TestComponent = Component & { readonly name: string };

function testComponent(name: string): TestComponent {
  return {
    name,
    render: () => [name],
  };
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
    expect(ONBOARDING_COPY).toContain("run `/login` first");
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

  it("auto-completes onboarding for returning users with prior changelog state", () => {
    const manager = SettingsManager.inMemory();
    manager.setLastChangelogVersion("0.1.0");
    const host = {
      session: { state: { messages: [] } },
      settingsManager: manager,
      hadLastChangelogVersionAtStartup: true,
      version: "0.2.0",
    };
    const initialize = Reflect.get(InteractiveMode.prototype, "initializeFirstRunOnboardingMarkers") as (this: typeof host) => void;

    initialize.call(host);

    expect(manager.getOnboardedVersion()).toBe("0.2.0");
    expect(manager.getFirstRunOnboardingStartedVersion()).toBeUndefined();
  });

  it("starts onboarding for fresh installs but does not activate it for initial input runs", () => {
    const manager = SettingsManager.inMemory();
    const host = {
      session: { state: { messages: [] } },
      settingsManager: manager,
      hadLastChangelogVersionAtStartup: false,
      version: "0.2.0",
    };
    const initialize = Reflect.get(InteractiveMode.prototype, "initializeFirstRunOnboardingMarkers") as (this: typeof host) => void;
    const isEligible = Reflect.get(InteractiveMode.prototype, "isFirstRunOnboardingEligible") as (this: typeof host & { options: { initialMessage?: string } }) => boolean;

    initialize.call(host);

    expect(manager.getFirstRunOnboardingStartedVersion()).toBe("0.2.0");
    expect(manager.getOnboardedVersion()).toBeUndefined();
    expect(isEligible.call({ ...host, options: { initialMessage: "run once" } })).toBe(false);
  });

  it("renders first-run notice without changelog markdown", () => {
    const setOnboardedVersion = vi.fn();
    const children: Component[] = [];
    const host = {
      startupNoticesShown: false,
      changelogMarkdown: undefined,
      firstRunNoticeVisible: true,
      firstRunOnboardingNoticeComponents: [] as Component[],
      chatContainer: {
        children,
        addChild(child: Component) {
          this.children.push(child);
        },
      },
      settingsManager: { setOnboardedVersion },
      version: "0.2.0",
      ui: { requestRender: vi.fn() },
    };
    const showStartupNoticesIfNeeded = Reflect.get(InteractiveMode.prototype, "showStartupNoticesIfNeeded") as (this: typeof host) => void;

    showStartupNoticesIfNeeded.call(host);

    expect(host.firstRunOnboardingNoticeComponents).toHaveLength(4);
    expect(host.chatContainer.children).toEqual(host.firstRunOnboardingNoticeComponents);
    expect(setOnboardedVersion).toHaveBeenCalledWith("0.2.0");
    expect(host.ui.requestRender).toHaveBeenCalledTimes(1);
  });

  it("does not queue startup notices more than once", () => {
    const setOnboardedVersion = vi.fn();
    const children: Component[] = [];
    const host = {
      startupNoticesShown: false,
      changelogMarkdown: undefined,
      firstRunNoticeVisible: true,
      firstRunOnboardingNoticeComponents: [] as Component[],
      chatContainer: {
        children,
        addChild(child: Component) {
          this.children.push(child);
        },
      },
      settingsManager: { setOnboardedVersion },
      version: "0.2.0",
      ui: { requestRender: vi.fn() },
    };
    const showStartupNoticesIfNeeded = Reflect.get(InteractiveMode.prototype, "showStartupNoticesIfNeeded") as (this: typeof host) => void;

    showStartupNoticesIfNeeded.call(host);
    showStartupNoticesIfNeeded.call(host);

    expect(host.firstRunOnboardingNoticeComponents).toHaveLength(4);
    expect(host.chatContainer.children).toHaveLength(4);
    expect(setOnboardedVersion).toHaveBeenCalledTimes(1);
    expect(host.ui.requestRender).toHaveBeenCalledTimes(1);
  });

  it("renders first-run notice after the changelog so it stays closest to the input", () => {
    const existingResource = testComponent("resource");
    const children: Component[] = [existingResource];
    const setOnboardedVersion = vi.fn();
    const host = {
      startupNoticesShown: false,
      changelogMarkdown: "## [0.2.0]\n\n- New workflow updates",
      firstRunNoticeVisible: true,
      firstRunOnboardingNoticeComponents: [] as Component[],
      chatContainer: {
        children,
        addChild(child: Component) {
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
    expect(host.firstRunOnboardingNoticeComponents).toHaveLength(5);
    expect(firstNoticeIndex).toBeGreaterThan(0);
    expect(host.chatContainer.children.slice(firstNoticeIndex, firstNoticeIndex + host.firstRunOnboardingNoticeComponents.length)).toEqual(host.firstRunOnboardingNoticeComponents);
    expect(setOnboardedVersion).toHaveBeenCalledWith("0.2.0");
    expect(host.ui.requestRender).toHaveBeenCalledTimes(1);
  });

  it("renders first-run notice after a collapsed changelog", () => {
    const children: Component[] = [];
    const setOnboardedVersion = vi.fn();
    const host = {
      startupNoticesShown: false,
      changelogMarkdown: "## [0.2.0]\n\n- New workflow updates",
      firstRunNoticeVisible: true,
      firstRunOnboardingNoticeComponents: [] as Component[],
      chatContainer: {
        children,
        addChild(child: Component) {
          this.children.push(child);
        },
      },
      settingsManager: {
        getCollapseChangelog: () => true,
        setOnboardedVersion,
      },
      version: "0.2.0",
      getMarkdownThemeWithSettings: () => ({}),
      ui: { requestRender: vi.fn() },
    };
    const showStartupNoticesIfNeeded = Reflect.get(InteractiveMode.prototype, "showStartupNoticesIfNeeded") as (this: typeof host) => void;

    showStartupNoticesIfNeeded.call(host);

    const firstNoticeIndex = host.chatContainer.children.indexOf(host.firstRunOnboardingNoticeComponents[0]);
    expect(host.firstRunOnboardingNoticeComponents).toHaveLength(5);
    expect(firstNoticeIndex).toBeGreaterThan(0);
    expect(host.chatContainer.children.slice(firstNoticeIndex, firstNoticeIndex + host.firstRunOnboardingNoticeComponents.length)).toEqual(host.firstRunOnboardingNoticeComponents);
    expect(setOnboardedVersion).toHaveBeenCalledWith("0.2.0");
    expect(host.ui.requestRender).toHaveBeenCalledTimes(1);
  });

  it("does not mark onboarded when only changelog markdown renders", () => {
    const setOnboardedVersion = vi.fn();
    const children: Component[] = [];
    const host = {
      startupNoticesShown: false,
      changelogMarkdown: "## [0.2.0]\n\n- New workflow updates",
      firstRunNoticeVisible: false,
      firstRunOnboardingNoticeComponents: [] as Component[],
      chatContainer: {
        children,
        addChild(child: Component) {
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

    expect(host.chatContainer.children).not.toHaveLength(0);
    expect(host.firstRunOnboardingNoticeComponents).toHaveLength(0);
    expect(setOnboardedVersion).not.toHaveBeenCalled();
    expect(host.ui.requestRender).toHaveBeenCalledTimes(1);
  });

  it("removes rendered onboarding notice components without touching the normal editor", () => {
    const first = testComponent("first");
    const cta = [testComponent("border"), testComponent("copy"), testComponent("bottom")];
    const last = testComponent("last");
    const host = {
      firstRunNoticeVisible: true,
      firstRunOnboardingNoticeComponents: cta,
      chatContainer: { children: [first, ...cta, last] },
      startupNoticesContainer: { children: [...cta] },
      ui: { requestRender: vi.fn() },
    };
    const clear = Reflect.get(InteractiveMode.prototype, "clearFirstRunOnboardingUi") as (this: typeof host) => void;

    clear.call(host);

    expect(host.firstRunNoticeVisible).toBe(false);
    expect(host.chatContainer.children).toEqual([first, last]);
    expect(host.firstRunOnboardingNoticeComponents).toEqual([]);
    expect(host.ui.requestRender).toHaveBeenCalledTimes(1);
  });

  it("clears stale first-run notice state when starting a new session", async () => {
    const staleNotice = testComponent("notice");
    const host = {
      loadingAnimation: undefined,
      statusContainer: { clear: vi.fn() },
      runtimeHost: { newSession: vi.fn(async () => ({ cancelled: false })) },
      renderCurrentSessionState: vi.fn(() => {
        host.chatContainer.children = [];
      }),
      firstRunNoticeVisible: true,
      firstRunOnboardingNoticeComponents: [staleNotice],
      chatContainer: {
        children: [staleNotice],
        addChild(child: Component) {
          this.children.push(child);
        },
      },
      startupNoticesContainer: {
        children: [staleNotice],
      },
      ui: { requestRender: vi.fn() },
      handleFatalRuntimeError: vi.fn(),
      ensureDeferredStartupComplete: vi.fn(async () => {}),
    };
    const clear = Reflect.get(InteractiveMode.prototype, "clearFirstRunOnboardingUi") as (this: typeof host) => void;
    const handleClearCommand = Reflect.get(InteractiveMode.prototype, "handleClearCommand") as (this: typeof host & { clearFirstRunOnboardingUi: () => void }) => Promise<void>;
    const hostWithClear = host as typeof host & { clearFirstRunOnboardingUi: () => void };
    hostWithClear.clearFirstRunOnboardingUi = () => clear.call(hostWithClear);

    await handleClearCommand.call(hostWithClear);
    expect(host.ensureDeferredStartupComplete).toHaveBeenCalledTimes(1);

    expect(host.ensureDeferredStartupComplete).toHaveBeenCalledTimes(1);
    expect(host.firstRunNoticeVisible).toBe(false);
    expect(host.firstRunOnboardingNoticeComponents).toEqual([]);
    expect(host.chatContainer.children).not.toContain(staleNotice);
  });

  it("treats first-run text as normal input instead of an onboarding seed", async () => {
    const onInputCallback = vi.fn();
    const host = {
      firstRunNoticeVisible: true,
      defaultEditor: {},
      editor: { setText: vi.fn(), addToHistory: vi.fn() },
      flushPendingBashComponents: vi.fn(),
      onInputCallback,
      pendingUserInputs: [],
      session: { isBashRunning: false, isCompacting: false, isStreaming: false, prompt: vi.fn() },
      renderDeferredUserInput: vi.fn(),
    };
    const submit = installSubmitHandler(host);

    await submit("Implement ticket ABC");

    expect(onInputCallback).toHaveBeenCalledWith("Implement ticket ABC");
    expect(host.session.prompt).not.toHaveBeenCalled();
    expect(host.editor.addToHistory).toHaveBeenCalledWith("Implement ticket ABC");
    expect(host.renderDeferredUserInput).toHaveBeenCalledWith("Implement ticket ABC");
  });

  it("treats /chat as an ordinary slash command with no onboarding bypass", async () => {
    const host = {
      firstRunNoticeVisible: true,
      defaultEditor: {},
      editor: { setText: vi.fn(), addToHistory: vi.fn() },
      flushPendingBashComponents: vi.fn(),
      onInputCallback: vi.fn(),
      pendingUserInputs: [],
      session: { isBashRunning: false, isCompacting: false, isStreaming: false, prompt: vi.fn() },
      renderDeferredUserInput: vi.fn(),
    };
    const submit = installSubmitHandler(host);

    await submit("/chat please explain the repo");

    expect(host.session.prompt).not.toHaveBeenCalled();
    expect(host.onInputCallback).toHaveBeenCalledWith("/chat please explain the repo");
  });
});
