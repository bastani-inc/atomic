import type { ExtensionAPI } from "@bastani/atomic";
import { randomUUID } from "crypto";
import { Type } from "typebox";
import { Text } from "@mariozechner/pi-tui";
import type { IntercomClient } from "./broker/client.ts";
import type { Message } from "./types.ts";
import { renderIntercomResult } from "./result-renderers.js";
import {
  formatAttachments,
  formatSessionListRow,
  getErrorMessage,
  previewText,
  toError,
} from "./intercom-utils.js";
import type { ReplyTracker } from "./reply-tracker.ts";

interface IntercomToolDeps {
  ensureConnected(reason: "tool"): Promise<IntercomClient>;
  syncPresenceIdentity(sessionId: string): void;
  resolveSessionTarget(activeClient: IntercomClient, nameOrId: string): Promise<string | null>;
  confirmSend: boolean;
  waitForReply(from: string, replyTo: string, signal?: AbortSignal): Promise<Message>;
  replyTracker: ReplyTracker;
  hasReplyWaiter(): boolean;
  rejectReplyWaiter(error: Error): void;
}

export function registerIntercomTool(pi: ExtensionAPI, deps: IntercomToolDeps): void {
  const { ensureConnected, syncPresenceIdentity, resolveSessionTarget, waitForReply, replyTracker, hasReplyWaiter, rejectReplyWaiter } = deps;
  pi.registerTool({
    name: "intercom",
    label: "Intercom",
    description: `Send a message to another pi session running on this machine.
Use this to communicate findings, request help, or coordinate work with other sessions.

Usage:
  intercom({ action: "list" })                    → List active sessions
  intercom({ action: "send", to: "session-name", message: "..." })  → Send message
  intercom({ action: "ask", to: "session-name", message: "..." })   → Ask and wait for reply
  intercom({ action: "reply", message: "..." })                      → Reply to the active/single pending ask
  intercom({ action: "pending" })                                      → List unresolved inbound asks
  intercom({ action: "status" })                  → Show connection status`,
    promptSnippet:
      "Use to coordinate with other local pi sessions: list peers, send updates, ask for help, or check intercom connectivity.",

    parameters: Type.Object({
      action: Type.String({
        description: "Action: 'list', 'send', 'ask', 'reply', 'pending', or 'status'",
      }),
      to: Type.Optional(Type.String({
        description: "Target session name or ID (for 'send', 'ask', or disambiguating 'reply')",
      })),
      message: Type.Optional(Type.String({
        description: "Message to send (for 'send', 'ask', or 'reply' action)",
      })),
      attachments: Type.Optional(Type.Array(Type.Object({
        type: Type.Union([Type.Literal("file"), Type.Literal("snippet"), Type.Literal("context")]),
        name: Type.String(),
        content: Type.String(),
        language: Type.Optional(Type.String()),
      }))),
      replyTo: Type.Optional(Type.String({
        description: "Message ID to reply to (for threading or responding to an 'ask')",
      })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      let connectedClient: IntercomClient;
      try {
        connectedClient = await ensureConnected("tool");
      } catch (error) {
        return {
          content: [{ type: "text", text: `Intercom not connected: ${getErrorMessage(error)}` }],
          isError: true,
          details: { error: true },
        };
      }

      syncPresenceIdentity(ctx.sessionManager.getSessionId());

      const { action, to, message, attachments, replyTo } = params;

      switch (action) {
        case "list": {
          try {
            const mySessionId = connectedClient.sessionId;
            const sessions = await connectedClient.listSessions();
            const currentSession = sessions.find(s => s.id === mySessionId);
            const otherSessions = sessions.filter(s => s.id !== mySessionId);

            if (!currentSession) {
              return {
                content: [{ type: "text", text: "Current session is missing from intercom session list." }],
                isError: true,
                details: { error: true },
              };
            }

            const currentSection = `**Current session:**\n${formatSessionListRow(currentSession, currentSession.cwd, true)}`;
            const otherSection = otherSessions.length === 0
              ? "**Other sessions:**\nNo other sessions connected."
              : `**Other sessions:**\n${otherSessions.map(s => formatSessionListRow(s, currentSession.cwd, false)).join("\n")}`;

            return {
              content: [{ type: "text", text: `${currentSection}\n\n${otherSection}` }],
              isError: false,
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to list sessions: ${getErrorMessage(error)}` }],
              isError: true,
              details: { error: true },
            };
          }
        }

        case "send": {
          if (!to || !message) {
            return {
              content: [{ type: "text", text: "Missing 'to' or 'message' parameter" }],
              isError: true,
              details: { error: true },
            };
          }
          try {
            const sendTo = await resolveSessionTarget(connectedClient, to) ?? to;
            if (sendTo === connectedClient.sessionId) {
              return {
                content: [{ type: "text", text: "Cannot message the current session" }],
                isError: true,
                details: { error: true },
              };
            }
            if (!replyTo && deps.confirmSend && ctx.hasUI) {
              const attachmentText = attachments?.length ? formatAttachments(attachments) : "";
              const confirmed = await ctx.ui.confirm(
                "Send Message",
                `Send to "${to}":\n\n${message}${attachmentText}`,
              );
              if (!confirmed) {
                return {
                  content: [{ type: "text", text: "Message cancelled by user" }],
                  isError: false,
                };
              }
            }
            const result = await connectedClient.send(sendTo, {
              text: message,
              attachments,
              replyTo,
            });
            if (!result.delivered) {
              const errorText = result.reason ?? "Session may not exist or has disconnected.";
              return {
                content: [{ type: "text", text: `Message to "${to}" was not delivered: ${errorText}` }],
                isError: true,
                details: { messageId: result.id, delivered: false, reason: result.reason },
              };
            }
            pi.appendEntry("intercom_sent", {
              to,
              message: { text: message, attachments, replyTo },
              messageId: result.id,
              timestamp: Date.now(),
            });
            if (replyTo) {
              replyTracker.markReplied(replyTo);
            }
            return {
              content: [{ type: "text", text: `Message sent to ${to}` }],
              isError: false,
              details: { messageId: result.id, delivered: true },
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to send: ${getErrorMessage(error)}` }],
              isError: true,
              details: { error: true },
            };
          }
        }

        case "ask": {
          if (!to || !message) {
            return {
              content: [{ type: "text", text: "Missing 'to' or 'message' parameter" }],
              isError: true,
              details: { error: true },
            };
          }

          if (hasReplyWaiter()) {
            return {
              content: [{ type: "text", text: "Already waiting for a reply" }],
              isError: true,
              details: { error: true },
            };
          }

          if (_signal?.aborted) {
            return {
              content: [{ type: "text", text: "Cancelled" }],
              isError: true,
              details: { error: true },
            };
          }
          let replyPromise: Promise<Message> | null = null;

          try {
            const sendTo = await resolveSessionTarget(connectedClient, to) ?? to;
            if (_signal?.aborted) {
              return {
                content: [{ type: "text", text: "Cancelled" }],
                isError: true,
                details: { error: true },
              };
            }
            if (sendTo === connectedClient.sessionId) {
              return {
                content: [{ type: "text", text: "Cannot message the current session" }],
                isError: true,
                details: { error: true },
              };
            }
            const questionId = randomUUID();
            replyPromise = waitForReply(sendTo, questionId, _signal);
            const sendResult = await connectedClient.send(sendTo, {
              messageId: questionId,
              text: message,
              attachments,
              replyTo,
              expectsReply: true,
            });

            if (!sendResult.delivered) {
              const errorText = sendResult.reason ?? "Session may not exist or has disconnected.";
              rejectReplyWaiter(new Error(`Message to "${to}" was not delivered: ${errorText}`));
              if (replyPromise) {
                try {
                  await replyPromise;
                } catch {
                  // The waiter was already rejected above. Keep the delivery failure as the only error here.
                }
              }
              return {
                content: [{ type: "text", text: `Message to "${to}" was not delivered: ${errorText}` }],
                isError: true,
                details: { error: true },
              };
            }
            pi.appendEntry("intercom_sent", {
              to,
              message: { text: message, attachments, replyTo },
              messageId: sendResult.id,
              timestamp: Date.now(),
            });
            const replyMessage = await replyPromise;
            const replyText = replyMessage.content.text;
            const replyAttachments = replyMessage.content.attachments?.length
              ? formatAttachments(replyMessage.content.attachments)
              : "";
            pi.appendEntry("intercom_received", {
              from: to,
              message: { text: replyText, attachments: replyMessage.content.attachments },
              messageId: replyMessage.id,
              timestamp: replyMessage.timestamp,
            });
            return {
              content: [{ type: "text", text: `**Reply from ${to}:**\n${replyText}${replyAttachments}` }],
              isError: false,
            };
          } catch (error) {
            rejectReplyWaiter(toError(error));
            if (replyPromise) {
              try {
                await replyPromise;
              } catch {
                // The waiter is cleanup-only on this path. The real failure is the one from the outer catch.
              }
            }
            return {
              content: [{ type: "text", text: `Failed: ${getErrorMessage(error)}` }],
              isError: true,
              details: { error: true },
            };
          }
        }

        case "reply": {
          if (!message) {
            return {
              content: [{ type: "text", text: "Missing 'message' parameter" }],
              isError: true,
              details: { error: true },
            };
          }

          try {
            const target = replyTracker.resolveReplyTarget({ to });
            if (target.from.id === connectedClient.sessionId) {
              return {
                content: [{ type: "text", text: "Cannot message the current session" }],
                isError: true,
                details: { error: true },
              };
            }
            const result = await connectedClient.send(target.from.id, {
              text: message,
              replyTo: target.message.id,
            });
            if (!result.delivered) {
              const errorText = result.reason ?? "Session may not exist or has disconnected.";
              return {
                content: [{ type: "text", text: `Reply to "${target.from.name || target.from.id}" was not delivered: ${errorText}` }],
                isError: true,
                details: { messageId: result.id, delivered: false, reason: result.reason },
              };
            }
            replyTracker.markReplied(target.message.id);
            pi.appendEntry("intercom_sent", {
              to: target.from.name || target.from.id,
              message: { text: message, replyTo: target.message.id },
              messageId: result.id,
              timestamp: Date.now(),
            });
            return {
              content: [{ type: "text", text: `Reply sent to ${target.from.name || target.from.id}` }],
              isError: false,
              details: { messageId: result.id, delivered: true, replyTo: target.message.id },
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to reply: ${getErrorMessage(error)}` }],
              isError: true,
              details: { error: true },
            };
          }
        }

        case "pending": {
          const pendingAsks = replyTracker.listPending();
          if (pendingAsks.length === 0) {
            return {
              content: [{ type: "text", text: "No unresolved inbound asks." }],
              isError: false,
            };
          }

          const now = Date.now();
          const lines = pendingAsks.map(({ from, message, receivedAt }) => {
            const preview = message.content.text.replace(/\s+/g, " ").slice(0, 80);
            const elapsedSeconds = Math.max(0, Math.floor((now - receivedAt) / 1000));
            return `- ${from.name || from.id} · ${message.id} · ${elapsedSeconds}s ago · ${preview}`;
          });
          return {
            content: [{ type: "text", text: `**Pending asks:**\n${lines.join("\n")}` }],
            isError: false,
          };
        }

        case "status": {
          try {
            const mySessionId = connectedClient.sessionId;
            const sessions = await connectedClient.listSessions();
            return {
              content: [{
                type: "text",
                text: `**Intercom Status:**\nConnected: Yes\nSession ID: ${mySessionId}\nActive sessions: ${sessions.length}`,
              }],
              isError: false,
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to get status: ${getErrorMessage(error)}` }],
              isError: true,
              details: { error: true },
            };
          }
        }

        default:
          return {
            content: [{ type: "text", text: `Unknown action: ${action}` }],
            isError: true,
            details: { error: true },
          };
      }
    },
    renderCall(args, theme) {
      const action = typeof args.action === "string" ? args.action : "intercom";
      const target = typeof args.to === "string" && args.to.trim() ? args.to.trim() : undefined;
      const messagePreview = previewText(args.message, 96);
      const attachmentCount = Array.isArray(args.attachments) ? args.attachments.length : 0;
      let text = theme.fg("toolTitle", theme.bold("intercom "));
      text += theme.fg(action === "ask" ? "warning" : action === "reply" ? "success" : "accent", action);
      if (target) {
        text += " " + theme.fg("muted", "→") + " " + theme.fg("accent", target);
      }
      if (attachmentCount > 0) {
        text += " " + theme.fg("dim", `(${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"})`);
      }
      if (messagePreview) {
        text += "\n  " + theme.fg("dim", messagePreview);
      }
      return new Text(text, 0, 0);
    },
    renderResult: renderIntercomResult,
  });
}
