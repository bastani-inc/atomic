/**
 * Source-path regression coverage for the isolated workflow-overlay mouse /
 * autowrap bridge.
 *
 * In isolated interactive mode the workflow extension runs inside the engine
 * child, whose stdout is the JSONL transport rather than a TTY, so writing raw
 * mouse-tracking escape sequences to `process.stdout` there is a no-op. A remote
 * custom component instead sends typed, allowlisted `engine_custom_terminal`
 * controls; the host `RemoteComponentController` applies them to the real host
 * TTY associated with the mounted overlay.
 *
 * These tests wire the real child `EngineCustomUiService` to the real host
 * `RemoteComponentController` through an in-process message pump (no spawned
 * process) and assert the full chain:
 *   engine_custom_open overlay:true → host overlay handle focused →
 *   host mouse mode enabled → wheel forwarded to the child graph → reset on
 *   done/close/dispose/crash, with stale-generation safety.
 */

import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { ExtensionUIContext } from "../../packages/coding-agent/src/core/extensions/index.ts";
import { EngineCustomUiService } from "../../packages/coding-agent/src/modes/interactive-engine/engine-custom-ui.ts";
import { RemoteComponentController } from "../../packages/coding-agent/src/modes/interactive-engine/remote-component.ts";
import type { IsolatedInteractiveRuntime } from "../../packages/coding-agent/src/modes/interactive-engine/isolated-runtime.ts";
import {
  INTERACTIVE_ENGINE_PROTOCOL_VERSION,
  parseInteractiveEngineMessage,
  serializeInteractiveEngineFrame,
  type InteractiveEngineMessage,
} from "../../packages/coding-agent/src/modes/interactive-engine/protocol.ts";
import {
  HOST_MOUSE_SCROLL_TRACKING_OFF,
  HOST_MOUSE_SCROLL_TRACKING_ON,
  HOST_TERMINAL_AUTOWRAP_OFF,
  HOST_TERMINAL_AUTOWRAP_ON,
  TerminalModeController,
} from "../../packages/coding-agent/src/modes/interactive-engine/terminal-mode-controller.ts";

const WHEEL_UP = "\x1b[<64;10;10M";

/** The child's RemoteTerminal augments pi-tui's Terminal with these setters. */
interface RemoteTerm {
  setMouseScrollTracking?: (enabled: boolean) => void;
  setAutowrap?: (enabled: boolean) => void;
}
function remoteTerm(tui: TUI): RemoteTerm {
  return tui.terminal as unknown as RemoteTerm;
}

interface HostMount {
  readonly componentId: string;
  readonly component: Component;
  readonly overlay: boolean;
  focused: boolean;
  done: (result: unknown) => void;
}

interface Bridge {
  readonly child: EngineCustomUiService;
  readonly controller: RemoteComponentController;
  readonly hostWrites: string[];
  readonly hostMessages: InteractiveEngineMessage[];
  readonly mounts: HostMount[];
  focus: "editor" | "inline" | "overlay";
  emitEngineReady(pid: number): void;
}

function makeBridge(): Bridge {
  const engineListeners: Array<(m: InteractiveEngineMessage) => void> = [];
  const hostWrites: string[] = [];
  const hostMessages: InteractiveEngineMessage[] = [];
  const mounts: HostMount[] = [];
  const bridge = { focus: "editor" } as Bridge;

  const hostTerminal = { rows: 40, columns: 100, write: (data: string) => hostWrites.push(data) };

  const child = new EngineCustomUiService((line) => {
    const message = parseInteractiveEngineMessage(line);
    if (!message) return;
    hostMessages.push(message);
    for (const listener of [...engineListeners]) listener(message);
  });

  const runtime = {
    onEngineMessage: (listener: (m: InteractiveEngineMessage) => void) => {
      engineListeners.push(listener);
      return () => {};
    },
    sendEngineCommand: (command: unknown) => {
      child.handleLine(serializeInteractiveEngineFrame(command as never));
    },
  } as unknown as IsolatedInteractiveRuntime;

  // The most recently opened engine_custom_open carries the componentId; capture
  // it so the fake host mount can be correlated for input routing.
  let pendingComponentId: string | undefined;
  engineListeners.push((message) => {
    if (message.type === "engine_custom_open") pendingComponentId = message.componentId;
  });

  const ui = {
    requestRender: () => {},
    setWidget: () => {},
    custom: (
      factory: (tui: unknown, theme: unknown, keys: unknown, done: (r: unknown) => void) => Component,
      options: { overlay?: boolean; onHandle?: (handle: unknown) => void },
    ) =>
      new Promise((resolve) => {
        const componentId = pendingComponentId!;
        const mount: HostMount = {
          componentId,
          overlay: options.overlay === true,
          focused: false,
          done: (result: unknown) => {
            // Real host: overlay done hides + restores previous focus; inline
            // done runs restoreEditor(setFocus editor). Model both as → editor.
            if (mount.overlay ? bridge.focus === "overlay" : bridge.focus === "inline") {
              bridge.focus = "editor";
            }
            resolve(result);
          },
          component: undefined as unknown as Component,
        };
        const handle = {
          hide: () => { mount.focused = false; },
          setHidden: (_hidden: boolean) => {},
          isHidden: () => false,
          focus: () => { mount.focused = true; bridge.focus = "overlay"; },
          unfocus: () => { mount.focused = false; },
          isFocused: () => mount.focused,
        };
        const tui = { terminal: hostTerminal, requestRender: () => {}, setFocus: () => {} };
        const component = factory(tui, {}, {}, mount.done);
        (mount as { component: Component }).component = component;
        mounts.push(mount);
        if (mount.overlay) {
          // pi-tui showOverlay captures focus on mount.
          mount.focused = true;
          bridge.focus = "overlay";
          options.onHandle?.(handle);
        } else {
          bridge.focus = "inline";
        }
      }),
  } as unknown as ExtensionUIContext;

  const controller = new RemoteComponentController(runtime, ui);
  bridge.emitEngineReady = (pid: number) => {
    for (const listener of [...engineListeners]) {
      listener({ type: "engine_ready", protocolVersion: INTERACTIVE_ENGINE_PROTOCOL_VERSION, pid });
    }
  };
  return Object.assign(bridge, { child, controller, hostWrites, hostMessages, mounts });
}

/** Simulate the workflow graph overlay factory: enable mouse on mount, record input. */
function graphFactory(inputs: string[]) {
  return (tui: TUI, _t: unknown, _k: unknown, _done: (r: unknown) => void) => {
    // Mirror the overlay-adapter: enable host mouse-scroll reporting on mount.
    remoteTerm(tui).setMouseScrollTracking?.(true);
    return {
      render: () => ["graph"],
      handleInput: (data: string) => { inputs.push(data); },
      invalidate: () => {},
      dispose: () => { remoteTerm(tui).setMouseScrollTracking?.(false); },
    };
  };
}

function overlayMount(bridge: Bridge): HostMount {
  const mount = bridge.mounts.find((candidate) => candidate.overlay);
  assert.ok(mount, "expected an overlay mount");
  return mount;
}

describe("engine_custom_terminal protocol", () => {
  test("round-trips allowlisted mouse and autowrap controls", () => {
    for (const control of [
      { kind: "mouse-scroll-tracking", enabled: true },
      { kind: "mouse-scroll-tracking", enabled: false },
      { kind: "autowrap", enabled: true },
      { kind: "autowrap", enabled: false },
    ] as const) {
      const line = serializeInteractiveEngineFrame({ type: "engine_custom_terminal", componentId: "c1", control });
      const parsed = parseInteractiveEngineMessage(line);
      assert.deepEqual(parsed, { type: "engine_custom_terminal", componentId: "c1", control });
    }
  });

  test("rejects unknown kinds, non-boolean enabled, and missing control", () => {
    const reject = (control: unknown) =>
      parseInteractiveEngineMessage(JSON.stringify({ type: "engine_custom_terminal", componentId: "c1", control }));
    assert.equal(reject({ kind: "resize", enabled: true }), undefined);
    assert.equal(reject({ kind: "mouse-scroll-tracking", enabled: "yes" }), undefined);
    assert.equal(reject({ kind: "mouse-scroll-tracking" }), undefined);
    assert.equal(reject("\x1b[?1000h"), undefined);
    assert.equal(reject(undefined), undefined);
    assert.equal(
      parseInteractiveEngineMessage(JSON.stringify({ type: "engine_custom_terminal", control: { kind: "autowrap", enabled: true } })),
      undefined,
    );
  });
});

describe("TerminalModeController", () => {
  test("buffers controls received before mount and flushes on mount", () => {
    const controller = new TerminalModeController();
    const writes: string[] = [];
    controller.applyControl("c1", { kind: "mouse-scroll-tracking", enabled: true });
    assert.equal(writes.length, 0);
    controller.onMount("c1", { write: (d: string) => { writes.push(d); } });
    assert.deepEqual(writes, [HOST_MOUSE_SCROLL_TRACKING_ON]);
  });

  test("resets only the modes a component turned on when it unmounts", () => {
    const controller = new TerminalModeController();
    const writes: string[] = [];
    controller.onMount("c1", { write: (d: string) => { writes.push(d); } });
    controller.applyControl("c1", { kind: "mouse-scroll-tracking", enabled: true });
    controller.applyControl("c1", { kind: "autowrap", enabled: false });
    controller.onUnmount("c1");
    assert.deepEqual(writes, [
      HOST_MOUSE_SCROLL_TRACKING_ON,
      HOST_TERMINAL_AUTOWRAP_OFF,
      HOST_MOUSE_SCROLL_TRACKING_OFF,
      HOST_TERMINAL_AUTOWRAP_ON,
    ]);
  });

  test("ignores default-restoring controls from unmounted/stale components", () => {
    const controller = new TerminalModeController();
    const writes: string[] = [];
    // No state yet; a stray "disable" must not create or apply anything.
    controller.applyControl("stale", { kind: "mouse-scroll-tracking", enabled: false });
    controller.applyControl("stale", { kind: "autowrap", enabled: true });
    controller.onMount("stale", { write: (d: string) => { writes.push(d); } });
    assert.deepEqual(writes, []);
  });

  test("resetAll restores every active mode and clears state", () => {
    const controller = new TerminalModeController();
    const writes: string[] = [];
    controller.onMount("c1", { write: (d: string) => { writes.push(d); } });
    controller.applyControl("c1", { kind: "mouse-scroll-tracking", enabled: true });
    writes.length = 0;
    controller.resetAll();
    assert.deepEqual(writes, [HOST_MOUSE_SCROLL_TRACKING_OFF]);
    // After reset the component is forgotten; a repeat reset is a no-op.
    controller.resetAll();
    assert.deepEqual(writes, [HOST_MOUSE_SCROLL_TRACKING_OFF]);
  });
});

describe("isolated overlay mouse bridge (source-path)", () => {
  test("resume-style selection: picker disposes, then overlay mounts focused with mouse enabled and wheel forwarded", async () => {
    const bridge = makeBridge();
    const graphInputs: string[] = [];

    // 1. Inline resume picker (overlay:false) mounts and takes inline focus.
    let pickerDone!: (result: unknown) => void;
    void bridge.child.custom<string>((_tui, _t, _k, done) => {
      pickerDone = done as (result: unknown) => void;
      return { render: () => ["picker"], handleInput: () => {}, invalidate: () => {} };
    }, { overlay: false });
    await Bun.sleep(0);
    assert.equal(bridge.focus, "inline");

    // 2. Selecting a row disposes the picker (host restores editor focus) BEFORE
    //    the graph overlay opens. The picker never touched the terminal modes.
    pickerDone("resume");
    await Bun.sleep(0);
    assert.equal(bridge.focus, "editor");
    assert.deepEqual(bridge.hostWrites, [], "inline picker must not toggle host terminal modes");

    // 3. The durable resume then mounts the graph overlay (overlay:true).
    void bridge.child.custom(graphFactory(graphInputs), { overlay: true });
    await Bun.sleep(0);

    const overlayOpen = bridge.hostMessages.find(
      (m) => m.type === "engine_custom_open" && m.overlay === true,
    );
    assert.ok(overlayOpen, "expected engine_custom_open overlay:true");
    // Deterministic ordering: picker teardown precedes the overlay open.
    const doneIndex = bridge.hostMessages.findIndex((m) => m.type === "engine_custom_done");
    const openIndex = bridge.hostMessages.indexOf(overlayOpen);
    assert.ok(doneIndex !== -1 && doneIndex < openIndex, "picker done must precede overlay open");

    // Host focused the fullscreen overlay and enabled mouse reporting on the TTY.
    assert.equal(bridge.focus, "overlay");
    assert.equal(overlayMount(bridge).focused, true);
    assert.deepEqual(bridge.hostWrites, [HOST_MOUSE_SCROLL_TRACKING_ON]);

    // 4. A mouse wheel gesture reaches the child graph's handleInput.
    overlayMount(bridge).component.handleInput?.(WHEEL_UP);
    await Bun.sleep(0);
    assert.deepEqual(graphInputs, [WHEEL_UP]);

    bridge.controller.dispose();
  });

  test("hiding the overlay via done resets host mouse reporting", async () => {
    const bridge = makeBridge();
    let done!: (result: unknown) => void;
    void bridge.child.custom((_tui, _t, _k, complete) => {
      done = complete as (result: unknown) => void;
      remoteTerm(_tui).setMouseScrollTracking?.(true);
      return { render: () => ["graph"], handleInput: () => {}, invalidate: () => {} };
    }, { overlay: true });
    await Bun.sleep(0);
    assert.deepEqual(bridge.hostWrites, [HOST_MOUSE_SCROLL_TRACKING_ON]);

    done(undefined);
    await Bun.sleep(0);
    assert.deepEqual(bridge.hostWrites, [HOST_MOUSE_SCROLL_TRACKING_ON, HOST_MOUSE_SCROLL_TRACKING_OFF]);

    bridge.controller.dispose();
  });

  test("engine restart (engine_ready) resets stranded host terminal modes", async () => {
    const bridge = makeBridge();
    void bridge.child.custom((_tui, _t, _k, _done) => {
      remoteTerm(_tui).setMouseScrollTracking?.(true);
      return { render: () => ["graph"], handleInput: () => {}, invalidate: () => {} };
    }, { overlay: true });
    await Bun.sleep(0);
    assert.deepEqual(bridge.hostWrites, [HOST_MOUSE_SCROLL_TRACKING_ON]);

    // The engine child crashes and a fresh generation binds: modes must reset.
    bridge.emitEngineReady(4242);
    assert.deepEqual(bridge.hostWrites, [HOST_MOUSE_SCROLL_TRACKING_ON, HOST_MOUSE_SCROLL_TRACKING_OFF]);

    bridge.controller.dispose();
  });

  test("Windows autowrap toggles reach the host terminal and reset on unmount", async () => {
    const bridge = makeBridge();
    let done!: (result: unknown) => void;
    void bridge.child.custom((_tui, _t, _k, complete) => {
      done = complete as (result: unknown) => void;
      remoteTerm(_tui).setAutowrap?.(false);
      return { render: () => ["graph"], handleInput: () => {}, invalidate: () => {} };
    }, { overlay: true });
    await Bun.sleep(0);
    assert.deepEqual(bridge.hostWrites, [HOST_TERMINAL_AUTOWRAP_OFF]);

    done(undefined);
    await Bun.sleep(0);
    assert.deepEqual(bridge.hostWrites, [HOST_TERMINAL_AUTOWRAP_OFF, HOST_TERMINAL_AUTOWRAP_ON]);

    bridge.controller.dispose();
  });
});
