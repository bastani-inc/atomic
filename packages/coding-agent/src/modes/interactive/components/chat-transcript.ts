import {
  matchesKey,
  type Component,
  Container,
  Spacer,
} from "@earendil-works/pi-tui";

/**
 * Roles that participate in pi's chat spacing contract.
 *
 * Assistant turns own their leading whitespace internally, and tool rows attach
 * directly under the assistant/tool-call row they belong to. User-like rows get
 * one blank line when they are not the first row in the transcript.
 */
export type ChatTranscriptRole =
  | "assistant"
  | "thinking"
  | "tool"
  | "user"
  | "custom"
  | "notice"
  | "system"
  | "summary";

export interface ChatTranscriptEntryLike {
  readonly role: ChatTranscriptRole;
}

export type ChatTranscriptRenderer<TEntry extends ChatTranscriptEntryLike> = (
  entry: TEntry,
) => Component;

export function addChatTranscriptEntry(
  container: Container,
  component: Component,
  role: ChatTranscriptRole,
): void {
  if (needsLeadingSpacer(role) && container.children.length > 0) {
    container.addChild(new Spacer(1));
  }
  container.addChild(component);
}

function needsLeadingSpacer(role: ChatTranscriptRole): boolean {
  return (
    role === "user" ||
    role === "custom" ||
    role === "notice" ||
    role === "system" ||
    role === "summary"
  );
}

/**
 * Reusable pi chat transcript scaffold for extension surfaces.
 *
 * This intentionally mirrors InteractiveMode.addMessageToChat spacing without
 * coupling consumers to a full AgentSession. Extension UIs can bring their own
 * message model while still rendering inside the same Container/Spacer rhythm
 * as the main chat.
 */
export class ChatTranscriptComponent<TEntry extends ChatTranscriptEntryLike>
  implements Component
{
  constructor(
    private readonly entries: readonly TEntry[],
    private readonly renderEntry: ChatTranscriptRenderer<TEntry>,
  ) {}

  render(width: number): string[] {
    const container = new Container();
    for (const entry of this.entries) {
      addChatTranscriptEntry(container, this.renderEntry(entry), entry.role);
    }
    return container.render(width);
  }

  invalidate(): void {}
}

const DEFAULT_SCROLL_STEP_ROWS = 4;

/**
 * Sticky-bottom, scrollable viewport for chat-like component stacks.
 *
 * Pi's main interactive chat gets terminal scrollback for free. Extension
 * overlays render into a fixed rectangle, so they need an explicit viewport
 * with the same sticky-bottom default plus keyboard and mouse history controls.
 */
export class ScrollableComponentViewport implements Component {
  private components: readonly Component[] = [];
  private visibleRows = 1;
  private scrollFromBottom = 0;
  private lastLineCount = 0;
  private lastWidth = 0;
  private maxScroll = 0;

  setComponents(components: readonly Component[]): void {
    this.components = components;
  }

  setVisibleRows(rows: number): void {
    this.visibleRows = Math.max(1, Math.floor(rows));
    this.clampScroll();
  }

  getScrollFromBottom(): number {
    return this.scrollFromBottom;
  }

  getMaxScroll(): number {
    return this.maxScroll;
  }

  scrollToBottom(): void {
    this.scrollFromBottom = 0;
  }

  scrollToTop(): void {
    this.scrollFromBottom = this.maxScroll;
  }

  scrollBy(deltaRows: number): void {
    // Positive deltas move toward newer content; negative deltas move up
    // into older history. Store the offset from the sticky bottom so new
    // streaming output can keep following when the offset is zero.
    this.scrollFromBottom -= deltaRows;
    this.clampScroll();
  }

  handleInput(data: string): boolean {
    const wheelDeltaRows = mouseWheelDeltaRows(data);
    if (wheelDeltaRows !== 0) {
      this.scrollBy(wheelDeltaRows);
      return true;
    }
    if (isMouseSequence(data)) return true;
    if (matchesKey(data, "pageUp")) {
      this.scrollBy(-this.pageSize());
      return true;
    }
    if (matchesKey(data, "pageDown")) {
      this.scrollBy(this.pageSize());
      return true;
    }
    if (matchesKey(data, "home")) {
      this.scrollToTop();
      return true;
    }
    if (matchesKey(data, "end")) {
      this.scrollToBottom();
      return true;
    }
    return false;
  }

  render(width: number): string[] {
    const allLines = this.components.flatMap((component) => component.render(width));
    const maxScroll = Math.max(0, allLines.length - this.visibleRows);
    if (this.scrollFromBottom > 0 && this.lastWidth === width && allLines.length > this.lastLineCount) {
      this.scrollFromBottom += allLines.length - this.lastLineCount;
    }
    this.lastLineCount = allLines.length;
    this.lastWidth = width;
    this.maxScroll = maxScroll;
    this.clampScroll();

    const start = Math.max(0, maxScroll - this.scrollFromBottom);
    const visible = allLines.slice(start, start + this.visibleRows);
    while (visible.length < this.visibleRows) visible.push(" ".repeat(width));
    return visible;
  }

  invalidate(): void {
    for (const component of this.components) component.invalidate();
  }

  private pageSize(): number {
    return Math.max(4, this.visibleRows - 2);
  }

  private clampScroll(): void {
    this.scrollFromBottom = Math.max(0, Math.min(this.maxScroll, this.scrollFromBottom));
  }
}

export class ScrollableChatTranscriptComponent<TEntry extends ChatTranscriptEntryLike>
  implements Component
{
  private readonly viewport = new ScrollableComponentViewport();
  private readonly transcript: ChatTranscriptComponent<TEntry>;

  constructor(
    entries: readonly TEntry[],
    renderEntry: ChatTranscriptRenderer<TEntry>,
  ) {
    this.transcript = new ChatTranscriptComponent(entries, renderEntry);
    this.viewport.setComponents([this.transcript]);
  }

  setVisibleRows(rows: number): void {
    this.viewport.setVisibleRows(rows);
  }

  handleInput(data: string): boolean {
    return this.viewport.handleInput(data);
  }

  render(width: number): string[] {
    return this.viewport.render(width);
  }

  invalidate(): void {
    this.viewport.invalidate();
  }

  getScrollFromBottom(): number {
    return this.viewport.getScrollFromBottom();
  }

  getMaxScroll(): number {
    return this.viewport.getMaxScroll();
  }

  scrollToBottom(): void {
    this.viewport.scrollToBottom();
  }
}

function mouseWheelDeltaRows(data: string): number {
  const sgr = data.match(/^\x1b\[<(\d+);\d+;\d+M$/);
  if (sgr) return wheelDeltaForButtonCode(Number.parseInt(sgr[1]!, 10));
  if (data.startsWith("\x1b[M") && data.length >= 6) {
    return wheelDeltaForButtonCode(data.charCodeAt(3) - 32);
  }
  return 0;
}

function wheelDeltaForButtonCode(code: number): number {
  if ((code & 64) === 0) return 0;
  const direction = code & 3;
  if (direction === 0) return -DEFAULT_SCROLL_STEP_ROWS;
  if (direction === 1) return DEFAULT_SCROLL_STEP_ROWS;
  return 0;
}

function isMouseSequence(data: string): boolean {
  return /^\x1b\[<\d+;\d+;\d+[mM]$/.test(data) || data.startsWith("\x1b[M");
}
