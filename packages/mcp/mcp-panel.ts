import { matchesKey } from "@earendil-works/pi-tui";
import type { MetadataCache } from "./metadata-cache.ts";
import type { McpConfig, McpPanelCallbacks, McpPanelResult, ServerProvenance } from "./types.ts";
import {
  buildMcpPanelResult,
  buildServerStates,
  calculateDirty,
  getToolPrefix,
  rebuildServerTools,
  rebuildVisibleItems as buildVisibleItems,
  type ToolPrefix,
} from "./mcp-panel-state.ts";
import { renderMcpPanel } from "./mcp-panel-renderer.ts";
import {
  DEFAULT_THEME,
  type McpPanelOptions,
  type PanelTheme,
  type PanelTui,
  type ServerState,
  type VisibleItem,
} from "./mcp-panel-types.ts";

class McpPanel {
  private noticeLines: string[];
  private readonly prefix: ToolPrefix;
  private servers: ServerState[] = [];
  private cursorIndex = 0;
  private nameQuery = "";
  private descSearchActive = false;
  private descQuery = "";
  private dirty = false;
  private confirmingDiscard = false;
  private discardSelected = 1;
  private importNotice: string | null = null;
  private authNotice: string | null = null;
  private authInFlight: string | null = null;
  private inactivityTimeout: ReturnType<typeof setTimeout> | null = null;
  private visibleItems: VisibleItem[] = [];
  private readonly t: PanelTheme = DEFAULT_THEME;
  private readonly authOnly: boolean;

  private static readonly MAX_VISIBLE = 12;
  private static readonly INACTIVITY_MS = 60_000;

  constructor(
    config: McpConfig,
    cache: MetadataCache | null,
    provenance: Map<string, ServerProvenance>,
    private readonly callbacks: McpPanelCallbacks,
    private readonly tui: PanelTui,
    private readonly done: (result: McpPanelResult) => void,
    options: McpPanelOptions = {},
  ) {
    this.noticeLines = options.noticeLines ?? [];
    this.authOnly = options.authOnly === true;
    this.prefix = getToolPrefix(config);
    this.servers = buildServerStates(config, cache, provenance, callbacks, this.authOnly, this.prefix);
    this.rebuildVisibleItems();
    this.resetInactivityTimeout();
  }

  private resetInactivityTimeout(): void {
    if (this.inactivityTimeout) clearTimeout(this.inactivityTimeout);
    this.inactivityTimeout = setTimeout(() => {
      this.cleanup();
      this.done({ cancelled: true, changes: new Map() });
    }, McpPanel.INACTIVITY_MS);
  }

  private cleanup(): void {
    if (this.inactivityTimeout) {
      clearTimeout(this.inactivityTimeout);
      this.inactivityTimeout = null;
    }
  }

  private rebuildVisibleItems(): void {
    this.visibleItems = buildVisibleItems(
      this.servers,
      this.nameQuery,
      this.descSearchActive,
      this.descQuery,
      this.authOnly,
    );
  }

  private clampCursor(): void {
    this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1));
  }

  private rebuildVisibleItemsAndClampCursor(): void {
    this.rebuildVisibleItems();
    this.clampCursor();
  }

  private updateDirty(): void {
    this.dirty = calculateDirty(this.servers);
  }

  private buildResult(): McpPanelResult {
    return buildMcpPanelResult(this.servers);
  }

  handleInput(data: string): void {
    this.resetInactivityTimeout();
    this.importNotice = null;
    if (!this.authInFlight) this.authNotice = null;

    if (this.confirmingDiscard) {
      this.handleDiscardInput(data);
      return;
    }

    if (matchesKey(data, "ctrl+c")) {
      this.cleanup();
      this.done({ cancelled: true, changes: new Map() });
      return;
    }

    if (matchesKey(data, "ctrl+s")) {
      this.cleanup();
      this.done(this.buildResult());
      return;
    }

    if (this.descSearchActive) {
      this.handleDescriptionSearchInput(data);
      return;
    }

    if (matchesKey(data, "escape")) {
      if (this.nameQuery) {
        this.nameQuery = "";
        this.rebuildVisibleItemsAndClampCursor();
        return;
      }
      if (this.dirty) {
        this.confirmingDiscard = true;
        this.discardSelected = 1;
        return;
      }
      this.cleanup();
      this.done({ cancelled: true, changes: new Map() });
      return;
    }

    if (matchesKey(data, "up")) { this.moveCursor(-1); return; }
    if (matchesKey(data, "down")) { this.moveCursor(1); return; }

    if (matchesKey(data, "space")) {
      const item = this.visibleItems[this.cursorIndex];
      if (item && !this.authOnly) this.toggleItem(item);
      return;
    }

    if (matchesKey(data, "return")) {
      const item = this.visibleItems[this.cursorIndex];
      if (item) this.activateItem(item);
      return;
    }

    if (matchesKey(data, "ctrl+a")) {
      const item = this.visibleItems[this.cursorIndex];
      if (item) this.authenticateSelectedServer(item);
      return;
    }

    if (matchesKey(data, "ctrl+r")) {
      const item = this.visibleItems[this.cursorIndex];
      if (item) this.reconnectSelectedServer(item);
      return;
    }

    if (data === "?") {
      if (this.authOnly) return;
      this.descSearchActive = true;
      this.descQuery = "";
      this.rebuildVisibleItemsAndClampCursor();
      return;
    }

    if (matchesKey(data, "backspace")) {
      if (this.nameQuery.length > 0) {
        this.nameQuery = this.nameQuery.slice(0, -1);
        this.rebuildVisibleItemsAndClampCursor();
      }
      return;
    }

    if (data.length === 1 && data.charCodeAt(0) >= 32) {
      this.nameQuery += data;
      this.rebuildVisibleItemsAndClampCursor();
    }
  }

  private handleDescriptionSearchInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "return")) {
      this.descSearchActive = false;
      this.descQuery = "";
      this.rebuildVisibleItemsAndClampCursor();
      return;
    }
    if (matchesKey(data, "backspace")) {
      if (this.descQuery.length > 0) {
        this.descQuery = this.descQuery.slice(0, -1);
        this.rebuildVisibleItemsAndClampCursor();
      }
      return;
    }
    if (matchesKey(data, "up")) { this.moveCursor(-1); return; }
    if (matchesKey(data, "down")) { this.moveCursor(1); return; }
    if (matchesKey(data, "space")) {
      const item = this.visibleItems[this.cursorIndex];
      if (item) this.toggleItem(item);
      return;
    }
    if (data.length === 1 && data.charCodeAt(0) >= 32) {
      this.descQuery += data;
      this.rebuildVisibleItemsAndClampCursor();
    }
  }

  private activateItem(item: VisibleItem): void {
    const server = this.servers[item.serverIndex];
    if (item.type === "server") {
      if (this.authOnly || server.connectionStatus === "needs-auth") {
        this.authenticateServer(server);
        return;
      }
      server.expanded = !server.expanded;
      this.rebuildVisibleItemsAndClampCursor();
      return;
    }

    if (item.toolIndex !== undefined) {
      const tool = server.tools[item.toolIndex];
      tool.isDirect = !tool.isDirect;
      if (tool.isDirect && server.source === "import") {
        this.importNotice = `Imported from ${server.importKind ?? "external"} — will copy to user config on save`;
      }
      this.updateDirty();
    }
  }

  private reconnectSelectedServer(item: VisibleItem): void {
    const server = this.servers[item.serverIndex];
    if (server.connectionStatus === "connecting") return;
    server.connectionStatus = "connecting";
    this.callbacks.reconnect(server.name).then(() => {
      server.connectionStatus = this.callbacks.getConnectionStatus(server.name);
      if (server.connectionStatus === "connected") {
        const entry = this.callbacks.refreshCacheAfterReconnect(server.name);
        if (entry) {
          rebuildServerTools(server, entry, this.prefix);
          this.rebuildVisibleItems();
          this.updateDirty();
        }
        server.hasCachedData = true;
      }
      this.tui.requestRender();
    }).catch((error) => {
      server.connectionStatus = "failed";
      const message = error instanceof Error ? error.message : String(error);
      this.authNotice = `Reconnect failed for ${server.name}: ${message}`;
      this.tui.requestRender();
    });
  }

  private authenticateSelectedServer(item: VisibleItem): void {
    this.authenticateServer(this.servers[item.serverIndex]);
  }

  private authenticateServer(server: ServerState): void {
    if (this.authInFlight) return;
    if (!this.callbacks.canAuthenticate(server.name)) {
      this.authNotice = `${server.name} does not use OAuth authentication.`;
      return;
    }

    this.authInFlight = server.name;
    this.authNotice = `Authenticating ${server.name}...`;
    this.tui.requestRender();

    this.callbacks.authenticate(server.name).then((result) => {
      server.connectionStatus = this.callbacks.getConnectionStatus(server.name);
      this.authNotice = result.ok
        ? `OAuth finished for ${server.name}. Run reconnect if it is still idle.`
        : `OAuth failed for ${server.name}${result.message ? `: ${result.message}` : ". Check the notification for details."}`;
      this.authInFlight = null;
      this.tui.requestRender();
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      server.connectionStatus = this.callbacks.getConnectionStatus(server.name);
      this.authNotice = `OAuth failed for ${server.name}: ${message}`;
      this.authInFlight = null;
      this.tui.requestRender();
    });
  }

  private toggleItem(item: VisibleItem): void {
    if (this.authOnly) return;
    const server = this.servers[item.serverIndex];
    if (item.type === "server") {
      const newState = !server.tools.every((tool) => tool.isDirect);
      if (server.source === "import" && newState) {
        this.importNotice = `Imported from ${server.importKind ?? "external"} — will copy to user config on save`;
      }
      for (const tool of server.tools) tool.isDirect = newState;
    } else if (item.toolIndex !== undefined) {
      const tool = server.tools[item.toolIndex];
      tool.isDirect = !tool.isDirect;
      if (tool.isDirect && server.source === "import") {
        this.importNotice = `Imported from ${server.importKind ?? "external"} — will copy to user config on save`;
      }
    }
    this.updateDirty();
  }

  private handleDiscardInput(data: string): void {
    if (matchesKey(data, "ctrl+c")) {
      this.cleanup();
      this.done({ cancelled: true, changes: new Map() });
      return;
    }
    if (matchesKey(data, "escape") || data === "n" || data === "N") {
      this.confirmingDiscard = false;
      return;
    }
    if (matchesKey(data, "return")) {
      if (this.discardSelected === 0) {
        this.cleanup();
        this.done({ cancelled: true, changes: new Map() });
      } else {
        this.confirmingDiscard = false;
      }
      return;
    }
    if (data === "y" || data === "Y") {
      this.cleanup();
      this.done({ cancelled: true, changes: new Map() });
      return;
    }
    if (matchesKey(data, "left") || matchesKey(data, "right") || matchesKey(data, "tab")) {
      this.discardSelected = this.discardSelected === 0 ? 1 : 0;
    }
  }

  private moveCursor(delta: number): void {
    if (this.visibleItems.length === 0) return;
    this.cursorIndex = Math.max(0, Math.min(this.visibleItems.length - 1, this.cursorIndex + delta));
  }

  render(width: number): string[] {
    return renderMcpPanel({
      width,
      theme: this.t,
      authOnly: this.authOnly,
      descSearchActive: this.descSearchActive,
      descQuery: this.descQuery,
      nameQuery: this.nameQuery,
      noticeLines: this.noticeLines,
      servers: this.servers,
      visibleItems: this.visibleItems,
      cursorIndex: this.cursorIndex,
      importNotice: this.importNotice,
      authNotice: this.authNotice,
      authInFlight: this.authInFlight,
      confirmingDiscard: this.confirmingDiscard,
      discardSelected: this.discardSelected,
      dirty: this.dirty,
      maxVisible: McpPanel.MAX_VISIBLE,
    });
  }

  invalidate(): void {}

  dispose(): void {
    this.cleanup();
  }
}

export function createMcpPanel(
  config: McpConfig,
  cache: MetadataCache | null,
  provenance: Map<string, ServerProvenance>,
  callbacks: McpPanelCallbacks,
  tui: { requestRender(): void },
  done: (result: McpPanelResult) => void,
  options?: { noticeLines?: string[]; authOnly?: boolean },
): McpPanel & { dispose(): void } {
  return new McpPanel(config, cache, provenance, callbacks, tui, done, options ?? {});
}
