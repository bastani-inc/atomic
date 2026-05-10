/**
 * Coverage for the attached-mode footer's compile path. The footer
 * is now applied via tmux/psmux status-line options, authored against
 * the `<Footer>` compound component, so the regression surface here
 * is:
 *
 *   - the JSX tree produced by `attachedStatusline` is a valid
 *     `<Footer>` element with `<Footer.Left>` / `<Footer.Right>`
 *     slots in the right places;
 *   - those slots compile to well-formed tmux format strings (no
 *     stray brackets, paddings emit literal spaces, style markup
 *     encloses the right segments);
 *   - the compiled output retains the user-visible tokens callers
 *     rely on (the agent-type pill, the `#{window_name}` reference
 *     for workflow rendering, the navigation hints).
 *
 * We don't shell out to tmux/psmux from tests — `renderFooter` itself
 * is exercised in integration scripts (chat-smoke). Here we only
 * pin the compile output so a regression in the parser, the
 * statusline JSX, or the underlying tui primitives lands as a test
 * failure rather than a silently broken footer.
 */

import { test, expect, describe } from "bun:test";
import { isValidElement, type ReactElement, type ReactNode } from "react";

import {
  attachedStatusline,
  backgroundTasksValue,
} from "../tui/attached-statusline.tsx";
import { compile } from "../tui/compiler/parser.ts";
import { Footer, FooterLeft, FooterRight } from "../tui/components.tsx";
import type { GraphTheme } from "../components/graph-theme.ts";

const THEME: GraphTheme = {
  background: "#000000",
  backgroundElement: "#111111",
  text: "#eeeeee",
  textMuted: "#aaaaaa",
  textDim: "#777777",
  primary: "#3366ff",
  success: "#22cc66",
  error: "#cc2244",
  warning: "#ffaa22",
  info: "#22aaff",
  mauve: "#cc66ff",
  border: "#333333",
  borderActive: "#666666",
};

/** Walk a <Footer> tree and return its slot children. */
function slots(
  node: ReactNode,
): { left: ReactNode; right: ReactNode; props: Record<string, unknown> } {
  if (!isValidElement(node) || node.type !== Footer) {
    throw new Error("expected a <Footer> element");
  }
  const footerEl = node as ReactElement<{ children?: ReactNode } & Record<string, unknown>>;
  const children = Array.isArray(footerEl.props.children)
    ? footerEl.props.children
    : [footerEl.props.children];
  let left: ReactNode;
  let right: ReactNode;
  for (const child of children) {
    if (!isValidElement(child)) continue;
    const slotEl = child as ReactElement<{ children?: ReactNode }>;
    if (slotEl.type === FooterLeft) left = slotEl.props.children;
    if (slotEl.type === FooterRight) right = slotEl.props.children;
  }
  const { children: _, ...rest } = footerEl.props;
  return { left, right, props: rest };
}

describe("attachedStatusline (workflow variant)", () => {
  const tree = attachedStatusline({ theme: THEME });
  const { left, right, props } = slots(tree);
  const compiledLeft = compile(left);
  const compiledRight = compile(right);

  test("Footer carries position and bg/fg from the theme", () => {
    expect(props.position).toBe("bottom");
    expect(props.bg).toBe(THEME.backgroundElement);
    expect(props.fg).toBe(THEME.text);
  });

  test("right side wraps hints in a per-window conditional", () => {
    expect(compiledRight.startsWith("#{?#{==:#{window_name},orchestrator},")).toBe(true);
    expect(compiledRight.endsWith("}")).toBe(true);
  });

  test("left pill switches GRAPH ↔ truncated window_name", () => {
    // Orchestrator window shows the literal `GRAPH`; agent windows
    // show the live stage name truncated via tmux's `#{=/N/T:…}`
    // modifier so a verbose stage name (`claude-background-…`) can't
    // overflow into the bg-tasks counter. Pinning the literal
    // conditional shape locks both branches and the truncation
    // length at once.
    expect(compiledLeft).toContain(
      `#{?#{==:#{window_name},orchestrator},GRAPH,#{=/16/...:window_name}}`,
    );
  });

  test("left bg-tasks counter only renders on the orchestrator window", () => {
    // Background stages can only be interacted with from the graph
    // view, so the counter is hidden from agent panes. The conditional
    // sits next to the pill (sibling, not nested), so the pill itself
    // is still visible from every pane.
    expect(compiledLeft).toContain(
      `#{?#{==:#{window_name},orchestrator},#{@atomic-bg-tasks},}`,
    );
  });

  test("style attributes are space-separated (no commas inside #[…])", () => {
    expect(compiledLeft).not.toMatch(/#\[[^\]]*,[^\]]*\]/);
    expect(compiledRight).not.toMatch(/#\[[^\]]*,[^\]]*\]/);
  });

  test("orchestrator branch has graph-mode key hints", () => {
    expect(compiledRight).toContain("navigate");
    expect(compiledRight).toContain("attach");
    expect(compiledRight).toContain("stages");
    expect(compiledRight).toContain("quit");
  });

  test("agent branch has agent-mode navigation hints", () => {
    expect(compiledRight).toContain("ctrl+g");
    expect(compiledRight).toContain("graph");
    expect(compiledRight).toContain("ctrl+\\");
    expect(compiledRight).toContain("next");
  });

  test("conditionals are sibling, never nested", () => {
    // Left has two top-level conditionals (pill label + bg-tasks gate);
    // right has one (mode hints). Nesting is the psmux 3.3.3 render
    // trigger, not multiplicity — two sibling conditionals are safe.
    // The literal `toContain` assertions above already pin the exact
    // shape of each conditional, so a count check is enough here to
    // catch a new conditional sneaking inside an existing branch.
    expect(compiledLeft.match(/#\{\?/g)?.length ?? 0).toBe(2);
    expect(compiledRight.match(/#\{\?/g)?.length ?? 0).toBe(1);
  });
});

describe("backgroundTasksValue", () => {
  test("zero count produces empty string so the segment collapses", () => {
    expect(backgroundTasksValue(0, THEME)).toBe("");
    expect(backgroundTasksValue(-1, THEME)).toBe("");
  });

  test("positive count emits styled count + label with no commas", () => {
    const value = backgroundTasksValue(3, THEME);
    expect(value).toContain("3 background");
    // Style attributes are space-separated — psmux 3.3.3 mishandles
    // commas inside `#[…]` once expanded inside a `#{?…}` conditional.
    expect(value).not.toMatch(/#\[[^\]]*,[^\]]*\]/);
    expect(value).toContain(`bg=${THEME.backgroundElement}`);
    expect(value).toContain(`fg=${THEME.warning}`);
  });
});

describe("attachedStatusline (chat variant)", () => {
  test("claude renders a warning-color pill", () => {
    const tree = attachedStatusline({
      theme: THEME,
      agentType: "claude",
    });
    const { left } = slots(tree);
    const compiled = compile(left);
    expect(compiled).toContain("#[bg=#ffaa22]"); // warning
    expect(compiled).toContain("CLAUDE");
    expect(compiled).not.toContain("#{window_name}"); // chat is single-window
    expect(compiled).not.toMatch(/,/); // no commas anywhere — render-safe
  });

  test("copilot uses the success color", () => {
    const tree = attachedStatusline({
      theme: THEME,
      agentType: "copilot",
    });
    const { left } = slots(tree);
    expect(compile(left)).toContain("#[bg=#22cc66]");
  });

  test("opencode uses the mauve color", () => {
    const tree = attachedStatusline({
      theme: THEME,
      agentType: "opencode",
    });
    const { left } = slots(tree);
    expect(compile(left)).toContain("#[bg=#cc66ff]");
  });

  test("Footer.Right shows the /atomic help hint and detach hint", () => {
    const tree = attachedStatusline({
      theme: THEME,
      agentType: "opencode",
    });
    const { right } = slots(tree);
    const compiled = compile(right);
    expect(compiled).toContain("/atomic <question>");
    expect(compiled).toContain("ctrl+b d");
    expect(compiled).toContain("detach");
  });

  test("Footer.Right surfaces the session id between the /atomic hint and detach hint", () => {
    const tree = attachedStatusline({
      theme: THEME,
      agentType: "opencode",
      name: "atomic-chat-opencode-foo",
    });
    const { right } = slots(tree);
    const compiled = compile(right);
    expect(compiled).toContain("atomic-chat-opencode-foo");
    const atomicIdx = compiled.indexOf("/atomic <question>");
    const nameIdx = compiled.indexOf("atomic-chat-opencode-foo");
    const detachIdx = compiled.indexOf("ctrl+b d");
    expect(atomicIdx).toBeGreaterThanOrEqual(0);
    expect(nameIdx).toBeGreaterThan(atomicIdx);
    expect(detachIdx).toBeGreaterThan(nameIdx);
  });
});
