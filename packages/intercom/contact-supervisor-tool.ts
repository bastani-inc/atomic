import type { ExtensionAPI } from "@bastani/atomic";
import { randomUUID } from "crypto";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { IntercomClient } from "./broker/client.js";
import type { ReplyWait, ReplyWaitAdmission } from "./reply-waiter.ts";
import { requestParentAskHandoff } from "./parent-ask-handoff.js";
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
  childOrchestratorMetadata: ChildOrchestratorMetadata | null | (() => ChildOrchestratorMetadata | null);
  ensureConnected(reason: "tool"): Promise<IntercomClient>;
  syncPresenceIdentity(sessionId: string): void;
  resolveSessionTarget(activeClient: IntercomClient, nameOrId: string): Promise<string | null>;
	/** Atomically reserves one correlation-keyed reply waiter from the shared capacity. */
	beginReplyWait(from: string, replyTo: string, signal?: AbortSignal): ReplyWaitAdmission;
}

export function registerContactSupervisorTool(pi: ExtensionAPI, deps: ContactSupervisorDeps): void {
	const { childOrchestratorMetadata, ensureConnected, syncPresenceIdentity, resolveSessionTarget, beginReplyWait } = deps;
  const getMetadata = typeof childOrchestratorMetadata === "function"
    ? childOrchestratorMetadata
    : () => childOrchestratorMetadata;
	// Supervisor decisions/interviews are exclusive (one blocking wait per child),
	// while ordinary peer asks may coexist under the shared registry cap.
	let supervisorWaitActive = false;
	let supervisorHandoffClaimed = false;
  if (childOrchestratorMetadata !== null) {
    pi.registerTool({
      name: "contact_supervisor",
      label: "Contact Supervisor",
      description: "Subagent-only tool for contacting the supervisor agent that delegated this task. In a live foreground child, need_decision and interview_request end the child and return a fresh-subagent handoff to the supervisor; fallback Intercom delivery waits for a reply when no foreground owner claims the request. One blocking supervisor request is allowed per child and may coexist with ordinary intercom asks. progress_update is fire-and-forget. Do not use for routine completion handoffs.",
      promptSnippet: "Subagent-only: yield decisions or structured interviews to the supervisor for a fresh-child follow-up, or send meaningful plan-changing progress updates.",
      promptGuidelines: [
        "Use contact_supervisor with reason='need_decision' when a subagent is blocked, uncertain, needs approval, or faces a product/API/scope decision. A claimed foreground request ends this child; do not wait for a reply.",
        "Use contact_supervisor with reason='interview_request' when the child needs multiple structured answers. A claimed foreground request ends this child; the supervisor starts a fresh child with the answers.",
        "Use contact_supervisor with reason='progress_update' only for meaningful progress or unexpected discoveries that change the plan.",
        "Do not use contact_supervisor for routine completion handoffs; return the final subagent result normally.",
      ],
      parameters: Type.Object({
        reason: Type.String({
          enum: ["need_decision", "progress_update", "interview_request"],
          description: "Contact reason: 'need_decision' and 'interview_request' yield a live foreground child for a fresh follow-up; 'progress_update' sends a non-blocking update",
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
        if (reason === "progress_update" && typeof params.message !== "string") {
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
		const metadata = getMetadata();
		if (reason === "need_decision" && typeof params.message !== "string" && !metadata) {
			return {
				content: [{ type: "text", text: `Missing 'message' parameter for reason '${reason}'.` }],
				isError: true,
				details: { error: true },
			};
		}

		if (!metadata) {
			return {
				content: [{ type: "text", text: "Supervisor contact is unavailable for this session" }],
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
		const blockingSupervisorWait = reason !== "progress_update";
		if (blockingSupervisorWait && supervisorHandoffClaimed) {
			return {
				content: [{ type: "text", text: "Parent ask already claimed; this child is ending for a fresh subagent start." }],
				isError: true,
				details: { error: true },
			};
		}
		if (blockingSupervisorWait && supervisorWaitActive) {
			return {
				content: [{ type: "text", text: "Already waiting for a supervisor reply" }],
				isError: true,
				details: { error: true },
			};
		}
		if (blockingSupervisorWait) supervisorWaitActive = true;
		try {
			if (
				blockingSupervisorWait &&
				requestParentAskHandoff(pi.events, metadata, {
					kind: reason === "interview_request" ? "interview" : "decision",
					question: typeof params.message === "string" ? params.message : "",
					...(supervisorInterview ? { interview: supervisorInterview } : {}),
				})
			) {
				supervisorHandoffClaimed = true;
				return {
					content: [{ type: "text", text: "Parent ask claimed; this child is ending for a fresh subagent start." }],
					isError: false,
					details: { yielded: true },
				};
			}

			if (reason === "need_decision" && typeof params.message !== "string") {
				return {
					content: [{ type: "text", text: `Missing 'message' parameter for reason '${reason}'.` }],
					isError: true,
					details: { error: true },
				};
			}
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
        let sendTo: string;
        if (connectedClient.supervisorSessionId || metadata.supervisor) {
          sendTo = connectedClient.supervisorSessionId ?? metadata.supervisor!.supervisorSessionId;
        } else {
          try {
            sendTo = await resolveSessionTarget(connectedClient, metadata.orchestratorTarget) ?? metadata.orchestratorTarget;
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to resolve supervisor target: ${getErrorMessage(error)}` }],
              isError: true,
              details: { error: true },
            };
          }
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
            const result = await connectedClient.sendToSupervisor(sendTo, {
              text: formatChildOrchestratorMessage("update", metadata, message),
            });
            if (signal?.aborted) {
              return {
                content: [{ type: "text", text: "Cancelled" }],
                isError: true,
                details: { error: true },
              };
            }
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

        let wait: ReplyWait | null = null;
        try {
          const questionId = randomUUID();
          const admission = beginReplyWait(sendTo, questionId, signal);
          if (!admission.ok) {
			return {
				content: [{ type: "text", text: admission.reason === "busy" ? `Too many pending asks (${admission.limit}); reply-wait slots are full` : "Cancelled" }],
				isError: true,
				details: { error: true },
			};
          }
          wait = admission.wait;
          const requestText = reason === "interview_request"
            ? formatChildOrchestratorMessage("interview", metadata, formatSupervisorInterviewRequest(supervisorInterview!, typeof params.message === "string" ? params.message : undefined))
            : formatChildOrchestratorMessage("ask", metadata, params.message as string);
          const sendResult = await connectedClient.sendToSupervisor(sendTo, {
            messageId: questionId,
            text: requestText,
            expectsReply: true,
          });
          if (!sendResult.delivered) {
            const errorText = sendResult.reason ?? "Session may not exist or has disconnected.";
            wait.cancel(new Error(`Message to "${metadata.orchestratorTarget}" was not delivered: ${errorText}`));
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
          const replyMessage = await wait.promise;
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
            details: structuredReply
              ? structuredReply.value !== undefined
                ? { structuredReply: structuredReply.value }
                : { structuredReplyParseError: structuredReply.error }
              : {},
          };
        } catch (error) {
          // Settle only this call's own waiter; a concurrent call's
          // reservation must never be torn down from this failure path.
          wait?.cancel(toError(error));
          return {
            content: [{ type: "text", text: `Failed: ${getErrorMessage(error)}` }],
            isError: true,
            details: { error: true },
          };
        }
		} finally {
			if (blockingSupervisorWait && !supervisorHandoffClaimed) supervisorWaitActive = false;
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
