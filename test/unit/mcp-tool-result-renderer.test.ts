import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { AgentToolResult, ToolRenderResultOptions } from "../../packages/coding-agent/src/index.ts";
import {
  formatMcpToolResultLines,
  renderMcpToolResult,
} from "../../packages/mcp/tool-result-renderer.ts";

type McpDetails = Record<string, never>;

const theme = {
  fg: (_name: string, text: string) => text,
};

function textResult(text: string): AgentToolResult<McpDetails> {
  return {
    content: [{ type: "text", text }],
    details: {},
    terminate: false,
  };
}

function renderResult(text: string, options: ToolRenderResultOptions): string {
  return renderMcpToolResult(textResult(text), options, theme).render(80).join("\n");
}

describe("MCP tool result rendering", () => {
  test("formats collapsed result hint with CLI-wide Ctrl+o branding", () => {
    const rendered = renderResult("one\ntwo\nthree\nfour", {
      expanded: false,
      isPartial: false,
    });

    assert.match(rendered, /\(Ctrl\+o Expand\)/);
    assert.doesNotMatch(rendered, /CTRL\+O/);
  });

  test("omits expand hint when result is already expanded", () => {
    const rendered = renderResult("one\ntwo\nthree\nfour", {
      expanded: true,
      isPartial: false,
    });

    assert.doesNotMatch(rendered, /Ctrl\+o Expand/);
    assert.match(rendered, /four/);
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
