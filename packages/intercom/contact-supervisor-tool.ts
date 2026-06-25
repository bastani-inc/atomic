import type { ExtensionAPI } from "@bastani/atomic";
import { randomUUID } from "crypto";
import { Type } from "typebox";
import { Text } from "@mariozechner/pi-tui";
import type { IntercomClient } from "./broker/client.ts";
import type { Message } from "./types.ts";
import { renderContactSupervisorResult } from "./result-renderers.js";
import {
  type ChildOrchestratorMetadata,
  type ContactSupervisorReason,
  formatChildOrchestratorMessage,
  formatSupervisorInterviewRequest,
  formatAttachments,
  getErrorMessage,
  parseStructuredSupervisorReply,
  previewText,
  toError,
  validateSupervisorInterviewRequest,
} from "./intercom-utils.js";

interface ContactSupervisorDeps {
  childOrchestratorMetadata: ChildOrchestratorMetadata | null;
  ensureConnected(reason: "tool"): Promise<IntercomClient>;
  syncPresenceIdentity(sessionId: string): void;
  resolveSessionTarget(activeClient: IntercomClient, nameOrId: string): Promise<string | null>;
  waitForReply(from: string, replyTo: string, signal?: AbortSignal): Promise<Message>;
  hasReplyWaiter(): boolean;
  rejectReplyWaiter(error: Error): void;
}

export function registerContactSupervisorTool(pi: ExtensionAPI, deps: ContactSupervisorDeps): void {
  const { childOrchestratorMetadata, ensureConnected, syncPresenceIdentity, resolveSessionTarget, waitForReply, hasReplyWaiter, rejectReplyWaiter } = deps;
  if (childOrchestratorMetadata) {
    pi.registerTool({
      name: "contact_supervisor",
      label: "Contact Supervisor",
      description: "Subagent-only tool for contacting the supervisor agent that delegated this task. Use need_decision when blocked, uncertain, needing approval, or facing a product/API/scope decision before continuing; this waits for the supervisor's reply. Use interview_request when multiple structured questions need supervisor answers; this also waits for a reply. Use progress_update only for meaningful progress or unexpected discoveries that change the plan; this does not wait for a reply. Do not use for routine completion handoffs.",
      promptSnippet: "Subagent-only: contact the supervisor for decisions, structured interviews, or meaningful plan-changing updates. Do not use for routine completion handoffs.",
      promptGuidelines: [
        "Use contact_supervisor with reason='need_decision' when a subagent is blocked, uncertain, needs approval, or faces a product/API/scope decision before continuing.",
        "Use contact_supervisor with reason='interview_request' when the child needs multiple structured answers from the supervisor in one blocking exchange.",
        "Use contact_supervisor with reason='progress_update' only for meaningful progress or unexpected discoveries that change the plan.",
        "Do not use contact_supervisor for routine completion handoffs; return the final subagent result normally.",
      ],
      parameters: Type.Object({
        reason: Type.String({
          enum: ["need_decision", "progress_update", "interview_request"],
          description: "Contact reason: 'need_decision' waits for a reply; 'interview_request' sends structured questions and waits for a reply; 'progress_update' sends a non-blocking update",
        }),
        message: Type.Optional(Type.String({
          description: "Decision request, optional interview note, or meaningful progress update for the supervisor",
        })),
        interview: Type.Optional(Type.Object({
          title: Type.Optional(Type.String()),
          description: Type.Optional(Type.String()),
          questions: Type.Array(Type.Object({
            id: Type.String(),
            type: Type.String({ description: "Question type: single, multi, text, image, or info" }),
            question: Type.String(),
            options: Type.Optional(Type.Array(Type.Unknown())),
            context: Type.Optional(Type.String()),
          })),
        }, { description: "Structured interview request for reason='interview_request'" })),
      }),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const reason = params.reason as ContactSupervisorReason;
        if (reason !== "need_decision" && reason !== "progress_update" && reason !== "interview_request") {
          return {
            content: [{ type: "text", text: "Invalid reason. Use 'need_decision', 'interview_request', or 'progress_update'." }],
            isError: true,
            details: { error: true },
          };
        }
        if ((reason === "need_decision" || reason === "progress_update") && typeof params.message !== "string") {
          return {
            content: [{ type: "text", text: `Missing 'message' parameter for reason '${reason}'.` }],
            isError: true,
            details: { error: true },
          };
        }
        const interviewValidation = reason === "interview_request"
          ? validateSupervisorInterviewRequest(params.interview)
          : undefined;
        if (interviewValidation?.ok === false) {
          return {
            content: [{ type: "text", text: `Invalid interview request: ${interviewValidation.error}` }],
            isError: true,
            details: { error: true },
          };
        }
        const supervisorInterview = interviewValidation?.ok === true ? interviewValidation.interview : undefined;

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

        if (signal?.aborted) {
          return {
            content: [{ type: "text", text: "Cancelled" }],
            isError: true,
            details: { error: true },
          };
        }

        const metadata = childOrchestratorMetadata;
        let sendTo: string;
        try {
          sendTo = await resolveSessionTarget(connectedClient, metadata.orchestratorTarget) ?? metadata.orchestratorTarget;
        } catch (error) {
          return {
            content: [{ type: "text", text: `Failed to resolve supervisor target: ${getErrorMessage(error)}` }],
            isError: true,
            details: { error: true },
          };
        }
        if (signal?.aborted) {
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

        if (reason === "progress_update") {
          const message = params.message as string;
          try {
            const result = await connectedClient.send(sendTo, {
              text: formatChildOrchestratorMessage("update", metadata, message),
            });
            if (!result.delivered) {
              const errorText = result.reason ?? "Session may not exist or has disconnected.";
              return {
                content: [{ type: "text", text: `Message to "${metadata.orchestratorTarget}" was not delivered: ${errorText}` }],
                isError: true,
                details: { messageId: result.id, delivered: false, reason: result.reason },
              };
            }
            pi.appendEntry("intercom_sent", {
              to: metadata.orchestratorTarget,
              message: { text: message, reason },
              messageId: result.id,
              timestamp: Date.now(),
              subagent: { runId: metadata.runId, agent: metadata.agent, index: metadata.index },
            });
            return {
              content: [{ type: "text", text: `Progress update sent to supervisor ${metadata.orchestratorTarget}` }],
              isError: false,
              details: { messageId: result.id, delivered: true },
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to send progress update: ${getErrorMessage(error)}` }],
              isError: true,
              details: { error: true },
            };
          }
        }

        if (hasReplyWaiter()) {
          return {
            content: [{ type: "text", text: "Already waiting for a reply" }],
            isError: true,
            details: { error: true },
          };
        }

        let replyPromise: Promise<Message> | null = null;
        try {
          const questionId = randomUUID();
          replyPromise = waitForReply(sendTo, questionId, signal);
          replyPromise.catch(() => undefined);
          if (signal?.aborted) {
            rejectReplyWaiter(new Error("Cancelled"));
            try {
              await replyPromise;
            } catch {
              // The waiter was intentionally rejected above; the tool result reports cancellation.
            }
            return {
              content: [{ type: "text", text: "Cancelled" }],
              isError: true,
              details: { error: true },
            };
          }
          const requestText = reason === "interview_request"
            ? formatChildOrchestratorMessage("interview", metadata, formatSupervisorInterviewRequest(supervisorInterview!, typeof params.message === "string" ? params.message : undefined))
            : formatChildOrchestratorMessage("ask", metadata, params.message as string);
          const sendResult = await connectedClient.send(sendTo, {
            messageId: questionId,
            text: requestText,
            expectsReply: true,
          });
          if (!sendResult.delivered) {
            const errorText = sendResult.reason ?? "Session may not exist or has disconnected.";
            rejectReplyWaiter(new Error(`Message to "${metadata.orchestratorTarget}" was not delivered: ${errorText}`));
            if (replyPromise) {
              try {
                await replyPromise;
              } catch {
                // The waiter was already rejected above. Keep the delivery failure as the only error here.
              }
            }
            return {
              content: [{ type: "text", text: `Message to "${metadata.orchestratorTarget}" was not delivered: ${errorText}` }],
              isError: true,
              details: { error: true },
            };
          }
          pi.appendEntry("intercom_sent", {
            to: metadata.orchestratorTarget,
            message: {
              text: reason === "interview_request" ? requestText : params.message,
              reason,
              ...(reason === "interview_request" ? { interview: supervisorInterview } : {}),
            },
            messageId: sendResult.id,
            timestamp: Date.now(),
            subagent: { runId: metadata.runId, agent: metadata.agent, index: metadata.index },
          });
          const replyMessage = await replyPromise;
          const replyText = replyMessage.content.text;
          const replyAttachments = replyMessage.content.attachments?.length
            ? formatAttachments(replyMessage.content.attachments)
            : "";
          const structuredReply = reason === "interview_request" ? parseStructuredSupervisorReply(replyText, supervisorInterview!) : undefined;
          pi.appendEntry("intercom_received", {
            from: metadata.orchestratorTarget,
            message: { text: replyText, attachments: replyMessage.content.attachments },
            messageId: replyMessage.id,
            timestamp: replyMessage.timestamp,
            subagent: { runId: metadata.runId, agent: metadata.agent, index: metadata.index },
          });
          return {
            content: [{ type: "text", text: `**Reply from supervisor:**\n${replyText}${replyAttachments}` }],
            isError: false,
            ...(structuredReply
              ? { details: structuredReply.value !== undefined ? { structuredReply: structuredReply.value } : { structuredReplyParseError: structuredReply.error } }
              : {}),
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
      },
      renderCall(args, theme) {
        const reason = typeof args.reason === "string" ? args.reason : "contact";
        const messagePreview = previewText(args.message, 96);
        const interview = args.interview && typeof args.interview === "object" ? args.interview as { title?: unknown } : undefined;
        let text = theme.fg("toolTitle", theme.bold("contact_supervisor "));
        text += theme.fg(reason === "need_decision" ? "warning" : reason === "progress_update" ? "muted" : "accent", reason);
        if (typeof interview?.title === "string" && interview.title.trim()) {
          text += " " + theme.fg("accent", interview.title.trim());
        }
        if (messagePreview) {
          text += "\n  " + theme.fg("dim", messagePreview);
        }
        return new Text(text, 0, 0);
      },
      renderResult: renderContactSupervisorResult,
    });
  }
}
