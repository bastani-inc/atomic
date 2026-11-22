import type { ExtensionAPI } from "@bastani/atomic";
import { randomUUID } from "crypto";
import { Type } from "@bastani/atomic-ai";
import type { IntercomClient } from "./broker/client.js";
import { ReleasedReplyHandoff, type ReplyWait, type ReplyWaitAdmission } from "./reply-waiter.ts";
import { prepareReleasedReplyWait, releasedReplyHandoffResult } from "./released-reply-wait.js";
import { appendEntryUnlessReleased, contactSupervisorCallMayDetach } from "./detachable-calls.js";
import { recordAnsweredQuestion } from "./outbound-asks.js";
import { requestParentAskHandoff } from "./parent-ask-handoff.js";
import { renderContactSupervisorCall, renderContactSupervisorResult } from "./result-renderers.js";
import {
  type ChildOrchestratorMetadata,
  type ContactSupervisorReason,
  formatChildOrchestratorMessagePayload,
  formatSupervisorInterviewPayload,
  formatAttachments,
  getErrorMessage,
  parseStructuredSupervisorReply,
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
	/** True only when this registration has confirmed that the broker routes locally. */
	mayDetachReplyWait?: () => boolean;
	/** True unless the broker is known to route across machines; a call may start before its connection exists. */
	mayAdmitReplyWait?: () => boolean;
	/**
	 * Register again with the supervisor capability the broker refused at this child's start: its supervisor may be
	 * back. One attempt; a refusal now leaves the child as it was.
	 */
	retrySupervisorAuthorization?: () => Promise<void>;
}

export function registerContactSupervisorTool(atomic: ExtensionAPI, deps: ContactSupervisorDeps): void {
	const { childOrchestratorMetadata, ensureConnected, syncPresenceIdentity, resolveSessionTarget, beginReplyWait } = deps;
  const getMetadata = typeof childOrchestratorMetadata === "function"
    ? childOrchestratorMetadata
    : () => childOrchestratorMetadata;
	// Supervisor decisions/interviews are exclusive (one blocking wait per child),
	// while ordinary peer asks may coexist under the shared registry cap.
	let supervisorWaitActive = false;
	let supervisorHandoffClaimed = false;
  if (childOrchestratorMetadata !== null) {
    atomic.registerTool({
      name: "contact_supervisor",
      exposure: "model-only",
      detachable: (params) => (deps.mayAdmitReplyWait ?? deps.mayDetachReplyWait)?.() === true && contactSupervisorCallMayDetach(params),
      detachmentRequiresReady: true,
      label: "Contact Supervisor",
      description: "Subagent-only tool for contacting the supervisor agent that delegated this task. need_decision and interview_request ask the supervisor over Intercom and wait for its reply, which this same child continues with; if the result instead ends the child with a fresh-subagent handoff, follow it. One blocking supervisor request is allowed per child and may coexist with ordinary intercom asks. progress_update is fire-and-forget. Do not use for routine completion handoffs.",
      promptSnippet: "Subagent-only: ask the supervisor for decisions or structured interviews and continue with its answers, or send meaningful plan-changing progress updates.",
      promptGuidelines: [
        "Use contact_supervisor with reason='need_decision' when a subagent is blocked, uncertain, needs approval, or faces a product/API/scope decision. The supervisor's reply comes back to this child; follow the actual tool result.",
        "Use contact_supervisor with reason='interview_request' when the child needs multiple structured answers. The answers come back to this child; follow the actual tool result.",
        "Use contact_supervisor with reason='progress_update' only for meaningful progress or unexpected discoveries that change the plan.",
        "Do not use contact_supervisor for routine completion handoffs; return the final subagent result normally.",
      ],
      parameters: Type.Object({
        reason: Type.String({
          enum: ["need_decision", "progress_update", "interview_request"],
          description: "Contact reason: 'need_decision' and 'interview_request' wait for the supervisor's reply; 'progress_update' sends a non-blocking update",
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
      async execute(toolCallId, params, signal, _onUpdate, ctx) {
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
				requestParentAskHandoff(atomic.events, metadata, {
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

			let connectedClient: IntercomClient;
		try {
			// A refused supervisor authorization is offered again first: its supervisor may be back since.
			if (metadata.supervisorRefusal !== undefined) await deps.retrySupervisorAuthorization?.().catch(() => undefined);
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

        // A child whose supervisor capability the broker kept refusing registered without it, so it has no supervisor
        // channel: the broker refuses the send, and the result says why the channel is missing. Never an ordinary send
        // instead, which would let a session holding no valid capability speak for the child.
        const unverified = metadata.supervisorRefusal !== undefined && !connectedClient.supervisorSessionId;
        const sendToSupervisor = (to: string, options: Parameters<IntercomClient["sendToSupervisor"]>[1]) =>
          connectedClient.sendToSupervisor(to, options);
        const unverifiedNote = unverified
          ? ` (the broker refused this subagent's supervisor authorization when it registered: ${metadata.supervisorRefusal}. It retries the authorization when it next connects to Intercom)`
          : "";
        if (reason === "progress_update") {
          const message = params.message as string;
          try {
            const payload = formatChildOrchestratorMessagePayload("update", metadata, message);
            const result = await sendToSupervisor(sendTo, {
              text: payload.text,
              displayRanges: payload.displayRanges,
            });
            // #4639: a supervisor without a live session that the broker queues for gets it when it is back.
            const queued = result.queued === true;
            if (!result.delivered && !queued) {
              const errorText = result.reason ?? "Session may not exist or has disconnected.";
              return {
                content: [{ type: "text", text: `Message to "${metadata.orchestratorTarget}" was not delivered: ${errorText}${unverifiedNote}` }],
                isError: true,
                details: { messageId: result.id, delivered: false, reason: result.reason },
              };
            }
            await atomic.appendEntry("intercom_sent", {
              to: metadata.orchestratorTarget,
              message: { text: message, reason },
              messageId: result.id,
              timestamp: Date.now(),
              subagent: { runId: metadata.runId, agent: metadata.agent, index: metadata.index },
            });
            return {
              content: [{
                type: "text",
                text: queued
                  ? `Progress update queued for supervisor ${metadata.orchestratorTarget}: it has no live session now and receives it when it is back`
                  : `Progress update sent to supervisor ${metadata.orchestratorTarget}${unverifiedNote}`,
              }],
              isError: false,
              details: queued ? { messageId: result.id, delivered: false, queued: true } : { messageId: result.id, delivered: true },
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
          const payload = reason === "interview_request"
            ? formatSupervisorInterviewPayload(metadata, supervisorInterview!, typeof params.message === "string" ? params.message : undefined)
            : formatChildOrchestratorMessagePayload("ask", metadata, typeof params.message === "string" ? params.message : "");
          const requestText = payload.text;
          const sendResult = await sendToSupervisor(sendTo, {
            messageId: questionId,
            text: requestText,
            displayRanges: payload.displayRanges,
            expectsReply: true,
          });
          // #4639: a question queued for a supervisor without a live session is asked when it is back; its reply ends
          // this wait as a delivered question's does.
          if (!sendResult.delivered && sendResult.queued !== true) {
            const errorText = `${sendResult.reason ?? "Session may not exist or has disconnected."}${unverifiedNote}`;
            wait.cancel(new Error(`Message to "${metadata.orchestratorTarget}" was not delivered: ${errorText}`));
            return {
              content: [{ type: "text", text: `Message to "${metadata.orchestratorTarget}" was not delivered: ${errorText}` }],
              isError: true,
              details: { error: true },
            };
          }
          await atomic.appendEntry("intercom_sent", {
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
          await prepareReleasedReplyWait(atomic, wait, signal, { toolCallId, questionId, from: sendTo, retryCount: 0 }, () => deps.mayDetachReplyWait?.() === true);
          const replyMessage = await wait.promise;
          // #5188: a failed ask is reported as a failure, never as the supervisor's reply or a parsed interview answer.
          if (replyMessage.replyError !== undefined)
            return {
              content: [{ type: "text", text: `Failed: ${replyMessage.replyError}` }],
              isError: true,
              details: { error: true, replyTo: replyMessage.replyTo },
            };
          const replyText = replyMessage.content.text;
          const replyAttachments = replyMessage.content.attachments?.length
            ? formatAttachments(replyMessage.content.attachments)
            : "";
          const structuredReply = reason === "interview_request" ? parseStructuredSupervisorReply(replyText, supervisorInterview!) : undefined;
          const receipt = await appendEntryUnlessReleased(atomic, "intercom_received", {
            from: metadata.orchestratorTarget,
            message: { text: replyText, attachments: replyMessage.content.attachments },
            messageId: replyMessage.id,
            timestamp: replyMessage.timestamp,
            subagent: { runId: metadata.runId, agent: metadata.agent, index: metadata.index },
          });
          // Once the reply is saved as taken, a reopened session keeps neither it nor the question's other records.
          if (receipt === "appended") await recordAnsweredQuestion(atomic, questionId);
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
          if (error instanceof ReleasedReplyHandoff) return releasedReplyHandoffResult();
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
      renderCall: renderContactSupervisorCall,
      renderResult: renderContactSupervisorResult,
    });
  }
}
