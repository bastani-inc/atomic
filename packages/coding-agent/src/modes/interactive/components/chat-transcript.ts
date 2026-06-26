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

export type ChatTranscriptCacheKey<TEntry extends ChatTranscriptEntryLike> = (
  entry: TEntry,
  index: number,
) => string;

interface CachedChatTranscriptBlock<TEntry extends ChatTranscriptEntryLike> {
  readonly entry: TEntry;
  readonly key: string;
  readonly width: number;
  readonly component: Component;
  readonly lines: readonly string[];
}

type DisposableComponent = Component & { dispose?: () => void };

interface RowWindowComponent extends Component {
  readonly supportsRowWindow: true;
  rowCount(width: number): number;
  renderRows(width: number, startRow: number, endRow: number): string[];
}

interface WindowedComponentRows {
  readonly kind: "windowed";
  readonly component: RowWindowComponent;
  readonly rowCount: number;
}

interface StaticComponentRows {
  readonly kind: "static";
  readonly lines: readonly string[];
  readonly rowCount: number;
}

type ComponentRows = WindowedComponentRows | StaticComponentRows;

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
  private readonly entries: readonly TEntry[];
  private readonly renderEntry: ChatTranscriptRenderer<TEntry>;
  readonly supportsRowWindow: boolean;

  private readonly cacheKey: ChatTranscriptCacheKey<TEntry> | undefined;
  private blockCache: Array<CachedChatTranscriptBlock<TEntry> | undefined> = [];

  constructor(
    entries: readonly TEntry[],
    renderEntry: ChatTranscriptRenderer<TEntry>,
    cacheKey?: ChatTranscriptCacheKey<TEntry>,
  ) {
    this.entries = entries;
    this.renderEntry = renderEntry;
    this.cacheKey = cacheKey;
    this.supportsRowWindow = cacheKey !== undefined;
  }

  render(width: number): string[] {
    if (!this.supportsRowWindow) return this.renderAllRows(width);
    return this.renderRows(width, 0, this.rowCount(width));
  }

  rowCount(width: number): number {
    if (!this.supportsRowWindow) return this.renderAllRows(width).length;
    this.ensureBlockCache(width);
    let count = 0;
    for (const block of this.blockCache) {
      if (block !== undefined) count += block.lines.length;
    }
    return count;
  }

  renderRows(width: number, startRow: number, endRow: number): string[] {
    const start = Math.max(0, Math.floor(startRow));
    const end = Math.max(start, Math.floor(endRow));
    if (end <= start) return [];
    if (!this.supportsRowWindow) return this.renderAllRows(width).slice(start, end);

    this.ensureBlockCache(width);
    const lines: string[] = [];
    let cursor = 0;
    for (let index = 0; index < this.entries.length; index += 1) {
      const block = this.blockCache[index];
      if (block === undefined) continue;
      const blockStart = cursor;
      const blockEnd = blockStart + block.lines.length;
      if (blockEnd > start && blockStart < end) {
        const localStart = Math.max(0, start - blockStart);
        const localEnd = Math.min(block.lines.length, end - blockStart);
        lines.push(...block.lines.slice(localStart, localEnd));
      }
      cursor = blockEnd;
      if (cursor >= end) break;
    }
    return lines;
  }

  invalidate(): void {
    for (const block of this.blockCache) disposeComponent(block?.component);
    this.blockCache = [];
  }

  private ensureBlockCache(width: number): void {
    if (this.blockCache.length > this.entries.length) {
      for (let index = this.entries.length; index < this.blockCache.length; index += 1) {
        disposeComponent(this.blockCache[index]?.component);
      }
      this.blockCache.length = this.entries.length;
    }
    for (let index = 0; index < this.entries.length; index += 1) {
      const entry = this.entries[index];
      if (entry === undefined) continue;
      const key = this.cacheKey?.(entry, index) ?? `${index}:${entry.role}`;
      const cached = this.blockCache[index];
      if (
        cached !== undefined &&
        cached.entry === entry &&
        cached.key === key &&
        cached.width === width
      ) {
        continue;
      }
      disposeComponent(cached?.component);
      const component = this.renderEntry(entry);
      this.blockCache[index] = {
        entry,
        key,
        width,
        component,
        lines: this.renderEntryBlock(component, entry, index, width),
      };
    }
  }

  private renderAllRows(width: number): string[] {
    const lines: string[] = [];
    for (let index = 0; index < this.entries.length; index += 1) {
      const entry = this.entries[index];
      if (entry !== undefined) lines.push(...this.renderEntryBlock(this.renderEntry(entry), entry, index, width));
    }
    return lines;
  }

  private renderEntryBlock(
    component: Component,
    entry: TEntry,
    index: number,
    width: number,
  ): string[] {
    const lines: string[] = [];
    if (index > 0 && needsLeadingSpacer(entry.role)) lines.push("");
    lines.push(...component.render(width));
    return lines;
  }
}

function disposeComponent(component: Component | undefined): void {
  (component as DisposableComponent | undefined)?.dispose?.();
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
    const componentRows = this.measureComponentRows(width);
    const lineCount = componentRows.reduce((sum, rows) => sum + rows.rowCount, 0);
    const maxScroll = Math.max(0, lineCount - this.visibleRows);
    if (this.scrollFromBottom > 0 && this.lastWidth === width && lineCount > this.lastLineCount) {
      this.scrollFromBottom += lineCount - this.lastLineCount;
    }
    this.lastLineCount = lineCount;
    this.lastWidth = width;
    this.maxScroll = maxScroll;
    this.clampScroll();

    const start = Math.max(0, maxScroll - this.scrollFromBottom);
    const visible = this.renderVisibleRows(
      componentRows,
      width,
      start,
      start + this.visibleRows,
    );
    while (visible.length < this.visibleRows) visible.push(" ".repeat(width));
    return visible;
  }

  invalidate(): void {
    for (const component of this.components) component.invalidate();
  }

  private measureComponentRows(width: number): ComponentRows[] {
    return this.components.map((component) => {
      if (isRowWindowComponent(component)) {
        return {
          kind: "windowed",
          component,
          rowCount: component.rowCount(width),
        };
      }
      const lines = component.render(width);
      return {
        kind: "static",
        lines,
        rowCount: lines.length,
      };
    });
  }

  private renderVisibleRows(
    componentRows: readonly ComponentRows[],
    width: number,
    startRow: number,
    endRow: number,
  ): string[] {
    const lines: string[] = [];
    let cursor = 0;
    for (const rows of componentRows) {
      const componentStart = cursor;
      const componentEnd = componentStart + rows.rowCount;
      if (componentEnd > startRow && componentStart < endRow) {
        const localStart = Math.max(0, startRow - componentStart);
        const localEnd = Math.min(rows.rowCount, endRow - componentStart);
        if (rows.kind === "windowed") {
          lines.push(...rows.component.renderRows(width, localStart, localEnd));
        } else {
          lines.push(...rows.lines.slice(localStart, localEnd));
        }
      }
      cursor = componentEnd;
      if (cursor >= endRow) break;
    }
    return lines;
  }

  private pageSize(): number {
    return Math.max(4, this.visibleRows - 2);
  }

  private clampScroll(): void {
    this.scrollFromBottom = Math.max(0, Math.min(this.maxScroll, this.scrollFromBottom));
  }
}

function isRowWindowComponent(component: Component): component is RowWindowComponent {
  const candidate = component as Partial<RowWindowComponent>;
  return candidate.supportsRowWindow === true &&
    typeof candidate.rowCount === "function" &&
    typeof candidate.renderRows === "function";
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
