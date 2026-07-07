import { afterEach, describe, mock, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExtensionsCached } from "../../packages/coding-agent/src/core/extensions/loader.js";
import { InteractiveMode } from "../../packages/coding-agent/src/modes/interactive/interactive-mode.js";
import { type Component, type MarkdownTheme, Container, Text, getMarkdownTheme } from "../../packages/coding-agent/src/modes/interactive/interactive-mode-deps.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";

type SubmitContext = {
  defaultEditor: { onSubmit?: (text: string) => void | Promise<void> };
  editor: {
    addToHistory?: (text: string) => void;
    setText: (text: string) => void;
  };
  session: {
    isCompacting: boolean;
    isStreaming: boolean;
    isBashRunning: boolean;
    prompt: (text: string, options?: object) => Promise<void>;
  };
  flushPendingBashComponents: () => void;
  renderDeferredUserInput: (text: string) => void;
  onInputCallback?: (text: string) => void;
  pendingUserInputs: string[];
};

type DeferredModeContext = {
  chatContainer: { addChild: (child: object) => void; removeChild: (child: object) => void };
  startupNoticesContainer: Container;
  ui: { requestRender: () => void };
  session: {
    reload: (options: { reason: "startup" }) => Promise<void>;
    resourceLoader: { getThemes: () => { themes: [] } };
    extensionRunner: object;
    modelRegistry: { getError: () => string | undefined };
  };
  editor: { getText: () => string; setText: (text: string) => void; getCursor: () => { line: number; col: number } };
  options: { deferredModelScopePatterns?: string[] };
  themeController: { applyFromSettings: () => Promise<void> };
  deferredStartupPending: boolean;
  bindCurrentSessionExtensions: () => Promise<void>;
  maybeSaveImplicitProjectTrustAfterReload: () => void;
  setupAutocompleteProvider: () => void;
  setupExtensionShortcuts: (runner: object) => void;
  retryDeferredModelRestore: (targetContainer?: Container) => Promise<void>;
  stopWorkingLoader: () => void;
  showLoadedResources: (options: { force: boolean; showDiagnosticsWhenQuiet: boolean; targetContainer?: Container }) => void;
  showStartupNoticesIfNeeded: (targetContainer?: Container) => void;
  maybeWarnAboutAnthropicSubscriptionAuth: (model?: object, targetContainer?: Container) => Promise<void>;
  updateAvailableProviderCount: () => Promise<void>;
  updateEditorBorderColor: () => void;
  showError: (message: string) => void;
  showWarning: (message: string) => void;
  sessionManager: { buildSessionContext: () => { messages: [] } };
  settingsManager: { getDefaultProvider: () => undefined; getDefaultModel: () => undefined };
};
type UserMessageStartEvent = {
  type: "message_start";
  message: { role: "user"; content: string };
};

type HandleEventContext = {
  isInitialized: true;
  footer: { invalidate: () => void };
  chatContainer: Container;
  getUserMessageText: (message: { role: "user"; content: string }) => string;
  consumeDeferredRenderedUserInput: (text: string) => boolean;
  addMessageToChat: (message: { role: "user"; content: string }) => void;
  updatePendingMessagesDisplay: () => void;
  ui: { requestRender: () => void };
};

type StartupContainerContext = {
  chatContainer: Container;
  startupNoticesContainer: Container;
  firstRunNoticeVisible: boolean;
  firstRunOnboardingNoticeComponents: Component[];
  ui: { requestRender: () => void };
};


type InteractivePrototype = {
  setupEditorSubmitHandler(this: SubmitContext): void;
  completeDeferredStartup(this: DeferredModeContext): Promise<void>;
  handleEvent(this: HandleEventContext, event: UserMessageStartEvent): Promise<void>;
  renderDeferredUserInput(this: RenderDeferredContext, text: string): void;
  discardDeferredRenderedUserInput(this: RenderDeferredContext, text: string): void;
  showNewVersionNotification(this: StartupNoticeContext, newVersion: string, targetContainer?: Container): void;
  showStartupNoticesIfNeeded(this: StartupNoticeContext, targetContainer?: Container): void;
  attachStartupNoticesContainer(this: StartupContainerContext, options?: { resetDetached?: boolean }): void;
  clearFirstRunOnboardingUi(this: StartupContainerContext): void;
};

type RenderDeferredContext = {
  chatContainer: Container;
  deferredRenderedUserInputs: string[];
  deferredRenderedUserInputComponents: Map<string, Component[][]>;
  addMessageToChat: (message: { role: "user"; content: string }) => void;
  updatePendingMessagesDisplay: () => void;
  ui: { requestRender: () => void };
};

type StartupNoticeContext = {
  chatContainer: Container;
  settingsManager: { getCollapseChangelog: () => boolean; setOnboardedVersion: (version: string) => void };
  getMarkdownThemeWithSettings: () => MarkdownTheme;
  getStartupExpansionState: () => boolean;
  startupNoticesShown: boolean;
  changelogMarkdown?: string;
  firstRunNoticeVisible: boolean;
  firstRunOnboardingNoticeComponents: Component[];
  version: string;
  ui: { requestRender: () => void };
};

const interactivePrototype = InteractiveMode.prototype as unknown as InteractivePrototype;
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "atomic-deferred-startup-"));
  tempDirs.push(dir);
  return dir;
}

initTheme("dark");

describe("coding-agent deferred startup input", () => {
  test("yields to the event loop between extension module loads", async () => {
    const dir = await makeTempDir();
    const logPath = join(dir, "order.log");
    const firstExtension = join(dir, "first-extension.ts");
    const secondExtension = join(dir, "second-extension.ts");

    await writeFile(
      firstExtension,
      `import { appendFileSync, writeFileSync } from "node:fs";\nimport { dirname, join } from "node:path";\nimport { fileURLToPath } from "node:url";\nconst dir = dirname(fileURLToPath(import.meta.url));\nconst markerPath = join(dir, "immediate.marker");\nconst logPath = join(dir, "order.log");\nexport default function () { appendFileSync(logPath, "first\\n"); setImmediate(() => { writeFileSync(markerPath, "fired"); appendFileSync(logPath, "immediate\\n"); }); }\n`,
    );
    await writeFile(
      secondExtension,
      `import { appendFileSync, existsSync } from "node:fs";\nimport { dirname, join } from "node:path";\nimport { fileURLToPath } from "node:url";\nconst dir = dirname(fileURLToPath(import.meta.url));\nconst markerPath = join(dir, "immediate.marker");\nconst logPath = join(dir, "order.log");\nexport default function () { appendFileSync(logPath, existsSync(markerPath) ? "second-after-immediate\\n" : "second-before-immediate\\n"); }\n`,
    );

    const waitForImmediate = new Promise<void>((resolve) => setImmediate(resolve));

    const result = await loadExtensionsCached([firstExtension, secondExtension], dir);
    await waitForImmediate;

    assert.deepEqual(result.errors, []);
    assert.equal(await Bun.file(logPath).text(), "first\nimmediate\nsecond-after-immediate\n");
  });

  test("preserves editor text and cursor while deferred startup completes", async () => {
    let text = "";
    const cursor = { line: 0, col: 0 };
    const maybeSaveImplicitProjectTrustAfterReload = mock(() => {});
    const mode: DeferredModeContext = {
      chatContainer: { addChild: mock(() => {}), removeChild: mock(() => {}) },
      startupNoticesContainer: new Container(),
      ui: { requestRender: mock(() => {}) },
      session: {
        reload: mock(async () => {
          text = "typed during loading";
          cursor.col = text.length;
        }),
        resourceLoader: { getThemes: () => ({ themes: [] }) },
        extensionRunner: {},
        modelRegistry: { getError: () => undefined },
      },
      editor: { getText: () => text, setText: (nextText) => { text = nextText; }, getCursor: () => cursor },
      options: {},
      themeController: { applyFromSettings: mock(async () => {}) },
      deferredStartupPending: true,
      bindCurrentSessionExtensions: mock(async () => {}),
      maybeSaveImplicitProjectTrustAfterReload,
      setupAutocompleteProvider: mock(() => {}),
      setupExtensionShortcuts: mock(() => {}),
      retryDeferredModelRestore: mock(async () => {}),
      stopWorkingLoader: mock(() => {}),
      showLoadedResources: mock(() => {}),
      showStartupNoticesIfNeeded: mock(() => {}),
      maybeWarnAboutAnthropicSubscriptionAuth: mock(async () => {}),
      updateAvailableProviderCount: mock(async () => {}),
      updateEditorBorderColor: mock(() => {}),
      showError: mock(() => {}),
      showWarning: mock(() => {}),
      sessionManager: { buildSessionContext: () => ({ messages: [] }) },
      settingsManager: { getDefaultProvider: () => undefined, getDefaultModel: () => undefined },
    };

    await interactivePrototype.completeDeferredStartup.call(mode);

    assert.equal(mode.deferredStartupPending, false);
    assert.equal(mode.editor.getText(), "typed during loading");
    assert.deepEqual(mode.editor.getCursor(), { line: 0, col: "typed during loading".length });
    assert.equal(maybeSaveImplicitProjectTrustAfterReload.mock.calls.length, 0);
  });

  test("queues Enter submissions made before deferred startup is ready", async () => {
    const prompt = mock(async () => {});
    const renderDeferredUserInput = mock(() => {});
    const context: SubmitContext = {
      defaultEditor: {},
      editor: { addToHistory: mock(() => {}), setText: mock(() => {}) },
      session: { isCompacting: false, isStreaming: false, isBashRunning: false, prompt },
      flushPendingBashComponents: mock(() => {}),
      renderDeferredUserInput,
      pendingUserInputs: [],
    };

    interactivePrototype.setupEditorSubmitHandler.call(context);
    await context.defaultEditor.onSubmit?.(" prompt while loading ");

    assert.deepEqual(context.pendingUserInputs, ["prompt while loading"]);
    assert.equal(renderDeferredUserInput.mock.calls.length, 0);
    assert.equal(prompt.mock.calls.length, 0);
  });

  test("queued deferred-startup inputs render in request order from message events", async () => {
    const renderDeferredUserInput = mock(() => {});
    const submitContext: SubmitContext = {
      defaultEditor: {},
      editor: { addToHistory: mock(() => {}), setText: mock(() => {}) },
      session: { isCompacting: false, isStreaming: false, isBashRunning: false, prompt: mock(async () => {}) },
      flushPendingBashComponents: mock(() => {}),
      renderDeferredUserInput,
      pendingUserInputs: [],
    };
    const chatContainer = new Container();
    chatContainer.addChild(new Text("user1", 0, 0));
    chatContainer.addChild(new Text("resp1", 0, 0));
    const eventContext: HandleEventContext = {
      isInitialized: true,
      footer: { invalidate: mock(() => {}) },
      chatContainer,
      getUserMessageText: (message) => message.content,
      consumeDeferredRenderedUserInput: () => false,
      addMessageToChat: (message) => chatContainer.addChild(new Text(message.content, 0, 0)),
      updatePendingMessagesDisplay: mock(() => {}),
      ui: { requestRender: mock(() => {}) },
    };

    interactivePrototype.setupEditorSubmitHandler.call(submitContext);
    await submitContext.defaultEditor.onSubmit?.("msg2");
    const queuedInput = submitContext.pendingUserInputs.shift();
    assert.equal(queuedInput, "msg2");
    if (queuedInput === undefined) throw new Error("Expected queued input");
    await interactivePrototype.handleEvent.call(eventContext, {
      type: "message_start",
      message: { role: "user", content: queuedInput },
    });
    chatContainer.addChild(new Text("resp2", 0, 0));

    assert.equal(renderDeferredUserInput.mock.calls.length, 0);
    assert.deepEqual(
      chatContainer.children.map((child) => child.render(80).join("\n").trimEnd()),
      ["user1", "resp1", "msg2", "resp2"],
    );
  });

  test("startup notices stay anchored above user messages", () => {
    const startupContainer = new Container();
    const userMessage = new Text("user message", 0, 0);
    const chatContainer = new Container();
    chatContainer.addChild(startupContainer);
    chatContainer.addChild(userMessage);
    const mode: StartupNoticeContext = {
      chatContainer,
      settingsManager: { getCollapseChangelog: () => true, setOnboardedVersion: mock(() => {}) },
      getMarkdownThemeWithSettings: () => getMarkdownTheme(),
      getStartupExpansionState: () => false,
      startupNoticesShown: false,
      changelogMarkdown: "## [1.2.3]\n\n- Fixed ordering",
      firstRunNoticeVisible: false,
      firstRunOnboardingNoticeComponents: [],
      version: "1.2.3",
      ui: { requestRender: mock(() => {}) },
    };

    interactivePrototype.showStartupNoticesIfNeeded.call(mode, startupContainer);
    interactivePrototype.showNewVersionNotification.call(mode, "1.2.4", startupContainer);

    assert.equal(chatContainer.children[0], startupContainer);
    assert.equal(chatContainer.children[1], userMessage);
    assert.ok(startupContainer.children.length > 0);
  });

  test("startup notices container reattaches cleanly after chat clears", () => {
    const chatContainer = new Container();
    const startupNoticesContainer = new Container();
    const staleNotice = new Text("old notice", 0, 0);
    startupNoticesContainer.addChild(staleNotice);
    const mode: StartupContainerContext = {
      chatContainer,
      startupNoticesContainer,
      firstRunNoticeVisible: false,
      firstRunOnboardingNoticeComponents: [],
      ui: { requestRender: mock(() => {}) },
    };

    interactivePrototype.attachStartupNoticesContainer.call(mode, { resetDetached: true });

    assert.equal(chatContainer.children[0], startupNoticesContainer);
    assert.equal(startupNoticesContainer.children.length, 0);
  });

  test("clears first-run onboarding components from startup notices container", () => {
    const chatContainer = new Container();
    const startupNoticesContainer = new Container();
    const onboarding = new Text("onboarding", 0, 0);
    startupNoticesContainer.addChild(onboarding);
    const mode: StartupContainerContext = {
      chatContainer,
      startupNoticesContainer,
      firstRunNoticeVisible: true,
      firstRunOnboardingNoticeComponents: [onboarding],
      ui: { requestRender: mock(() => {}) },
    };

    interactivePrototype.clearFirstRunOnboardingUi.call(mode);

    assert.equal(mode.firstRunNoticeVisible, false);
    assert.equal(startupNoticesContainer.children.length, 0);
    assert.deepEqual(mode.firstRunOnboardingNoticeComponents, []);
  });

  test("discarding deferred user input removes the echoed chat components", () => {
    const chatContainer = new Container();
    const mode: RenderDeferredContext = {
      chatContainer,
      deferredRenderedUserInputs: [],
      deferredRenderedUserInputComponents: new Map(),
      addMessageToChat: (message) => {
        chatContainer.addChild(new Text(`user:${message.content}`, 0, 0));
      },
      updatePendingMessagesDisplay: mock(() => {}),
      ui: { requestRender: mock(() => {}) },
    };

    interactivePrototype.renderDeferredUserInput.call(mode, "prompt that fails");
    assert.equal(chatContainer.children.length, 1);

    interactivePrototype.discardDeferredRenderedUserInput.call(mode, "prompt that fails");

    assert.equal(chatContainer.children.length, 0);
    assert.deepEqual(mode.deferredRenderedUserInputs, []);
  });
});
