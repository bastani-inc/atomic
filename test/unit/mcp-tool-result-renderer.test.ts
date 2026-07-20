import { afterEach, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getKeybindings, setKeybindings } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { keyText, type AgentToolResult, type ToolRenderResultOptions } from "../../packages/coding-agent/src/index.ts";
import {
  formatMcpToolResultLines,
  renderMcpToolResult,
  type McpToolResultDetails,
} from "../../packages/mcp/tool-result-renderer.ts";

const theme = {
  fg: (_name: string, text: string) => text,
};

function textResult(text: string): AgentToolResult<McpToolResultDetails> {
  return {
    content: [{ type: "text", text }],
    details: {},
    terminate: false,
  };
}

function renderResult(text: string, options: ToolRenderResultOptions): string {
  return renderMcpToolResult(textResult(text), options, theme).render(80).join("\n");
}

const previousKeybindings = getKeybindings();

beforeEach(() => setKeybindings(new KeybindingsManager()));
afterEach(() => setKeybindings(previousKeybindings));

describe("MCP tool result rendering", () => {
  test("README documents the exact Atomic-normal expand hint", () => {
    const readme = readFileSync(join(import.meta.dir, "../../packages/mcp/README.md"), "utf8");
    assert.match(readme, /`ctrl\+o Expand`/);
    assert.doesNotMatch(readme, /`Ctrl\+o Expand`/);
  });

  test("formats collapsed result hint with the configured expand keybinding", () => {
    const rendered = renderResult("one\ntwo\nthree\nfour", {
      expanded: false,
      isPartial: false,
    });

    assert.ok(rendered.includes(`(${keyText("app.tools.expand")} Expand)`));
    assert.doesNotMatch(rendered, /CTRL\+O/);
    assert.doesNotMatch(rendered, /Ctrl\+o/);
  });

  test("omits expand hint when result is already expanded", () => {
    const rendered = renderResult("one\ntwo\nthree\nfour", {
      expanded: true,
      isPartial: false,
    });

    assert.doesNotMatch(rendered, new RegExp(`${keyText("app.tools.expand")} Expand`));
    assert.match(rendered, /four/);
  });


  test("omits the unavailable expand affordance when the binding is empty", () => {
    setKeybindings(new KeybindingsManager({ "app.tools.expand": [] }));
    const rendered = renderResult("one\ntwo\nthree\nfour", { expanded: false, isPartial: false });

    assert.doesNotMatch(rendered, /Expand|\(\s*\)/);
    assert.match(rendered, /…/);
  });

  test("reports truncation only when collapsed content exceeds the line budget", () => {
    assert.deepEqual(
      formatMcpToolResultLines(textResult("one\ntwo\nthree\nfour"), false),
      { lines: ["one", "two", "three", "…"], truncated: true },
    );
    assert.deepEqual(
      formatMcpToolResultLines(textResult("one\ntwo\nthree\nfour"), true),
      { lines: ["one", "two", "three", "four"], truncated: false },
    );
  });
});
