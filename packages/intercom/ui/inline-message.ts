import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Theme } from "@bastani/atomic";
import type { SessionInfo, Message } from "../types.js";

export class InlineMessageComponent implements Component {
  private from: SessionInfo;
  private message: Message;
  private theme: Theme;
  private replyCommand?: string;
  private bodyText?: string;

  constructor(from: SessionInfo, message: Message, theme: Theme, replyCommand?: string, bodyText?: string) {
    this.from = from;
    this.message = message;
    this.theme = theme;
    this.replyCommand = replyCommand;
    this.bodyText = bodyText;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const lines: string[] = [];
    const borderChar = "─";
    if (width < 3) {
      return [truncateToWidth(`From ${this.from.name || this.from.id.slice(0, 8)}`, width)];
    }
    const bodyWidth = Math.max(1, width - 2);

    const senderName = this.from.name || this.from.id.slice(0, 8);
    const header = ` 📨 From: ${senderName} (${this.from.cwd}) `;
    const headerText = truncateToWidth(header, bodyWidth, "");
    const headerPadding = Math.max(0, bodyWidth - visibleWidth(headerText));
    lines.push(this.theme.fg("accent", `╭${headerText}${borderChar.repeat(headerPadding)}╮`));

    const contentLines = wrapTextWithAnsi(this.bodyText || this.message.content.text, bodyWidth);
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
        const label = this.theme.fg("dim", ` 📎 ${att.name}`);
        const text = truncateToWidth(label, bodyWidth, "");
        const padding = Math.max(0, bodyWidth - visibleWidth(text));
        lines.push(this.theme.fg("accent", `│${text}${" ".repeat(padding)}│`));
      }
    }

    if (this.message.replyTo && !this.message.expectsReply) {
      lines.push(this.theme.fg("accent", `│${" ".repeat(bodyWidth)}│`));
      const reply = this.theme.fg("dim", ` ↳ Reply to ${this.message.replyTo.slice(0, 8)}`);
      const text = truncateToWidth(reply, bodyWidth, "");
      const padding = Math.max(0, bodyWidth - visibleWidth(text));
      lines.push(this.theme.fg("accent", `│${text}${" ".repeat(padding)}│`));
    }

    lines.push(this.theme.fg("accent", `╰${borderChar.repeat(bodyWidth)}╯`));

    return lines;
  }
}
