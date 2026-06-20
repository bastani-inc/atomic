import type { ExtensionAPI, ExtensionContext } from "@bastani/atomic";
import type { IntercomClient } from "./broker/client.ts";
import type { ComposeResult } from "./ui/compose.ts";
import { ComposeOverlay } from "./ui/compose.ts";
import { SessionListOverlay } from "./ui/session-list.ts";
import type { SessionInfo } from "./types.ts";
import { duplicateSessionNames, formatSessionLabel, getErrorMessage } from "./intercom-utils.js";

interface OverlayDeps {
  runtimeGeneration(): number;
  getLiveContext(ctx?: ExtensionContext | null, generation?: number): ExtensionContext | null;
  notifyIfLive(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error", generation?: number): void;
  ensureConnected(reason: "overlay"): Promise<IntercomClient>;
  syncPresenceIdentity(sessionId: string): void;
}

export function registerIntercomOverlay(pi: ExtensionAPI, deps: OverlayDeps): void {
  async function openIntercomOverlay(ctx: ExtensionContext): Promise<void> {
    const overlayGeneration = deps.runtimeGeneration();
    const liveContext = deps.getLiveContext(ctx, overlayGeneration);
    if (!liveContext?.hasUI) return;

    let overlayClient: IntercomClient;
    try {
      overlayClient = await deps.ensureConnected("overlay");
    } catch (error) {
      deps.notifyIfLive(ctx, `Intercom unavailable: ${getErrorMessage(error)}`, "error", overlayGeneration);
      return;
    }
    if (!deps.getLiveContext(ctx, overlayGeneration)) return;

    deps.syncPresenceIdentity(ctx.sessionManager.getSessionId());

    let currentSession: SessionInfo;
    let sessions: SessionInfo[];
    let duplicates: Set<string>;
    try {
      const mySessionId = overlayClient.sessionId;
      const allSessions = await overlayClient.listSessions();
      if (!deps.getLiveContext(ctx, overlayGeneration)) return;
      const foundCurrentSession = allSessions.find(s => s.id === mySessionId);
      if (!foundCurrentSession) {
        deps.notifyIfLive(ctx, "Current session is missing from intercom session list", "error", overlayGeneration);
        return;
      }
      currentSession = foundCurrentSession;
      duplicates = duplicateSessionNames(allSessions);
      sessions = allSessions.filter(s => s.id !== mySessionId);
    } catch (error) {
      deps.notifyIfLive(ctx, `Failed to list sessions: ${getErrorMessage(error)}`, "error", overlayGeneration);
      return;
    }

    const selectedSession = await ctx.ui.custom<SessionInfo | undefined>(
      (_tui, theme, keybindings, done) => new SessionListOverlay(theme, keybindings, currentSession, sessions, done),
      { overlay: true }
    ).catch(() => undefined);

    if (!selectedSession || !deps.getLiveContext(ctx, overlayGeneration)) return;

    try {
      overlayClient = await deps.ensureConnected("overlay");
    } catch (error) {
      deps.notifyIfLive(ctx, `Intercom unavailable: ${getErrorMessage(error)}`, "error", overlayGeneration);
      return;
    }
    if (!deps.getLiveContext(ctx, overlayGeneration)) return;

    const targetLabel = formatSessionLabel(selectedSession, duplicates);

    const result = await ctx.ui.custom<ComposeResult>(
      (tui, theme, keybindings, done) => new ComposeOverlay(tui, theme, keybindings, selectedSession, targetLabel, overlayClient, done),
      { overlay: true }
    ).catch(() => undefined);

    if (result?.sent && result.messageId && result.text && deps.getLiveContext(ctx, overlayGeneration)) {
      pi.appendEntry("intercom_sent", {
        to: selectedSession.name || selectedSession.id,
        message: { text: result.text },
        messageId: result.messageId,
        timestamp: Date.now(),
      });
      deps.notifyIfLive(ctx, `Message sent to ${targetLabel}`, "info", overlayGeneration);
    }
  }

  pi.registerCommand("intercom", {
    description: "Open session intercom overlay",
    handler: async (_args, ctx) => openIntercomOverlay(ctx),
  });

  pi.registerShortcut("alt+m", {
    description: "Open session intercom",
    handler: async (ctx) => openIntercomOverlay(ctx),
  });
}
