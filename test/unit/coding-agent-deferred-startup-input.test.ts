import { afterEach, describe, mock, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExtensionsCached } from "../../packages/coding-agent/src/core/extensions/loader.js";
import { InteractiveMode } from "../../packages/coding-agent/src/modes/interactive/interactive-mode.js";
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
  onInputCallback?: (text: string) => void;
  pendingUserInputs: string[];
};

type DeferredModeContext = {
  chatContainer: { addChild: (child: object) => void; removeChild: (child: object) => void };
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
  maybeSaveImplicitProjectTrustAfterReload: () => void;
  setupAutocompleteProvider: () => void;
  setupExtensionShortcuts: (runner: object) => void;
  retryDeferredModelRestore: () => Promise<void>;
  showLoadedResources: (options: { force: boolean; showDiagnosticsWhenQuiet: boolean }) => void;
  showStartupNoticesIfNeeded: () => void;
  updateAvailableProviderCount: () => Promise<void>;
  updateEditorBorderColor: () => void;
  showError: (message: string) => void;
  showWarning: (message: string) => void;
  sessionManager: { buildSessionContext: () => { messages: [] } };
  settingsManager: { getDefaultProvider: () => undefined; getDefaultModel: () => undefined };
};

type InteractivePrototype = {
  setupEditorSubmitHandler(this: SubmitContext): void;
  completeDeferredStartup(this: DeferredModeContext): Promise<void>;
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
    const markerPath = join(dir, "immediate.marker");
    const logPath = join(dir, "order.log");
    const firstExtension = join(dir, "first-extension.ts");
    const secondExtension = join(dir, "second-extension.ts");

    await writeFile(
      firstExtension,
      `import { appendFileSync } from "node:fs";\nexport default function () { appendFileSync(${JSON.stringify(logPath)}, "first\\n"); }\n`,
    );
    await writeFile(
      secondExtension,
      `import { appendFileSync, existsSync } from "node:fs";\nexport default function () { appendFileSync(${JSON.stringify(logPath)}, existsSync(${JSON.stringify(markerPath)}) ? "second-after-immediate\\n" : "second-before-immediate\\n"); }\n`,
    );

    const immediateDone = new Promise<void>((resolve) => {
      setImmediate(async () => {
        await writeFile(markerPath, "fired");
        await writeFile(logPath, "immediate\n", { flag: "a" });
        resolve();
      });
    });

    const result = await loadExtensionsCached([firstExtension, secondExtension], dir);
    await immediateDone;

    assert.deepEqual(result.errors, []);
    assert.equal(await Bun.file(logPath).text(), "first\nimmediate\nsecond-after-immediate\n");
  });

  test("preserves editor text and cursor while deferred startup completes", async () => {
    let text = "";
    const cursor = { line: 0, col: 0 };
    const mode: DeferredModeContext = {
      chatContainer: { addChild: mock(() => {}), removeChild: mock(() => {}) },
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
      maybeSaveImplicitProjectTrustAfterReload: mock(() => {}),
      setupAutocompleteProvider: mock(() => {}),
      setupExtensionShortcuts: mock(() => {}),
      retryDeferredModelRestore: mock(async () => {}),
      showLoadedResources: mock(() => {}),
      showStartupNoticesIfNeeded: mock(() => {}),
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
  });

  test("queues Enter submissions made before deferred startup is ready", async () => {
    const prompt = mock(async () => {});
    const context: SubmitContext = {
      defaultEditor: {},
      editor: { addToHistory: mock(() => {}), setText: mock(() => {}) },
      session: { isCompacting: false, isStreaming: false, isBashRunning: false, prompt },
      flushPendingBashComponents: mock(() => {}),
      pendingUserInputs: [],
    };

    interactivePrototype.setupEditorSubmitHandler.call(context);
    await context.defaultEditor.onSubmit?.(" prompt while loading ");

    assert.deepEqual(context.pendingUserInputs, ["prompt while loading"]);
    assert.equal(prompt.mock.calls.length, 0);
  });
});
