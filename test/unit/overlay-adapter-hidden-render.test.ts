/**
 * Hidden-overlay render gating (#1856).
 *
 * While the workflow graph/stage overlay is hidden (Ctrl+X back to main
 * chat), background store updates must NOT ask the host TUI to render:
 * every such request became terminal writes that flickered the main-chat
 * tail and could snap native terminal scrollback back to the live bottom.
 * The retained view is still invalidated so the hidden→visible flip
 * repaints from the current snapshot.
 *
 * Runs in a subprocess because it uses `mock.module` for pi-tui seams,
 * mirroring overlay-adapter-autowrap.test.ts.
 */
import { describe, mock, test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type {
  GraphOverlayPort,
  OverlayPiSurface,
} from "../../packages/workflows/src/tui/overlay-adapter.js";
import type { Store } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import type {
  PiCustomOverlayFactoryTui,
  PiOverlayHandle,
} from "../../packages/workflows/src/extension/wiring.js";

const ISOLATED_PROCESS_ENV = "ATOMIC_OVERLAY_HIDDEN_RENDER_ISOLATED";

async function registerIsolatedTests(): Promise<void> {
  class TestComponent {
    constructor(..._args: never[]) {}
  }

  mock.module("@earendil-works/pi-tui", () => ({
    Box: TestComponent,
    Editor: TestComponent,
    SelectList: TestComponent,
    Text: TestComponent,
    Key: {
      backspace: "\x7f",
      down: "\x1b[B",
      enter: "\r",
      escape: "\x1b",
      left: "\x1b[D",
      right: "\x1b[C",
      up: "\x1b[A",
      ctrl: (key: string) => key,
    },
    decodeKittyPrintable: () => undefined,
    matchesKey: (data: string, key: string) => data === key,
    truncateToWidth: (text: string, width: number) => text.slice(0, width),
    visibleWidth: (text: string) => text.length,
    wrapTextWithAnsi: (text: string) => [text],
  }));

  mock.module("@bastani/atomic", () => ({
    ChatSessionHost: TestComponent,
    keyHint: (key: string) => key,
    keyText: (key: string) => key,
    rawKeyHint: (key: string) => key,
  }));

  const [{ buildGraphOverlayAdapter }, { createStore }] = await Promise.all([
    import("../../packages/workflows/src/tui/overlay-adapter.js"),
    import("../../packages/workflows/src/shared/store.js"),
  ]);

  interface Harness {
    adapter: GraphOverlayPort;
    store: Store;
    handle: PiOverlayHandle;
    renderRequests: { count: number };
  }

  function makeRun(id: string): RunSnapshot {
    return {
      id,
      name: `wf-${id}`,
      inputs: {},
      status: "running",
      stages: [],
      startedAt: Date.now(),
    };
  }

  function buildHarness(): Harness {
    const renderRequests = { count: 0 };
    let hidden = false;
    let focused = true;
    const handle: PiOverlayHandle = {
      hide: () => {
        hidden = true;
      },
      setHidden: (value) => {
        hidden = value;
      },
      isHidden: () => hidden,
      focus: () => {
        focused = true;
      },
      unfocus: () => {
        focused = false;
      },
      isFocused: () => focused,
    };
    const pi: OverlayPiSurface = {
      ui: {
        custom: (factory, options) => {
          options.onHandle?.(handle);
          const tui: PiCustomOverlayFactoryTui = {
            requestRender: () => {
              renderRequests.count++;
            },
            terminal: { rows: 24, columns: 80 },
          };
          const component = factory(tui, {}, {}, () => undefined);
          if (component instanceof Promise) {
            throw new Error("overlay adapter factory should mount synchronously");
          }
          return undefined;
        },
      },
    };
    const store = createStore();
    const adapter = buildGraphOverlayAdapter(pi, store, {
      terminalOutput: {
        platform: "darwin",
        isTTY: true,
        write: () => undefined,
      },
    });
    return { adapter, store, handle, renderRequests };
  }

  describe("workflow overlay hidden render gating (#1856)", () => {
    test("visible overlay requests a host render on store updates", () => {
      const { adapter, store, renderRequests } = buildHarness();
      adapter.open(null);

      const before = renderRequests.count;
      store.recordRunStart(makeRun("r1"));

      assert.ok(
        renderRequests.count > before,
        "a visible overlay must repaint on store updates",
      );
    });

    test("hidden overlay store updates never call host requestRender", () => {
      const { adapter, store, handle, renderRequests } = buildHarness();
      adapter.open(null);
      adapter.toggle(null); // hide without unmounting
      assert.equal(handle.isHidden(), true);

      const before = renderRequests.count;
      for (let i = 0; i < 20; i++) {
        store.recordRunStart(makeRun(`r${i}`));
        store.recordRunEnd(`r${i}`, "completed");
      }

      assert.equal(
        renderRequests.count,
        before,
        "hidden-overlay store updates must not broadcast host renders",
      );
    });

    test("reopening a hidden overlay repaints once from the current snapshot", () => {
      const { adapter, store, handle, renderRequests } = buildHarness();
      adapter.open(null);
      adapter.toggle(null); // hide
      store.recordRunStart(makeRun("r1"));

      const before = renderRequests.count;
      adapter.toggle(null); // show again

      assert.equal(handle.isHidden(), false);
      assert.ok(
        renderRequests.count > before,
        "the hidden→visible flip must explicitly repaint the invalidated view",
      );
    });

    test("open() on a hidden mounted overlay also repaints explicitly", () => {
      const { adapter, store, handle, renderRequests } = buildHarness();
      adapter.open(null);
      adapter.toggle(null); // hide
      store.recordRunStart(makeRun("r1"));

      const before = renderRequests.count;
      adapter.open(null);

      assert.equal(handle.isHidden(), false);
      assert.ok(
        renderRequests.count > before,
        "open() reopening a hidden overlay must explicitly repaint",
      );
    });
  });
}

if (process.env[ISOLATED_PROCESS_ENV] === "1") {
  await registerIsolatedTests();
} else {
  test("runs hidden-overlay render gating checks without leaking module mocks", () => {
    const testPath = fileURLToPath(import.meta.url);
    const result = spawnSync(process.execPath, ["test", testPath], {
      cwd: process.cwd(),
      env: { ...process.env, [ISOLATED_PROCESS_ENV]: "1" },
      encoding: "utf8",
      timeout: 10_000,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
  });
}
