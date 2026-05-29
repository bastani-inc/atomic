import { describe, expect, test } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

/**
 * Regression for #1109: swapping the footer (built-in <-> extension custom
 * footer) must keep `widgetContainerBelow` as the LAST UI child so a live
 * below-editor widget's per-tick line stays within the bottom viewport. The
 * old removeChild + addChild swap appended the footer after the widget
 * container, which both un-pinned the footer from under the editor and let the
 * live widget tick above the fold again (re-triggering the flicker).
 *
 * We exercise the real `setExtensionFooter` via a minimal `this` context (the
 * same prototype-call pattern used by the other interactive-mode unit tests),
 * so no full TUI/session bootstrap is required.
 */

type Comp = { render: (width: number) => string[]; dispose?: () => void };

interface FakeUi {
  children: Comp[];
  addChild(c: Comp): void;
  removeChild(c: Comp): void;
  requestRender(): void;
}

interface FooterCtx {
  customFooter: Comp | undefined;
  footer: Comp;
  footerDataProvider: Record<string, never>;
  widgetContainerBelow: Comp;
  ui: FakeUi;
}

type FooterFactory =
  | ((tui: unknown, thm: unknown, footerData: unknown) => Comp)
  | undefined;

interface ProtoWithFooter {
  setExtensionFooter(this: FooterCtx, factory: FooterFactory): void;
}

function makeComp(): Comp {
  return { render: () => [] };
}

function makeUi(children: Comp[]): FakeUi {
  return {
    children,
    addChild(c) {
      this.children.push(c);
    },
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i !== -1) this.children.splice(i, 1);
    },
    requestRender() {},
  };
}

function callSetFooter(ctx: FooterCtx, factory: FooterFactory): void {
  (InteractiveMode.prototype as unknown as ProtoWithFooter).setExtensionFooter.call(ctx, factory);
}

function makeCtx(): FooterCtx {
  const editorPlaceholder = makeComp();
  const footer = makeComp();
  const widgetContainerBelow = makeComp();
  // Mirror the init order tail: editor, footer, then below-editor widgets last.
  const ui = makeUi([editorPlaceholder, footer, widgetContainerBelow]);
  return { customFooter: undefined, footer, footerDataProvider: {}, widgetContainerBelow, ui };
}

describe("InteractiveMode.setExtensionFooter ordering (#1109)", () => {
  test("installing a custom footer keeps the below-editor widget container as the last UI child", () => {
    const ctx = makeCtx();
    const customFooter = makeComp();

    callSetFooter(ctx, () => customFooter);

    const { children } = ctx.ui;
    expect(children[children.length - 1]).toBe(ctx.widgetContainerBelow);
    // The custom footer is pinned directly above the below-editor widgets.
    expect(children[children.length - 2]).toBe(customFooter);
    expect(ctx.customFooter).toBe(customFooter);
    // The built-in footer is swapped out in place (not duplicated).
    expect(children).not.toContain(ctx.footer);
  });

  test("restoring the built-in footer keeps the below-editor widget container last", () => {
    const ctx = makeCtx();
    callSetFooter(ctx, () => makeComp()); // install custom footer
    callSetFooter(ctx, undefined); // restore built-in footer

    const { children } = ctx.ui;
    expect(children[children.length - 1]).toBe(ctx.widgetContainerBelow);
    expect(children[children.length - 2]).toBe(ctx.footer);
    expect(ctx.customFooter).toBeUndefined();
  });

  test("re-attaches the below-editor container last when the footer slot is missing", () => {
    const ctx = makeCtx();
    // Edge case: footer not currently attached (e.g. swapped before init added it).
    ctx.ui.children = [ctx.widgetContainerBelow];
    const customFooter = makeComp();

    callSetFooter(ctx, () => customFooter);

    const { children } = ctx.ui;
    expect(children[children.length - 1]).toBe(ctx.widgetContainerBelow);
    expect(children).toContain(customFooter);
  });
});
