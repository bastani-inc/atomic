import type { RunSnapshot } from "../shared/store-types.js";
import { hexBg, hexToAnsi, RESET } from "./color-utils.js";
import { GraphViewGraphRenderer } from "./graph-view-graph-render.js";
import { renderOutlinePill, renderHeader } from "./header.js";
import { renderPromptCard } from "./prompt-card.js";
import { renderSwitcher } from "./switcher.js";
import { truncateToWidth } from "./text-helpers.js";
import { renderToasts } from "./toast.js";

/** Overlay/widget rendering orchestration for GraphView. */
export abstract class GraphViewRenderer extends GraphViewGraphRenderer {
  /** Render to string lines. width = terminal columns. */
  render(width: number): string[] {
    if (this.mode === "widget") {
      return this._renderWidget(width);
    }
    return this._renderOverlay(width);
  }

  protected _renderWidget(width: number): string[] {
    const run = this._getCurrentRun();
    if (!run) {
      return [`${hexToAnsi(this.graphTheme.dim)}no active workflow${RESET}`];
    }
    const displayStages = this._displayStages(run);
    const headerLines = renderHeader({ ...run, stages: displayStages }, { width, theme: this.graphTheme });
    const counts = this._counts(displayStages);
    const trailer =
      `${hexToAnsi(this.graphTheme.dim)}` +
      `${counts.completed}/${displayStages.length} done` +
      (counts.running > 0 ? ` · ${counts.running} running` : "") +
      (counts.failed > 0 ? ` · ${counts.failed} failed` : "") +
      (counts.blocked > 0 ? ` · ${counts.blocked} blocked` : "") +
      RESET;
    return [...headerLines, ` ${trailer}`];
  }

  protected _renderOverlay(width: number): string[] {
    const frameWidth = Math.max(40, width);
    const lines: string[] = [];
    const run = this._getCurrentRun();

    if (!run) {
      return this._renderEmptyState(frameWidth);
    }

    // 1. Header chrome (3 rows: outline pill + session name + counts).
    lines.push(
      ...renderHeader({ ...run, stages: this._displayStages(run) }, { width: frameWidth, theme: this.graphTheme }),
    );

    // 2. Graph occupies the full body. No section labels, no focused-
    //    stage panel — status colour on each card carries that signal.
    const graphLines = this._renderGraph(frameWidth);
    const bodyTarget = this._overlayBodyRows(this._overlayPanelLineCount());
    const visibleGraph = this._visibleGraphLines(
      graphLines,
      frameWidth,
      bodyTarget,
    );
    for (let i = 0; i < visibleGraph.topPad; i++)
      lines.push(this._blankRow(frameWidth));
    for (const line of visibleGraph.lines) {
      lines.push(this._canvasRow(line, frameWidth));
    }
    while (lines.length < 3 + bodyTarget)
      lines.push(this._blankRow(frameWidth));
    if (lines.length > 3 + bodyTarget) lines.length = 3 + bodyTarget;

    this._renderSwitcherOverlay(lines, run, frameWidth, bodyTarget);
    this._renderPromptOverlay(lines, frameWidth, bodyTarget);
    this._renderToastOverlay(lines, frameWidth);

    // 5. Three-row statusline pinned to the bottom.
    lines.push(...this._renderStatusline(frameWidth));

    return this._withVerticalMargins(lines, frameWidth);
  }

  protected _renderEmptyState(width: number): string[] {
    const t = this.graphTheme;
    const muted = hexToAnsi(t.textMuted);
    const dim = hexToAnsi(t.dim);
    const accent = hexToAnsi(t.accent);
    const chromeBg = hexBg(t.backgroundPanel);

    const {
      top,
      mid,
      bot,
      visibleWidth: pillW,
    } = renderOutlinePill("ORCHESTRATOR", t.accent, chromeBg);
    const idleLabel = `  ${muted}idle${RESET}`;
    const fillerVisible = Math.max(0, width - 1 - pillW - 6 /* "  idle" */ - 2);
    const filler = " ".repeat(fillerVisible);
    const lines: string[] = [
      `${chromeBg} ${RESET}${top}${chromeBg}${" ".repeat(6 + fillerVisible)}${" ".repeat(2)}${RESET}`,
      `${chromeBg} ${RESET}${mid}${chromeBg}${idleLabel}${filler}${" ".repeat(2)}${RESET}`,
      `${chromeBg} ${RESET}${bot}${chromeBg}${" ".repeat(6 + fillerVisible)}${" ".repeat(2)}${RESET}`,
    ];
    const bodyTarget = this._overlayBodyRows(this._overlayPanelLineCount());
    const body: string[] = [
      this._canvasRow(`  ${muted}No active workflow run.${RESET}`, width),
      this._canvasRow(
        `  ${dim}Start one with ${accent}/workflow <name>${RESET}${dim} or press ${accent}F2${RESET}${dim} on an active run.${RESET}`,
        width,
      ),
    ];
    const topPad = Math.max(0, Math.floor((bodyTarget - body.length) / 2));
    for (let i = 0; i < topPad; i++) lines.push(this._blankRow(width));
    for (const l of body) lines.push(l);
    while (lines.length < 3 + bodyTarget) lines.push(this._blankRow(width));
    lines.push(...this._renderStatusline(width));
    return this._withVerticalMargins(lines, width);
  }

  private _renderSwitcherOverlay(
    lines: string[],
    run: RunSnapshot,
    frameWidth: number,
    bodyTarget: number,
  ): void {
    // Switcher overlay — floats over the body when open.
    if (!this.switcherOpen) return;

    const bodyStart = 3;
    const bodyEnd = 3 + bodyTarget;
    for (let row = bodyStart; row < bodyEnd; row++) {
      lines[row] = this._blankRow(frameWidth);
    }
    const switcherWidth = Math.min(60, Math.max(40, frameWidth - 8));
    const switcherLines = renderSwitcher(this._displayStages(run), this.switcherState, {
      width: switcherWidth,
      theme: this.graphTheme,
    });
    const insertAt = Math.max(bodyStart, bodyStart + Math.min(2, Math.floor((bodyTarget - switcherLines.length) / 3)));
    const switcherLeft = Math.max(2, Math.floor((frameWidth - switcherWidth) / 2));
    for (let i = 0; i < switcherLines.length; i++) {
      const lineIdx = insertAt + i;
      if (lineIdx >= bodyEnd) break;
      const base = lines[lineIdx] ?? this._blankRow(frameWidth);
      const merged = this._overlayCard(base, switcherLines[i]!, switcherLeft, frameWidth);
      if (lineIdx < lines.length) lines[lineIdx] = merged;
      else lines.push(merged);
    }
  }

  private _renderPromptOverlay(
    lines: string[],
    frameWidth: number,
    bodyTarget: number,
  ): void {
    // Pending HIL prompt — floats over the graph body, centred. The
    // chat editor remains free regardless: the overlay is the only
    // surface that interacts with the prompt. When the stage switcher is
    // open it owns the body/input, so hide the prompt card until it closes.
    if (!this.promptState || this.switcherOpen) return;

    const cardWidth = Math.min(72, Math.max(40, frameWidth - 6));
    const cardLines = renderPromptCard({
      state: this.promptState,
      theme: this.graphTheme,
      width: cardWidth,
      cursorOn: ((Date.now() / 530) | 0) % 2 === 0,
    });
    const bodyStart = 3;
    const bodyEnd = 3 + bodyTarget;
    const slot = Math.max(
      bodyStart,
      bodyStart + Math.floor((bodyTarget - cardLines.length) / 2),
    );
    const leftPad = Math.max(0, Math.floor((frameWidth - cardWidth) / 2));
    for (let i = 0; i < cardLines.length; i++) {
      const lineIdx = slot + i;
      if (lineIdx >= bodyEnd) break;
      const base = lines[lineIdx] ?? this._blankRow(frameWidth);
      lines[lineIdx] = this._overlayCard(base, cardLines[i]!, leftPad, frameWidth);
    }
  }

  private _renderToastOverlay(lines: string[], frameWidth: number): void {
    // Toast overlay — top-right of header band.
    const toastLines = renderToasts(this.toastManager.active(), {
      theme: this.graphTheme,
    });
    if (toastLines.length === 0) return;

    for (let i = 0; i < toastLines.length && i < lines.length; i++) {
      const existing = lines[i] ?? "";
      const merged = `${existing} ${toastLines[i]}`;
      lines[i] = truncateToWidth(merged, frameWidth, "", true);
    }
  }
}
