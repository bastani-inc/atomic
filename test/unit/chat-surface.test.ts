/**
 * Unit tests for the chat-surface primitives — flat band, tagged card,
 * progress strip, hint rows.
 *
 * cross-ref: src/tui/chat-surface.ts · ui/mockups.html
 */

import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  renderFlatBand,
  renderTaggedCard,
  renderHintRows,
  progressStrip,
  chatWidth,
  ELLIPSIS,
} from "../../packages/workflows/src/tui/chat-surface.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import {
  CHAT_SURFACE_CUSTOM_TYPE,
  emitChatSurface,
  registerChatSurfaceRenderer,
  renderChatSurfacePlainText,
  type ChatSurfacePayload,
} from "../../packages/workflows/src/tui/chat-surface-message.js";
import type { RunDetail } from "../../packages/workflows/src/runs/background/status.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string) => s.replace(ANSI_RE, "");

function printableRun(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    id: "run-printable-1234567890",
    name: "printable-workflow",
    inputs: { prompt: "ship it" },
    status: "completed",
    stages: [
      {
        id: "stage-printable",
        name: "plan",
        status: "completed",
        parentIds: [],
        startedAt: 1_000,
        endedAt: 2_000,
        durationMs: 1_000,
        result: "planned",
        toolEvents: [],
      },
    ],
    startedAt: 1_000,
    endedAt: 2_000,
    durationMs: 1_000,
    result: { ok: true },
    ...overrides,
  };
}

function printableDetail(overrides: Partial<RunDetail> = {}): RunDetail {
  const run = printableRun();
  return {
    runId: run.id,
    name: run.name,
    status: run.status,
    mode: "single",
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    durationMs: run.durationMs,
    inputs: run.inputs,
    stages: run.stages,
    result: run.result,
    ...overrides,
  };
}

describe("renderFlatBand", () => {
  test("themed: includes label, subtitle, badges on one line", () => {
    const theme = deriveGraphTheme({});
    const out = renderFlatBand({
      label: "BACKGROUND",
      subtitle: "2 runs",
      badges: [
        { text: "✓ 1", fg: theme.success },
        { text: "● 1", fg: theme.warning },
      ],
      width: 80,
      theme,
    });
    // Single line (no newline).
    assert.equal(out.includes("\n"), false);
    const plain = stripAnsi(out);
    assert.match(plain, /\[ BACKGROUND \]/);
    assert.match(plain, /2 runs/);
    assert.match(plain, /✓ 1/);
    assert.match(plain, /● 1/);
    // ANSI escapes present in themed mode.
    assert.match(out, /\x1b\[/);
  });

  test("plain: no ANSI, indented marker-free band, same content", () => {
    const out = renderFlatBand({
      label: "WORKFLOWS",
      subtitle: "3 registered",
      width: 80,
    });
    assert.doesNotMatch(out, /\x1b\[/);
    // Indentation keeps the band aligned with card content and hint `▸`.
    assert.match(out, /^   \[ WORKFLOWS \]/);
    assert.match(out, /3 registered/);
    assert.equal(out.includes("\n"), false);
  });

  test("truncates long subtitle with …", () => {
    const theme = deriveGraphTheme({});
    const out = renderFlatBand({
      label: "DISPATCHED",
      subtitle: "enterprise-deep-research-codebase-with-multi-stage-fan-out-and-aggregation",
      badges: [{ text: "● running", fg: theme.warning }],
      width: 80,
      theme,
    });
    const plain = stripAnsi(out);
    assert.match(plain, new RegExp(ELLIPSIS));
    // Total visible width must not exceed the budget by more than a tail cell.
    assert.ok(plain.length <= 90, `plain band width = ${plain.length}`);
  });

  test("empty subtitle and no badges still renders cleanly", () => {
    const out = renderFlatBand({ label: "DISPATCHED", width: 80 });
    assert.match(stripAnsi(out), /\[ DISPATCHED \]/);
  });
});

describe("renderTaggedCard", () => {
  test("themed: emits a stripe glyph, surface0 tag, title, trailing badge", () => {
    const theme = deriveGraphTheme({});
    const out = renderTaggedCard({
      tag: "abc123",
      title: "ship-feature",
      trailing: { text: "● running", fg: theme.warning },
      bodyRows: ["chain     [✓][●][○]                3/3 · review · 1m"],
      accent: theme.warning,
      width: 80,
      theme,
    });
    const lines = out.split("\n");
    assert.equal(lines.length, 2, "row 1 + body row 1");
    const plain = lines.map(stripAnsi);
    assert.doesNotMatch(plain[0]!, /\u258e/);
    assert.match(plain[0]!, /abc123/);
    assert.match(plain[0]!, /ship-feature/);
    assert.match(plain[0]!, /running/);
    assert.match(plain[1]!, /\[✓\]\[●\]\[○\]/);
  });

  test("plain: stripe degrades to │, tag in [brackets], no ANSI", () => {
    const out = renderTaggedCard({
      tag: "abc123",
      title: "ship-feature",
      trailing: { text: "● running" },
      accent: "#000000",
      width: 80,
    });
    const plain = stripAnsi(out);
    assert.equal(plain, out, "plain mode must not emit ANSI");
    // Row 1 uses a single space after the stripe so the `[tag]` brackets
    // land at col 3 — bringing the tag's first content character into
    // column-alignment with body rows that use `│  body` (stripe + 2
    // spaces). See renderTaggedCardThemed for the +1 hanging indent.
    // 1-cell leading space + stripe + 1 space + `[tag]` — same column 1
    // alignment shared by the band's `[ LABEL ]` and the hint's `▸`.
    assert.match(plain, /^ │ \[abc123\]/);
    assert.match(plain, /ship-feature/);
  });

  test("end-truncates long title with …", () => {
    const theme = deriveGraphTheme({});
    const out = renderTaggedCard({
      tag: "7c4a91",
      title: "enterprise-deep-research-codebase-with-multi-stage-fan-out-and-aggregation",
      trailing: { text: "● running", fg: theme.warning },
      accent: theme.warning,
      width: 60,
      theme,
    });
    const plain = stripAnsi(out.split("\n")[0]!);
    assert.match(plain, new RegExp(ELLIPSIS));
  });
});

describe("progressStrip", () => {
  test("themed: emits one [glyph] per stage, status-coloured", () => {
    const theme = deriveGraphTheme({});
    const out = progressStrip(
      [
        { status: "completed" },
        { status: "running" },
        { status: "pending" },
      ],
      40,
      theme,
    );
    const plain = stripAnsi(out);
    assert.equal(plain, "[✓][●][○]");
    // Themed cells include ANSI.
    assert.match(out, /\x1b\[/);
  });

  test("plain: same ASCII shape without ANSI", () => {
    const out = progressStrip(
      [
        { status: "completed" },
        { status: "failed" },
      ],
      40,
    );
    assert.equal(out, "[✓][✗]");
  });

  test("truncates to budget with trailing …", () => {
    const cells = Array.from({ length: 12 }, () => ({ status: "pending" as const }));
    const out = progressStrip(cells, 10); // budget < 12*3
    const plain = stripAnsi(out);
    assert.ok(plain.endsWith(ELLIPSIS), `expected ellipsis suffix, got ${plain}`);
    // 10 columns budget = 3 cells (3*3=9) + ellipsis (1) = 10
    assert.ok(plain.length <= 10, `truncated strip exceeded budget: ${plain.length}`);
  });

  test("empty stage list yields empty string", () => {
    assert.equal(progressStrip([], 40), "");
  });

  test("zero budget yields empty string", () => {
    assert.equal(progressStrip([{ status: "completed" }], 0), "");
  });
});

describe("renderHintRows", () => {
  test("themed: ▸ glyph, accent command, dim hint", () => {
    const theme = deriveGraphTheme({});
    const out = renderHintRows(
      [
        { command: "/workflow connect 0391c9c1", hint: "attach & watch" },
        { command: "/workflow status", hint: "list retained runs" },
      ],
      theme,
    );
    const lines = out.split("\n");
    assert.equal(lines.length, 2);
    for (const line of lines) {
      const plain = stripAnsi(line);
      assert.match(plain, /^ +▸ \/workflow /);
    }
    assert.match(out, /\x1b\[/);
  });

  test("plain: same shape without ANSI", () => {
    const out = renderHintRows([
      { command: "/workflow status", hint: "drill into a run" },
    ]);
    // Single-cell leading space so the `▸` arrow column-aligns with the
    // band's `[ LABEL ]` and the card content — see renderHintRows.
    assert.equal(out, " ▸ /workflow status  drill into a run");
    assert.doesNotMatch(out, /\x1b\[/);
  });

  test("empty rows yields empty string", () => {
    assert.equal(renderHintRows([]), "");
  });
});

describe("renderChatSurfacePlainText", () => {
  test("renders printable content for every chat-surface payload kind", () => {
    const run = printableRun();
    const payloads: Array<{ payload: ChatSurfacePayload; patterns: RegExp[] }> = [
      {
        payload: {
          kind: "list",
          entries: [
            {
              name: "alpha-workflow",
              description: "Alpha workflow description",
              inputs: [{ name: "prompt", required: true }],
            },
          ],
        },
        patterns: [/WORKFLOWS/, /alpha-workflow/, /Alpha workflow description/, /prompt/],
      },
      {
        payload: { kind: "status", runs: [run] },
        patterns: [/BACKGROUND/, /printable-workflow/, /completed/, /run-printable-1234567890/],
      },
      {
        payload: { kind: "detail", detail: printableDetail() },
        patterns: [/RUN/, /printable-workflow/, /completed/, /prompt="ship it"/, /"ok":true/],
      },
      {
        payload: {
          kind: "dispatch",
          workflowName: "dispatch-workflow",
          runId: "dispatch-run-1234567890",
          inputs: { prompt: "go", count: 2 },
        },
        patterns: [/DISPATCHED/, /dispatch-workflow/, /dispatch-run-1234567890/, /prompt="go"/, /count=2/],
      },
      {
        payload: { kind: "killed", run, previousStatus: "running" },
        patterns: [/Workflow killed/, /printable-workflow/, /run-printable-1234567890/, /running → killed/],
      },
    ];

    for (const { payload, patterns } of payloads) {
      const rendered = renderChatSurfacePlainText(payload, { width: 100, now: 3_000 });
      assert.doesNotMatch(rendered, /\x1b\[/, `${payload.kind} fallback should be plain by default`);
      for (const pattern of patterns) {
        assert.match(rendered, pattern, `${payload.kind} fallback should match ${pattern}`);
      }
    }
  });

  test("emitChatSurface defaults content to printable text while preserving custom message metadata", () => {
    const sent: Array<{
      customType: string;
      content: string;
      display: boolean;
      details: ChatSurfacePayload;
    }> = [];
    const payload: ChatSurfacePayload = {
      kind: "list",
      entries: [
        {
          name: "printable-list-workflow",
          description: "Shown in print mode",
          inputs: [{ name: "objective", required: true }],
        },
      ],
    };

    const pi = {
      sendMessage: (message: (typeof sent)[number]) => { sent.push(message); },
    } as never;

    emitChatSurface(pi, payload);
    emitChatSurface(pi, payload, { content: "custom fallback" });

    assert.equal(sent[0]?.customType, CHAT_SURFACE_CUSTOM_TYPE);
    assert.equal(sent[0]?.display, true);
    assert.equal(sent[0]?.details, payload);
    assert.match(sent[0]?.content ?? "", /WORKFLOWS/);
    assert.match(sent[0]?.content ?? "", /printable-list-workflow/);
    assert.doesNotMatch(sent[0]?.content ?? "", /^workflows · \d+ registered$/);
    assert.equal(sent[1]?.content, "custom fallback");
    assert.equal(sent[1]?.customType, CHAT_SURFACE_CUSTOM_TYPE);
    assert.equal(sent[1]?.display, true);
    assert.equal(sent[1]?.details, payload);
  });
});

describe("registerChatSurfaceRenderer", () => {
  test("registers once per live ExtensionAPI host", () => {
    class ClassBackedPi {
      readonly renderers = new Map<string, (payload: unknown) => unknown>();
      calls = 0;

      registerMessageRenderer(event: string, renderer: (payload: unknown) => unknown): void {
        this.calls += 1;
        this.renderers.set(event, renderer);
      }
    }

    const pi = new ClassBackedPi();
    registerChatSurfaceRenderer(pi as never, deriveGraphTheme({}));
    const first = pi.renderers.get(CHAT_SURFACE_CUSTOM_TYPE);
    registerChatSurfaceRenderer(pi as never, deriveGraphTheme({}));
    const second = pi.renderers.get(CHAT_SURFACE_CUSTOM_TYPE);
    assert.equal(first, second);
    assert.equal(pi.calls, 1);

    const replacementPi = new ClassBackedPi();
    registerChatSurfaceRenderer(replacementPi as never, deriveGraphTheme({}));
    assert.equal(replacementPi.calls, 1);
    assert.notEqual(replacementPi.renderers.get(CHAT_SURFACE_CUSTOM_TYPE), undefined);
  });

  test("renders killed workflow notices inline in chat", () => {
    class ClassBackedPi {
      readonly renderers = new Map<string, (payload: unknown) => unknown>();
      registerMessageRenderer(event: string, renderer: (payload: unknown) => unknown): void {
        this.renderers.set(event, renderer);
      }
    }
    const pi = new ClassBackedPi();
    registerChatSurfaceRenderer(pi as never, deriveGraphTheme({}));
    const renderer = pi.renderers.get(CHAT_SURFACE_CUSTOM_TYPE);
    assert.notEqual(renderer, undefined);
    const component = renderer!({
      details: {
        kind: "killed",
        run: {
          id: "abc12345-0000-0000-0000-000000000000",
          name: "demo-kill",
          inputs: {},
          status: "running",
          stages: [{ id: "s1", name: "plan", status: "running", parentIds: [], toolEvents: [] }],
          startedAt: 1000,
        },
        previousStatus: "running",
      },
    }) as { render(width: number): string[] };
    const rendered = stripAnsi(component.render(72).join("\n"));
    assert.match(rendered, /Workflow killed/);
    assert.match(rendered, /demo-kill/);
    assert.doesNotMatch(rendered, /removed from live history/);
    assert.match(rendered, /retained/i);
    assert.match(rendered, /read-only inspection/i);
    assert.doesNotMatch(rendered, /close/);
  });

  test("status/detail cards freeze elapsed at creation so scrollback doesn't tick on re-render", () => {
    // Regression for the whole-screen flicker class fixed for the tool-result
    // status cards (capture wall-clock once per chat entry). The chat-surface
    // renderer's render() lambda runs on every TUI frame; if it recomputed
    // Date.now() each frame, an above-fold entry would force pi-tui's
    // full-redraw branch (CSI 2J/H/3J) ~12x/sec while a live widget ticks.
    class ClassBackedPi {
      readonly renderers = new Map<string, (payload: unknown) => unknown>();
      registerMessageRenderer(event: string, renderer: (payload: unknown) => unknown): void {
        this.renderers.set(event, renderer);
      }
    }
    const pi = new ClassBackedPi();
    registerChatSurfaceRenderer(pi as never, deriveGraphTheme({}));
    const renderer = pi.renderers.get(CHAT_SURFACE_CUSTOM_TYPE);
    assert.notEqual(renderer, undefined);

    const runningSnapshot = {
      id: "abc12345-0000-0000-0000-000000000000",
      name: "tick-demo",
      inputs: {},
      status: "running",
      stages: [{ id: "s1", name: "plan", status: "running", parentIds: [], toolEvents: [] }],
      startedAt: 1_000,
    };

    for (const payload of [
      { kind: "status", runs: [runningSnapshot] },
      { kind: "detail", detail: { runId: runningSnapshot.id, name: runningSnapshot.name, mode: "single", status: "running", startedAt: 1_000, inputs: {}, stages: [] } },
    ]) {
      const originalNow = Date.now;
      try {
        // Component created at a fixed wall-clock — the clock is captured here.
        Date.now = () => 60_000;
        const component = renderer!({ details: payload }) as { render(width: number): string[] };

        // Subsequent host re-renders (e.g. driven by the live-widget ticker)
        // advance the wall-clock; the card must stay byte-identical.
        Date.now = () => 600_000;
        const first = stripAnsi(component.render(72).join("\n"));
        Date.now = () => 1_200_000;
        const second = stripAnsi(component.render(72).join("\n"));
        assert.equal(
          first,
          second,
          `${payload.kind} card must not tick elapsed across re-renders (frozen clock avoids above-fold flicker)`,
        );

        // Sanity: a card created at a later wall-clock renders a larger
        // elapsed, proving the output genuinely depends on the frozen clock.
        Date.now = () => 9_000_000;
        const later = renderer!({ details: payload }) as { render(width: number): string[] };
        const laterRendered = stripAnsi(later.render(72).join("\n"));
        assert.notEqual(
          first,
          laterRendered,
          `sanity: a ${payload.kind} card created at a different wall-clock must render a different elapsed`,
        );
      } finally {
        Date.now = originalNow;
      }
    }
  });
});

describe("chatWidth", () => {
  test("honours explicit width verbatim", () => {
    assert.equal(chatWidth(80), 80);
    assert.equal(chatWidth(132), 132);
  });

  test("subtracts pi-tui Text paddingX from process.stdout.columns fallback", () => {
    // pi's `customMessage` surface wraps our string in a `Text` component
    // with `paddingX = 1`, so the renderable width is `columns - 2`. The
    // fallback path must pre-shrink the width to avoid pi-tui wrapping the
    // trailing badge onto a second visual row (see ui/Screenshot 2026-05-12).
    const original = process.stdout.columns;
    Object.defineProperty(process.stdout, "columns", {
      value: 132,
      writable: true,
      configurable: true,
    });
    try {
      assert.equal(chatWidth(), 130);
      assert.equal(chatWidth(undefined), 130);
    } finally {
      Object.defineProperty(process.stdout, "columns", {
        value: original,
        writable: true,
        configurable: true,
      });
    }
  });

  test("floors at MIN_WIDTH so tiny terminals stay legible", () => {
    const original = process.stdout.columns;
    Object.defineProperty(process.stdout, "columns", {
      value: 24,
      writable: true,
      configurable: true,
    });
    try {
      // 24 - 2 = 22, but MIN_WIDTH = 32, so we floor at 32.
      assert.equal(chatWidth(), 32);
    } finally {
      Object.defineProperty(process.stdout, "columns", {
        value: original,
        writable: true,
        configurable: true,
      });
    }
  });
});
