/**
 * Targeted invalidation for the isolated extension-UI bridge (#1856).
 *
 * `EngineCustomUiService.requestRender()` used to broadcast
 * `engine_custom_invalidate` to every active remote component — including a
 * hidden workflow overlay. Each hidden-component invalidate became host
 * logical-render work (and potential terminal writes) for frames the user
 * cannot see. The broadcast must skip components whose remote OverlayHandle
 * is hidden, and include them again once they are shown.
 */

import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { OverlayHandle } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { EngineCustomUiService } from "../../packages/coding-agent/src/modes/interactive-engine/engine-custom-ui.ts";
import { parseInteractiveEngineMessage } from "../../packages/coding-agent/src/modes/interactive-engine/protocol.ts";

interface Harness {
  service: EngineCustomUiService;
  invalidatedComponentIds(): string[];
  clearMessages(): void;
}

function makeHarness(): Harness {
  const lines: string[] = [];
  const service = new EngineCustomUiService((line) => lines.push(line), new KeybindingsManager());
  return {
    service,
    invalidatedComponentIds: () =>
      lines
        .map((line) => parseInteractiveEngineMessage(line))
        .filter((message) => message?.type === "engine_custom_invalidate")
        .map((message) => (message as { componentId: string }).componentId),
    clearMessages: () => {
      lines.length = 0;
    },
  };
}
function stubComponent(): { render(width: number): string[]; invalidate(): void } {
  return { render: () => ["stub"], invalidate: () => {} };
}

async function openOverlay(service: EngineCustomUiService): Promise<OverlayHandle> {
  let handle: OverlayHandle | undefined;
  void service.custom(
    (_tui, _theme, _keys, _done) => stubComponent(),
    { overlay: true, onHandle: (h) => { handle = h; } },
  );
  // custom() awaits the (synchronous) factory before registering the
  // component and emitting onHandle; drain microtasks until it lands.
  for (let i = 0; i < 10 && handle === undefined; i++) await Promise.resolve();
  assert.ok(handle, "expected overlay handle from onHandle");
  return handle;
}

async function openInline(service: EngineCustomUiService): Promise<void> {
  void service.custom((_tui, _theme, _keys, _done) => stubComponent(), {});
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("EngineCustomUiService targeted invalidation (#1856)", () => {
  test("requestRender broadcast skips hidden overlay components", async () => {
    const { service, invalidatedComponentIds, clearMessages } = makeHarness();
    const overlayHandle = await openOverlay(service);
    await openInline(service);

    clearMessages();
    service.requestRender();
    assert.equal(invalidatedComponentIds().length, 2, "both visible components invalidate");

    overlayHandle.setHidden(true);
    clearMessages();
    service.requestRender();
    const afterHide = invalidatedComponentIds();
    assert.equal(afterHide.length, 1, "hidden overlay must be skipped by the broadcast");

    service.dispose();
  });

  test("a shown-again overlay rejoins the requestRender broadcast", async () => {
    const { service, invalidatedComponentIds, clearMessages } = makeHarness();
    const overlayHandle = await openOverlay(service);

    overlayHandle.setHidden(true);
    clearMessages();
    service.requestRender();
    assert.equal(invalidatedComponentIds().length, 0);

    overlayHandle.setHidden(false);
    assert.equal(overlayHandle.isHidden(), false);
    clearMessages();
    service.requestRender();
    assert.equal(invalidatedComponentIds().length, 1, "shown overlay must be invalidated again");

    service.dispose();
  });

  test("hide() marks the component hidden like setHidden(true)", async () => {
    const { service, invalidatedComponentIds, clearMessages } = makeHarness();
    const overlayHandle = await openOverlay(service);

    overlayHandle.hide();
    assert.equal(overlayHandle.isHidden(), true);
    clearMessages();
    service.requestRender();
    assert.equal(invalidatedComponentIds().length, 0, "hide() must also exclude the component");

    service.dispose();
  });
});
