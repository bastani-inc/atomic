import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Theme } from "@bastani/atomic";
import type { SessionInfo, Message } from "../types.js";
import { terminalSafeLabel, terminalSafeText } from "./terminal-text.js";

export class InlineMessageComponent implements Component {
  private from: SessionInfo;
  private message: Message;
  private theme: Theme;
  private replyCommand?: string;
  private bodyText?: string;
  private heading?: string;

  constructor(from: SessionInfo, message: Message, theme: Theme, replyCommand?: string, bodyText?: string, heading?: string) {
    this.from = from;
    this.message = message;
    this.theme = theme;
    this.replyCommand = replyCommand;
    this.bodyText = bodyText;
    this.heading = heading;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const lines: string[] = [];
    const borderChar = "─";
    // Every field below comes from a peer session; none may reach the terminal as control sequences (#4889).
    const senderName = terminalSafeLabel(this.from.name || this.from.id);
    if (width < 3) {
      return [truncateToWidth(`From ${senderName}`, width)];
    }
    const bodyWidth = Math.max(1, width - 2);

    const header = this.heading === undefined
      ? ` 📨 From: ${senderName} (${terminalSafeLabel(this.from.cwd)}) `
      : ` 📨 ${terminalSafeLabel(this.heading)} `;
    // An empty ellipsis silently clips full sender IDs; keep header overflow visible.
    const headerText = truncateToWidth(header, bodyWidth, "…");
    const headerPadding = Math.max(0, bodyWidth - visibleWidth(headerText));
    lines.push(this.theme.fg("accent", `╭${headerText}${borderChar.repeat(headerPadding)}╮`));

    const contentLines = wrapTextWithAnsi(terminalSafeText(this.bodyText || this.message.content.text), bodyWidth);
    for (const line of contentLines) {
      const text = truncateToWidth(line, bodyWidth, "");
      const padding = Math.max(0, bodyWidth - visibleWidth(text));
      lines.push(this.theme.fg("accent", `│${text}${" ".repeat(padding)}│`));
    }

    if (this.replyCommand) {
      lines.push(this.theme.fg("accent", `│${" ".repeat(bodyWidth)}│`));
      const replyLines = wrapTextWithAnsi(this.theme.fg("dim", ` ↩ To reply: ${this.replyCommand}`), bodyWidth);
      for (const line of replyLines) {
        const text = truncateToWidth(line, bodyWidth, "");
        const padding = Math.max(0, bodyWidth - visibleWidth(text));
        lines.push(this.theme.fg("accent", `│${text}${" ".repeat(padding)}│`));
      }
    }

    if (this.message.content.attachments?.length) {
      lines.push(this.theme.fg("accent", `│${" ".repeat(bodyWidth)}│`));
      for (const att of this.message.content.attachments) {
        const label = this.theme.fg("dim", ` 📎 ${terminalSafeLabel(att.name)}`);
        const text = truncateToWidth(label, bodyWidth, "");
        const padding = Math.max(0, bodyWidth - visibleWidth(text));
        lines.push(this.theme.fg("accent", `│${text}${" ".repeat(padding)}│`));
      }
    }

    if (this.message.replyTo && !this.message.expectsReply) {
      lines.push(this.theme.fg("accent", `│${" ".repeat(bodyWidth)}│`));
      // An empty ellipsis silently clips full reply-to IDs; keep overflow visible.
      const reply = this.theme.fg("dim", ` ↳ Reply to ${terminalSafeLabel(this.message.replyTo)}`);
      const text = truncateToWidth(reply, bodyWidth, "…");
      const padding = Math.max(0, bodyWidth - visibleWidth(text));
      lines.push(this.theme.fg("accent", `│${text}${" ".repeat(padding)}│`));
    }

    lines.push(this.theme.fg("accent", `╰${borderChar.repeat(bodyWidth)}╯`));

    return lines;
  }
}
