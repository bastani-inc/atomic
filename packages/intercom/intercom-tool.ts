import { randomUUID } from "node:crypto";
import {
  automaticWaitBudgetMs,
  type ExtensionAPI,
  type ExtensionContext,
  isIntercomRoutingError,
  isProjectGroupError,
  isRetryableIntercomRoutingError,
  sliceHead,
} from "@bastani/atomic";
import { Type } from "typebox";
import { type IntercomClient, sameReachPolicy, type SendOptions, type SendResult } from "./broker/client.js";
import type { Attachment, BrokerMultiNodeStatus, Message, SessionInfo, SessionDirectory } from "./types.js";
import { OutboundAsks } from "./outbound-asks.js";
import { HELD_FOR_AWAY_ASKER_TARGET, OFFLINE_SESSION_TARGET } from "./broker/held-reply-targets.js";
import {
  PAUSED_LIVE_RECIPIENT_TARGET,
  PAUSED_RECIPIENT_TARGET,
  RESUMING_RECIPIENT_TARGET,
} from "./broker/ended-child-wakes.js";
import { ASK_DESCRIPTION, ASK_PROMPT_SNIPPET, ASK_USAGE, askIdSchema, askWaitSchema, parseAskWait } from "./ask-wait.js";
import { PeerDisconnectedError } from "./peer-disconnect-routing.js";
import { describeMultiNodeStatus } from "./broker/broker-status.js";
import { appendEntryUnlessReleased, intercomCallMayDetach } from "./detachable-calls.js";
import { requestParentAskHandoff } from "./parent-ask-handoff.js";
import { ReleasedReplyHandoff, type ReplyWait, type ReplyWaitAdmission } from "./reply-waiter.ts";
import { prepareReleasedReplyWait, releasedReplyHandoffResult } from "./released-reply-wait.js";
import { renderIntercomCall, renderIntercomResult } from "./result-renderers.js";
import {
  type ChildOrchestratorMetadata,
  formatAttachments,
  formatSessionListRow,
  getErrorMessage,
  toError,
} from "./intercom-utils.js";
import type { IntercomContext, ReplyTracker } from "./reply-tracker.js";
import { awaitSubagentChildRestoration } from "./session-recovery.js";
import { closeInboundAsk, closeRefusedAsk } from "./finished-asks.js";
import { resolveSessionTarget, resolveSessionTargetId, resolveSessionTargetIdIn, sessionTargetFailureReason } from "./session-target.js";
import { createConcurrencyGate } from "./route-connect-gate.js";
import { DEFAULT_GROUP, normalizeGroup, normalizeGroups, RETURN_PATH_TOOL_NOTE, validateRuntimeGroup } from "./group.js";
import { DEFAULT_GROUP_WARNING } from "./project-group.js";
import { canJoin, canLeave, canPeek, type IntercomReachPolicy } from "./reach-policy.js";
import { isWorkflowTarget, workflowTargetFailure } from "./broker/legacy-workflow-frames.js";
import { isRecoverableIntercomDisconnect } from "./recoverable-disconnect.js";
import { RetryIdentityReservations, type RetryIdentityAttempt, RetryTokenError } from "./retry-identity.js";
import { runIntercomOperation, type IntercomAttemptResult } from "./tool-retry.js";
import { PendingSendTimeoutError } from "./broker/pending-send-registry.js";
import { intercomMessageSizeError } from "./message-size.js";
import { intercomScriptAccess, scriptSendOutcome, scriptSessionEntry } from "./codemode-access.js";
import {
  closeSessionNames,
  listIntercomChildren,
  matchSessionPattern,
  multipleMatchesRefusal,
  parseSendPatternTarget,
  type PatternRecipientOutcome,
  patternSendResult,
  type SendPatternTarget,
} from "./send-pattern-targets.js";

/** The most direct sends one pattern send runs at once; its other recipients wait their turn. */
const PATTERN_SEND_CONCURRENCY = 16;

/**
 * #5999: whether a `queued` answer names a subagent that ended: one being resumed for the message (`resuming subagent`),
 * or one paused that gets it when it is continued (`paused subagent`).
 */
function endedRecipientQueue(target: string | undefined): "resuming" | "paused" | undefined {
  if (target === RESUMING_RECIPIENT_TARGET) return "resuming";
  if (target === PAUSED_RECIPIENT_TARGET || target === PAUSED_LIVE_RECIPIENT_TARGET) return "paused";
  return undefined;
}

/**
 * #5999: what a send or ask to a subagent that had ended answers: the message is queued, and reaches it as its next
 * prompt once it is resumed, or, for one that was paused, once the session that launched it continues it. A reply, or a
 * failure, arrives later as a message.
 */
function resumingRecipientText(to: string, queue: "resuming" | "paused", ask: boolean, askId?: string): string {
  const what = ask ? "Ask" : "Message";
  const queued =
    queue === "resuming"
      ? `${what} queued for ${to}: it had finished, so the session that launched it is resuming it, and it gets this message as its next prompt.`
      : `${what} queued for ${to}: it is paused, so it is not resumed for this message; it gets it when the session that launched it continues it, after what it is continued with.`;
  return ask
    ? `${queued} This call does not wait: the reply arrives later as a message ("Reply to your ask ${askId} from ${to}"), or as a failed ask if the message cannot reach it.`
    : `${queued} If the message cannot reach it you are told it was not delivered.`;
}

function retryErrorDetails(retryToken: string | undefined): Record<string, unknown> {
	return retryToken === undefined ? { error: true } : { error: true, retryToken };
}

/**
 * The broker answered its health check but never answered this send, whose frame the client had already written, so
 * it may still queue or deliver the message. Reporting that as a failure invites a resend, which arrives as a second
 * message (#4177). A broker that misses its health check too is a recoverable disconnect, which the tool already
 * retries and reports as an unknown outcome.
 */
function sendOutcomeUnknown(error: unknown): boolean {
	return error instanceof PendingSendTimeoutError;
}

function retainRecoverableRetry(
	reservations: RetryIdentityReservations,
	attempt: RetryIdentityAttempt,
): { readonly retryToken?: string; readonly remainingRetries: number } {
	const retryToken = reservations.retainAfterRecoverableDisconnect(attempt);
	return {
		...(retryToken === undefined ? {} : { retryToken }),
		remainingRetries: reservations.remainingRetries(attempt),
	};
}

function retainInconclusiveRetry(
	reservations: RetryIdentityReservations,
	attempt: RetryIdentityAttempt,
): { readonly retryToken?: string; readonly remainingRetries: number } {
	const retryToken = reservations.retainAfterInconclusiveRetry(attempt);
	return {
		...(retryToken === undefined ? {} : { retryToken }),
		remainingRetries: reservations.remainingRetries(attempt),
	};
}

/** The broker's multi-node routing state for `status`, as one line; a failure to read it never fails `status`. */
async function multiNodeStatus(client: IntercomClient): Promise<{ line: string; multiNode?: BrokerMultiNodeStatus } | undefined> {
	if (typeof client.brokerStatus !== "function") return undefined;
	try {
		const report = await client.brokerStatus();
		if (report === undefined) {
			return { line: "unknown (the running broker predates status reporting; `atomic intercom restart` replaces it)" };
		}
		return { line: describeMultiNodeStatus(report.multiNode), multiNode: report.multiNode };
	} catch (error) {
		return { line: `unknown (${getErrorMessage(error)})` };
	}
}

async function listDirectory(client: IntercomClient, group?: string): Promise<SessionDirectory> {
	if (typeof client.listDirectory === "function") return client.listDirectory(group);
	return { sessions: await client.listSessions(group) };
}

/** #4751: the recipient of an ask as the asker sees it at delivery: idle or busy, and what it is doing if known. */
export interface AskRecipient {
  readonly name: string;
  readonly state: "idle" | "busy" | "unknown";
  readonly currentAction?: string;
}

/** The recipient's presence at delivery; a listing that fails or misses it leaves the state unknown. */
async function describeAskRecipient(client: IntercomClient, to: string, recipientId: string): Promise<AskRecipient> {
  let session: SessionInfo | undefined;
  try {
    const sessions = await client.listSessions();
    session = sessions.find((candidate) => candidate.id === recipientId) ??
      sessions.find((candidate) => candidate.name !== undefined && candidate.name.toLowerCase() === to.trim().toLowerCase());
  } catch {
    session = undefined;
  }
  const name = session?.name || to;
  const status = session?.status?.trim();
  if (status === undefined || status.length === 0) return { name, state: "unknown" };
  const activity = status.split(" · ")[0] ?? status;
  if (activity === "idle") return { name, state: "idle" };
  return { name, state: "busy", currentAction: activity.startsWith("tool:") ? `running ${activity.slice(5)}` : activity };
}

function askPendingText(askId: string, to: string, recipient: AskRecipient, stopped?: string): string {
  const state = recipient.state === "unknown"
    ? ""
    : recipient.state === "idle"
      ? " (idle)"
      : ` (busy${recipient.currentAction === undefined ? "" : `: ${recipient.currentAction}`})`;
  const prefix = stopped === undefined ? "" : `No reply yet; ${stopped}. `;
  return `${prefix}Ask ${askId} delivered to ${recipient.name || to}${state}. The ask stays pending: its reply will arrive later as a message starting "Reply to your ask ${askId} from ${recipient.name || to}". Continue with other work; cancel it with intercom({ action: "cancel", askId: "${askId}" }).`;
}

/** The same automatic yield bash uses for a command wait that names no budget; `undefined` waits until the reply. */
function automaticAskWaitBudgetMs(ctx: Pick<ExtensionContext, "getAgentTaskHost">): number | undefined {
  try {
    const host = ctx.getAgentTaskHost?.();
    if (host !== undefined) return host.commandWaitBudgetMs;
  } catch {
    // A context without a task owner uses the default owner policy.
  }
  return automaticWaitBudgetMs(undefined, true);
}

interface IntercomToolDeps {
  childOrchestratorMetadata?: ChildOrchestratorMetadata | null | (() => ChildOrchestratorMetadata | null);
  ensureConnected(reason: "tool"): Promise<IntercomClient>;
  syncPresenceIdentity(sessionId: string): void;
  resolveSessionTarget?(activeClient: IntercomClient, nameOrId: string): Promise<string | null>;
  homeGroup(): string;
  reachPolicy?(): IntercomReachPolicy | undefined;
  /** Whether the broker routes across machines, so `default` is shared with every teammate's sessions. */
  multiNodeRouting?(): boolean;
  /** Record the memberships after a `join`/`leave`; settles once they are saved with the session (#4079). */
  setJoinedGroups(groups: readonly string[]): void | Promise<void>;
  clearJoinedGroups(): void | Promise<void>;
  confirmSend: boolean;
  /** Atomically reserves one correlation-keyed reply waiter; `timeoutMs: null` waits without a deadline. */
  beginReplyWait(from: string, replyTo: string, signal?: AbortSignal, timeoutMs?: number | null): ReplyWaitAdmission;
  /** True only when this registration has confirmed that the broker routes locally. */
  mayDetachReplyWait?: () => boolean;
  /** True unless the broker is known to route across machines; a call may start before its connection exists. */
  mayAdmitReplyWait?: () => boolean;
  replyTracker: ReplyTracker | (() => ReplyTracker);
  /** #4751: the asks this session sent, whose replies arrive as messages. */
  outboundAsks?: OutboundAsks | (() => OutboundAsks);
  /** Stop waiting on an ask's reply (cancel), without failing it. */
  cancelReplyWait?(askId: string): void;
  /** Internal test seam for exercising retry pressure before public tool side effects. */
  retryIdentityMaxEntries?: number;
}

class ReachChangedRetryError extends Error {
  constructor() {
    super("This session's Intercom reach changed while this message's outcome was unknown, so it was not sent again. Check whether it arrived before sending it again.");
    this.name = "ReachChangedRetryError";
  }
}

function reachChangedRetryResult(error: ReachChangedRetryError): IntercomAttemptResult {
  return {
    content: [{ type: "text", text: error.message }],
    isError: true,
    details: { error: true, outcome: "unknown" },
  };
}

function toolReachRefusal(reach: IntercomReachPolicy, action: string, group: string | undefined): string | undefined {
	const requested = typeof group === "string" && group.trim().length > 0 ? group.trim() : undefined;
	if (requested === undefined) return undefined;
	const scope = `home group ${reach.home}; reachable groups: ${reach.reachable.join(", ") || "none"}`;
	if (action === "join" && !canJoin(reach, requested))
		return `Group "${requested}" is outside this session's Intercom reach (${scope}). It can join only those groups.`;
	if (action === "leave" && !canLeave(reach, requested))
		return `This session's home group "${reach.home}" can't be left.`;
	if ((action === "list" || action === "status") && !canPeek(reach, requested))
		return `Group "${requested}" is outside this session's Intercom reach (${scope}), so it cannot be listed.`;
	return undefined;
}

export function registerIntercomTool(pi: ExtensionAPI, deps: IntercomToolDeps): void {
  const retryIdentities = new RetryIdentityReservations({ maxEntries: deps.retryIdentityMaxEntries });
  const { childOrchestratorMetadata, ensureConnected, syncPresenceIdentity, beginReplyWait } = deps;
  const resolveTarget = deps.resolveSessionTarget ?? resolveSessionTargetId;
  const resolveRecipient = async (client: IntercomClient, target: string): Promise<string> =>
    (await resolveTarget(client, target)) ?? target;
  /**
   * Atomic 0.10.0 removed workflows. A send, ask or reply to a workflow stage target (`workflow:<rootRunId>/...`) gets
   * the answer a broker gives a name no session has, and never reaches a broker: one of 0.9.x would still deliver or
   * queue it for a stage.
   */
  const sendUnlessWorkflowTarget = (client: IntercomClient, to: string, options: SendOptions): Promise<SendResult> => {
    if (!isWorkflowTarget(to) && !isWorkflowTarget(options.logicalTarget ?? to)) return client.send(to, options);
    const reach = deps.reachPolicy?.();
    return Promise.resolve({
      id: options.messageId ?? randomUUID(),
      delivered: false,
      ...workflowTargetFailure({
        to,
        requirePendingReply: options.requirePendingReply === true,
        ...(options.expectedRecipientId === undefined ? {} : { expectedRecipientId: options.expectedRecipientId }),
        ...(reach === undefined ? {} : { reach }),
      }),
    });
  };
  const getMetadata = typeof childOrchestratorMetadata === "function"
    ? childOrchestratorMetadata
    : () => childOrchestratorMetadata ?? null;
  const activeReplyTracker = (): ReplyTracker =>
    typeof deps.replyTracker === "function" ? deps.replyTracker() : deps.replyTracker;
  const ownOutboundAsks = deps.outboundAsks === undefined
    ? new OutboundAsks({
        entries: () => [],
        append: (customType, data) => pi.appendEntry(customType, data),
        sessionId: () => null,
      })
    : undefined;
  const outboundAsks = (): OutboundAsks =>
    ownOutboundAsks ?? (typeof deps.outboundAsks === "function" ? deps.outboundAsks() : deps.outboundAsks!);
  const patternError = (text: string): IntercomAttemptResult => ({
    content: [{ type: "text", text }],
    isError: true,
    details: { error: true },
  });
  /**
   * #4752: send one message to every recipient a pattern names. Each recipient gets its own direct send, with that
   * send's retries, refusals and receipts; the result lists how each one fared. Every copy carries one `broadcastId`,
   * so a session that several of them reach shows the message once. Every recipient is resolved from the one session
   * list the lookup fetched, and at most `PATTERN_SEND_CONCURRENCY` sends run at once: a list per recipient made a
   * broadcast to hundreds of sessions time out most of its lookups and miss those recipients.
   */
  const sendToPatternTarget = async (
    target: string,
    pattern: SendPatternTarget,
    request: {
      readonly message: string | undefined;
      readonly replyTo: string | undefined;
      readonly toolSessionId: string;
      readonly attachments: Attachment[] | undefined;
      readonly broadcast: boolean;
      readonly signal: AbortSignal | undefined;
      readonly ctx: { readonly hasUI: boolean; readonly ui: { confirm(title: string, message: string): Promise<boolean> } };
      readonly sendOne: (recipient: string, sendTo: string, broadcastId: string) => Promise<IntercomAttemptResult>;
    },
  ): Promise<IntercomAttemptResult> => {
    if (!request.message) return patternError("Missing 'to' or 'message' parameter");
    if (pattern.kind === "invalid") return patternError(pattern.reason);
    if (request.replyTo) {
      return patternError(`replyTo answers one ask, so it needs one exact target; "${target}" is a pattern.`);
    }
    /** `sendTo` is the session the snapshot resolved; `refusal` says why the snapshot names no single session. */
    let recipients: Array<{ readonly target: string; readonly label: string; readonly sendTo?: string; readonly refusal?: string }> = [];
    let lookupFailure = "";
    // Connecting and finding the recipients retry recoverable disconnects as a direct send does; nothing is sent yet.
    const lookup = await runIntercomOperation(async () => {
      try {
        const client = await ensureConnected("tool");
        syncPresenceIdentity(request.toolSessionId);
        if (pattern.kind === "sessions") {
          const sessions = await client.listSessions();
          const matches = matchSessionPattern(sessions, pattern.pattern, client.sessionId);
          if (matches.length === 0) {
            const close = closeSessionNames(sessions, pattern.pattern, client.sessionId);
            return patternError(`No session visible in your groups matches "${pattern.pattern}". ${
              close.length === 0 ? "No other sessions are visible in your groups." : `Close names: ${close.join(", ")}.`
            }`);
          }
          recipients = matches.map((session) => ({
            target: session.id,
            label: session.name ? `${session.name} (${session.id})` : session.id,
            sendTo: session.id,
          }));
          // #5202: a name glob reaches several sessions only when the sender says it means to.
          if (recipients.length > 1 && !request.broadcast) {
            return patternError(multipleMatchesRefusal(pattern.pattern, recipients));
          }
        } else {
          const children = await listIntercomChildren(pi.events, request.toolSessionId, pattern.runId);
          if (children.length === 0) {
            return patternError(`This session has no running, released or paused subagents${
              pattern.runId === undefined ? "" : ` in run ${pattern.runId}`
            } to send to.`);
          }
          const sessions = await client.listSessions();
          recipients = children.map((child) => {
            const base = { target: child.childName, label: `${child.childName} (${child.childId})` };
            try {
              return { ...base, sendTo: resolveSessionTargetIdIn(sessions, client.supervisorSessionId, child.childName) ?? child.childName };
            } catch (error) {
              return { ...base, refusal: getErrorMessage(error) };
            }
          });
        }
        return { content: [], isError: false, details: {} };
      } catch (error) {
        const retryable = isRecoverableIntercomDisconnect(error) || isRetryableIntercomRoutingError(error);
        lookupFailure = getErrorMessage(error);
        return {
          content: [{ type: "text", text: `Failed to send: ${lookupFailure}` }],
          isError: true,
          details: { error: true, retryable },
        };
      }
    }, () => {}, request.signal);
    if (lookup.isError && lookup.details.terminal === true) {
      return patternError(`Could not find the recipients of "${target}"${lookupFailure ? `: ${lookupFailure}` : ""}. Nothing was sent.`);
    }
    if (lookup.isError) return lookup;
    if (deps.confirmSend && request.ctx.hasUI) {
      const names = recipients.map((recipient) => `- ${recipient.label}`).join("\n");
      const attachmentText = request.attachments?.length ? formatAttachments(request.attachments) : "";
      const confirmed = await request.ctx.ui.confirm("Send Message", `Send to "${target}":\n${names}\n\n${request.message}${attachmentText}`);
      if (!confirmed) return { content: [{ type: "text", text: "Message cancelled by user" }], isError: false, details: {} };
    }
    const broadcastId = randomUUID();
    const sends = createConcurrencyGate(PATTERN_SEND_CONCURRENCY);
    const outcomes = await Promise.all(recipients.map(async (recipient): Promise<PatternRecipientOutcome> => {
      if (recipient.sendTo === undefined) {
        return { target: recipient.target, label: recipient.label, outcome: "refused", reason: recipient.refusal ?? "Session not found" };
      }
      const sendTo = recipient.sendTo;
      const result = await sends.run(() => request.sendOne(recipient.target, sendTo, broadcastId));
      const messageId = typeof result.details.messageId === "string" ? result.details.messageId : undefined;
      const base = { target: recipient.target, label: recipient.label, ...(messageId === undefined ? {} : { messageId }) };
      if (!result.isError) return { ...base, outcome: result.details.queued === true ? "queued" : "delivered" };
      const reason = typeof result.details.reason === "string" ? result.details.reason : result.content.map(({ text }) => text).join("\n");
      return { ...base, outcome: result.details.outcome === "unknown" ? "unknown" : "refused", reason };
    }));
    return patternSendResult(target, outcomes);
  };
  pi.registerTool({
    name: "intercom",
    exposure: "model-only",
    scriptAccess: intercomScriptAccess,
    detachable: (params) => (deps.mayAdmitReplyWait ?? deps.mayDetachReplyWait)?.() === true && intercomCallMayDetach(params),
    detachmentRequiresReady: true,
    label: "Intercom",
    description: `Send a message to another local agent session running on this machine.
Use this to communicate findings, request help, or coordinate work with other sessions.

Sessions belong to an intercom group and can ONLY message sessions in the same group;
cross-group sends are rejected by the broker, ${RETURN_PATH_TOOL_NOTE}. Ungrouped sessions share the "default" group; with multi-node routing on, a project group (project:<owner>/<repo>).

For send, live session names, exact full session IDs, and unique 8-hex session UUID prefixes
remain supported. \`send\` also takes a name glob (\`subagent-worker-*\`, or \`*\` for every session
visible in your groups except you) and \`subagents:*\` (every running, released or paused subagent this
session launched) or \`subagents:<runId>/*\` (those of one run). Each recipient gets its own direct send,
and the result lists every recipient's outcome; a glob that matches no session is an error naming close
names. A name glob (\`*\` included) that matches more than one session needs \`broadcast: true\`; without it
the send is refused with the list of matches, so pick one. \`subagents:\` targets broadcast without it.
Patterns never reach outside your groups.
${ASK_DESCRIPTION}
Choose \`delivery\` per send/ask by urgency. The default "steer" arrives after the recipient's current
tool calls finish and never cancels its work. Use "interrupt" when it must stop now (an urgent correction
or a stop order); it cancels the current model call or tool call. Use "followUp" when the message can wait
until the recipient finishes (low priority, "after you're done"). An idle recipient starts a turn.
For send/ask/reply, Intercom retries recoverable disconnects internally up to three times with the same operation identity. Each new tool call is a new operation. If recovery ends with an unknown delivery outcome, do not repeat it automatically.

Usage:
  intercom({ action: "list" })                    → List sessions visible through your groups
  intercom({ action: "list", group: "name" })     → Read-only peek at one group's sessions
  intercom({ action: "groups" })                  → Discover every available group and your memberships
  intercom({ action: "join", group: "name" })     → Add a named group membership
  intercom({ action: "leave", group: "name" })    → Leave one named group
  intercom({ action: "leave" })                   → Return to your resolved home group
  intercom({ action: "send", to: "session-name", message: "..." })  → Send message (shared group only)
  intercom({ action: "send", to: "subagent-worker-*", message: "...", broadcast: true }) → Send to every matching session
  intercom({ action: "send", to: "subagents:*", message: "..." })   → Send to every subagent you launched
${ASK_USAGE}
  intercom({ action: "send", to: "session-name", message: "...", delivery: "interrupt" }) → Cancel the recipient's current work
  intercom({ action: "reply", message: "..." })                      → Reply to the active or exact pending ask
  intercom({ action: "pending" })                                      → List unresolved inbound asks and your pending asks
  intercom({ action: "status" })                  → Show connection status and all your groups

The "join" action is additive. "default" is the shared default group; "true" and
"auto" are reserved for subagent auto-groups. Ordinary delivery requires at least
one shared membership; contact_supervisor remains the only cross-group path.`,
    promptSnippet:
      `Use to coordinate with other local agent sessions that share an intercom group. ${ASK_PROMPT_SNIPPET} Send/ask/reply retry reconnects internally; do not automatically repeat an unknown delivery outcome.`,
    parameters: Type.Object({
      action: Type.String({
        description: "Action: 'list', 'groups', 'join', 'leave', 'send', 'ask', 'reply', 'pending', 'cancel', or 'status'",
      }),
      to: Type.Optional(Type.String({
        description: "Live session name, exact full session ID, or unique 8-hex session UUID prefix. Send also takes a session-name glob (`subagent-worker-*`, `*`) or `subagents:*` / `subagents:<runId>/*` for the subagents this session launched; ask needs one exact target (for 'send', 'ask', or targeted 'reply')",
      })),
      message: Type.Optional(Type.String({
        description: "Message to send (for 'send', 'ask', or 'reply' action)",
      })),
      broadcast: Type.Optional(Type.Boolean({
        description: "For 'send' to a session-name glob: true to reach every match. Without it, a glob that matches more than one session is refused with the list of matches. `subagents:` targets broadcast without it.",
      })),
      attachments: Type.Optional(Type.Array(Type.Object({
        type: Type.Union([Type.Literal("file"), Type.Literal("snippet"), Type.Literal("context")]),
        name: Type.String(),
        content: Type.String(),
        language: Type.Optional(Type.String()),
      }))),
      delivery: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("followUp"), Type.Literal("interrupt")], {
        description: "For 'send'/'ask'; choose per message by urgency. 'steer' (default): arrives after the recipient's current tool calls, never cancelling work. 'interrupt': the recipient must stop now (urgent correction, stop order); cancels its current model call or tool call. 'followUp': can wait until the recipient finishes (low priority, after you're done).",
      })),
      wait: Type.Optional(askWaitSchema),
      askId: Type.Optional(askIdSchema),
      replyTo: Type.Optional(Type.String({
        description: "Exact pending-ask message ID or unique 8-hex UUID prefix; disambiguates concurrent asks, including asks from one sender. With 'cancel', closes that ask sent to you without replying",
      })),
      group: Type.Optional(Type.String({
        description: "Group name for 'join' or optional targeted 'leave'; read-only group filter for 'list'/'status'. 'send'/'ask' use shared memberships.",
      })),
    }),

    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      if ("retryToken" in params) {
        return {
          content: [{ type: "text", text: "Intercom manages retries internally. Caller-supplied retry tokens are not supported; this call was not sent." }],
          isError: true,
          details: { error: true },
        };
      }
      const toolSessionId = ctx.sessionManager.getSessionId();
      const { action, to, message, replyTo, group } = params;
      const deliveryOption = params.delivery === undefined || params.delivery === "steer" ? {} : { delivery: params.delivery };
      const attachments = params.attachments?.map((attachment) => ({ ...attachment }));
      if ((action === "send" || action === "ask" || action === "reply") && typeof message === "string") {
        const sizeError = intercomMessageSizeError({ text: message, ...(attachments === undefined ? {} : { attachments }) });
        if (sizeError !== undefined) {
          return { content: [{ type: "text", text: sizeError }], isError: true, details: { error: true } };
        }
      }
      const writtenReach = new Map<string, IntercomReachPolicy | undefined>();
      const guardWrite = (messageId: string) => (reach: IntercomReachPolicy | undefined): void => {
        if (writtenReach.has(messageId) && !sameReachPolicy(writtenReach.get(messageId), reach)) {
          throw new ReachChangedRetryError();
        }
        writtenReach.set(messageId, reach === undefined ? undefined : { home: reach.home, reachable: [...reach.reachable] });
      };
      // A pattern send (#4752) runs this once per recipient, as a direct send to `fanOut.recipient`, which its lookup
      // already resolved to `fanOut.sendTo`.
      const executeAttempt = async (
        retryToken: string | undefined,
        _signal?: AbortSignal,
        retries = 0,
        fanOut?: { readonly recipient: string; readonly sendTo: string; readonly broadcastId: string },
      ): Promise<IntercomAttemptResult> => {
      const fanOutRecipient = fanOut?.recipient;
      const broadcastId = fanOut?.broadcastId;
      const to = fanOutRecipient ?? params.to;
      if (retryToken !== undefined) {
        if (action !== "send" && action !== "ask" && action !== "reply") {
          const error = new RetryTokenError("mismatch");
          return {
            content: [{ type: "text", text: getErrorMessage(error) }],
            isError: true,
            details: { error: true },
          };
        }
        try {
          retryIdentities.validateRetryToken(retryToken, toolSessionId, action);
        } catch (error) {
          return {
            content: [{ type: "text", text: getErrorMessage(error) }],
            isError: true,
            details: { error: true },
          };
        }
      }

      let connectedClient: IntercomClient;
      try {
        connectedClient = await ensureConnected("tool");
      } catch (error) {
        const retryable = isRecoverableIntercomDisconnect(error) || isRetryableIntercomRoutingError(error);
        const retainedToken = retryToken !== undefined && retryable ? retryToken : undefined;
        return {
          content: [{
            type: "text",
            text: `Intercom not connected: ${getErrorMessage(error)}`,
          }],
          isError: true,
          details: {
            ...retryErrorDetails(retainedToken),
            retryable,
            ...(isIntercomRoutingError(error) || isProjectGroupError(error) ? { code: error.code, hint: error.hint } : {}),
          },
        };
      }

      syncPresenceIdentity(toolSessionId);
      const resolveOwnGroups = (sessions?: readonly SessionInfo[]): string[] => {
        if (Array.isArray(connectedClient.groups)) {
          return connectedClient.groups.map((membership) => normalizeGroup(membership));
        }
        const self = sessions?.find((session) => session.id === connectedClient.sessionId);
        return [...normalizeGroups(self?.groups, self?.group)];
      };
      const isOnlyOwnGroup = (candidate: string | undefined, ownGroups: readonly string[]): boolean =>
        candidate !== undefined && ownGroups.length === 1 && ownGroups[0] === candidate;
      const requestedGroup = typeof group === "string" && group.trim() ? normalizeGroup(group) : undefined;
      if ((action === "send" || action === "ask") && requestedGroup) {
        const ownGroups = resolveOwnGroups();
        if (!ownGroups.includes(requestedGroup)) {
          return {
            content: [{ type: "text", text: `The 'group' parameter is read-only for 'list'/'status'. '${action}' is always locked to your groups (${ownGroups.join(", ")}); it cannot target group "${requestedGroup}".` }],
            isError: true,
            details: { error: true },
          };
        }
      }

      const reach = deps.reachPolicy?.();
      const reachRefusal = reach === undefined ? undefined : toolReachRefusal(reach, action, group);
      if (reachRefusal !== undefined) {
        return { content: [{ type: "text", text: reachRefusal }], isError: true, details: { error: true } };
      }

      switch (action) {
        case "join": {
          let targetGroup: string;
          try {
            targetGroup = validateRuntimeGroup(group);
          } catch (error) {
            return {
              content: [{ type: "text", text: getErrorMessage(error) }],
              isError: true,
              details: { error: true },
            };
          }
          try {
            const groups = await connectedClient.joinGroup(targetGroup);
            await deps.setJoinedGroups(groups);
            const warning = targetGroup === DEFAULT_GROUP && deps.multiNodeRouting?.() === true ? `\nWarning: ${DEFAULT_GROUP_WARNING}` : "";
            return {
              content: [{ type: "text", text: `Joined intercom group "${targetGroup}". Memberships: ${groups.join(", ")}.${warning}` }],
              isError: false,
              details: { group: targetGroup, groups },
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to join group: ${getErrorMessage(error)}` }],
              isError: true,
              details: { error: true },
            };
          }
        }

        case "leave": {
          let targetGroup: string | undefined;
          let homeGroup: string | undefined;
          try {
            targetGroup = typeof group === "string" && group.trim().length > 0
              ? validateRuntimeGroup(group)
              : undefined;
            if (targetGroup === undefined) homeGroup = validateRuntimeGroup(deps.homeGroup());
          } catch (error) {
            return {
              content: [{ type: "text", text: `Cannot leave intercom group: ${getErrorMessage(error)}` }],
              isError: true,
              details: { error: true },
            };
          }
          try {
            let groups: string[];
            if (targetGroup === undefined) {
              if (homeGroup === undefined) throw new Error("Intercom home group is unavailable");
              await connectedClient.updatePresenceAcked({ groups: [homeGroup] });
              groups = connectedClient.groups;
              await deps.clearJoinedGroups();
            } else {
              groups = await connectedClient.leaveGroup(targetGroup);
              await deps.setJoinedGroups(groups);
            }
            const text = targetGroup === undefined
              ? `Returned to home intercom membership. Memberships: ${groups.join(", ")}.`
              : `Left intercom group "${targetGroup}". Memberships: ${groups.join(", ")}.`;
            return {
              content: [{ type: "text", text }],
              isError: false,
              details: targetGroup === undefined ? { group: homeGroup, groups } : { groups },
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to leave group: ${getErrorMessage(error)}` }],
              isError: true,
              details: { error: true },
            };
          }
        }

        case "groups": {
          try {
            const groups = await connectedClient.listGroups();
            const lines = groups.map(({ group: groupName, sessionCount, member }) =>
              `- ${groupName} — ${sessionCount} session${sessionCount === 1 ? "" : "s"}${member ? " [member]" : ""}`
            );
            return {
              content: [{ type: "text", text: `**Intercom groups:**\n${lines.join("\n")}` }],
              isError: false,
              details: { groups },
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Failed to list groups: ${getErrorMessage(error)}` }],
              isError: true,
              details: { error: true },
            };
          }
        }

        case "list": {
          try {
            const mySessionId = connectedClient.sessionId;
            const ownDirectory = await listDirectory(connectedClient);
			const ownSessions = ownDirectory.sessions;
            const currentSession = ownSessions.find((session) => session.id === mySessionId);
            if (!currentSession) {
              return {
                content: [{ type: "text", text: "Current session is missing from intercom session list." }],
                isError: true,
                details: { error: true },
              };
            }
            const ownGroups = resolveOwnGroups(ownSessions);
            if (requestedGroup && !isOnlyOwnGroup(requestedGroup, ownGroups)) {
			  const peeked = await listDirectory(connectedClient, requestedGroup);
			  const rows = peeked.sessions.map((session) => formatSessionListRow(session, currentSession.cwd, session.id === mySessionId));
			  const heading = `**Group [${requestedGroup}] (read-only peek):**`;
			  const section = peeked.restricted === true
				? `${heading}\nGroup ${requestedGroup} is outside this session's Intercom reach, so its sessions are not listed.`
				: rows.length === 0
					? `${heading}\nNo sessions in this group.`
					: `${heading}\n${rows.join("\n")}`;
			  return {
				content: [{ type: "text", text: `Your groups: ${ownGroups.join(", ")}\n\n${section}` }],
				isError: false,
				structuredContent: {
					action: "list",
					groups: ownGroups,
					peekGroup: requestedGroup,
					sessions: peeked.sessions.map((session) => scriptSessionEntry(session, mySessionId)),
				},
				details: {
					group: ownGroups.at(-1),
					groups: ownGroups,
					peekGroup: requestedGroup,
					...(peeked.restricted === true ? { restricted: true } : {}),
				},
			  };
            }

			const otherSessions = ownSessions.filter((session) => session.id !== mySessionId);
			const reachSection = reach === undefined ? "" : `; reachable: ${reach.reachable.join(", ") || "none"}`;
			const currentSection = `**Current session** (groups: ${ownGroups.join(", ")}${reachSection}):\n${formatSessionListRow(currentSession, currentSession.cwd, true)}`;
			const visibleRows = otherSessions.map((session) => formatSessionListRow(session, currentSession.cwd, false));
			const otherSection = visibleRows.length === 0
				? "**Other sessions:**\nNo other sessions share any of your groups."
				: `**Other visible sessions:**\n${visibleRows.join("\n")}`;

            return {
              content: [{ type: "text", text: `${currentSection}\n\n${otherSection}` }],
              isError: false,
              structuredContent: {
                action: "list",
                groups: ownGroups,
                sessions: ownSessions.map((session) => scriptSessionEntry(session, mySessionId)),
              },
              details: {
				group: ownGroups.at(-1),
				groups: ownGroups,
			  },
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
            const errorText = retryToken === undefined
              ? "Missing 'to' or 'message' parameter"
              : getErrorMessage(new RetryTokenError("mismatch"));
            return {
              content: [{ type: "text", text: errorText }],
              isError: true,
              details: { error: true },
            };
          }
          if (_signal?.aborted) {
            return {
              content: [{
                type: "text",
                text: "Cancelled",
              }],
              isError: true,
              details: retryErrorDetails(retryToken),
            };
          }
          let retryIdentity: RetryIdentityAttempt | undefined;
          try {
            if (retryToken === undefined) {
              retryIdentity = retryIdentities.begin({
                sessionId: toolSessionId,
                action: "send",
                target: to,
                text: message,
                attachments,
                replyTo,
                expectsReply: false,
              });
            }
            if (retryToken === undefined && fanOutRecipient === undefined && !replyTo && deps.confirmSend && ctx.hasUI) {
              const attachmentText = attachments?.length ? formatAttachments(attachments) : "";
              const confirmed = await ctx.ui.confirm(
                "Send Message",
                `Send to "${to}":\n\n${message}${attachmentText}`,
              );
              if (!confirmed) {
                if (retryIdentity !== undefined) retryIdentities.release(retryIdentity);
                retryIdentity = undefined;
                return {
                  content: [{ type: "text", text: "Message cancelled by user" }],
                  isError: false,
                  details: {},
                };
              }
            }
            retryIdentity ??= retryIdentities.begin({
              sessionId: toolSessionId,
              action: "send",
              target: to,
              text: message,
              attachments,
              replyTo,
              expectsReply: false,
            }, retryToken);
            const goneChild = await awaitSubagentChildRestoration(pi.events, toolSessionId, to);
            if (goneChild !== undefined) {
              retryIdentities.release(retryIdentity);
              retryIdentity = undefined;
              return {
                content: [{ type: "text", text: goneChild }],
                isError: true,
                details: { error: true, delivered: false, reason: goneChild },
              };
            }
            const sendTo = fanOut?.sendTo ?? await resolveRecipient(connectedClient, to);
            if (_signal?.aborted) {
              const retained = retainInconclusiveRetry(retryIdentities, retryIdentity);
              retryIdentity = undefined;
              return {
                content: [{ type: "text", text: "Cancelled" }],
                isError: true,
                details: retryErrorDetails(retained.retryToken),
              };
            }
            if (sendTo === connectedClient.sessionId) {
              const retained = retainInconclusiveRetry(retryIdentities, retryIdentity);
              retryIdentity = undefined;
              return {
                content: [{
                  type: "text",
                  text: "Cannot message the current session",
                }],
                isError: true,
                details: retryErrorDetails(retained.retryToken),
              };
            }
            const result = await sendUnlessWorkflowTarget(connectedClient, sendTo, {
              messageId: retryIdentity.messageId,
              beforeWrite: guardWrite(retryIdentity.messageId),
              logicalTarget: to,
              text: message,
              attachments,
              replyTo,
              ...(broadcastId === undefined ? {} : { broadcastId }),
              // #5999: a subagent that ended but can be resumed is resumed for a message to it alone, never for a pattern.
              ...(fanOut === undefined ? { wakeEndedRecipient: true as const } : {}),
              ...deliveryOption,
            });

            if (result.queued === true) {
              retryIdentities.release(retryIdentity);
              retryIdentity = undefined;
              await pi.appendEntry("intercom_sent", {
                to,
                message: { text: message, attachments, replyTo },
                messageId: result.id,
                timestamp: Date.now(),
              });
              const endedQueue = endedRecipientQueue(result.target);
              return {
                content: [{
                  type: "text",
                  text: endedQueue === undefined ? `Message queued for ${to}` : resumingRecipientText(to, endedQueue, false),
                }],
                isError: false,
                details: {
                  messageId: result.id,
                  delivered: false,
                  queued: true,
                  target: result.target,
                  position: result.position,
                  ...(endedQueue === undefined ? {} : { [endedQueue]: true as const }),
                },
              };
            }
            if (!result.delivered) {
              const retained = retainInconclusiveRetry(retryIdentities, retryIdentity);
              retryIdentity = undefined;
              const errorText = result.reason ?? "Session may not exist or has disconnected.";
              return {
                content: [{
                  type: "text",
                  text: `Message to "${to}" was not delivered: ${errorText}`,
                }],
                isError: true,
                details: retryToken === undefined
                  ? { messageId: result.id, delivered: false, reason: result.reason }
                  : {
                      delivered: false,
                      reason: result.reason,
                      ...(retained.retryToken === undefined ? {} : { retryToken: retained.retryToken }),
                    },
              };
            }
            retryIdentities.release(retryIdentity);
            retryIdentity = undefined;
            await pi.appendEntry("intercom_sent", {
              to,
              message: { text: message, attachments, replyTo },
              messageId: result.id,
              timestamp: Date.now(),
            });
            if (replyTo) activeReplyTracker().markReplied(replyTo);
            return {
              content: [{ type: "text", text: `Message sent to ${to}` }],
              isError: false,
              details: { messageId: result.id, delivered: true },
            };
          } catch (error) {
            let failure = error;
            let retained: { readonly retryToken?: string; readonly remainingRetries: number } | undefined;
            if (retryIdentity !== undefined) {
              if (isRecoverableIntercomDisconnect(error)) {
                try {
                  retained = retainRecoverableRetry(retryIdentities, retryIdentity);
                } catch (retentionError) {
                  failure = retentionError;
                }
              } else {
                retryIdentities.release(retryIdentity);
              }
            }
            if (failure instanceof ReachChangedRetryError) return reachChangedRetryResult(failure);
            if (failure === error && sendOutcomeUnknown(error)) {
              return {
                content: [{
                  type: "text",
                  text: `The broker did not answer the send to "${to}" in time, so whether the message was queued or delivered is unknown: it may still arrive. Check with the recipient before sending it again, because a new send is a new message.`,
                }],
                isError: true,
                details: { error: true, outcome: "unknown" },
              };
            }
            return {
              content: [{
                type: "text",
                text: `Failed to send: ${getErrorMessage(failure)}`,
              }],
              isError: true,
              details: { ...retryErrorDetails(retained?.retryToken), retryable: isRecoverableIntercomDisconnect(error) },
            };
          }
        }

        case "ask": {
          if (!to) {
            const errorText = retryToken === undefined
              ? "Missing 'to' or 'message' parameter"
              : getErrorMessage(new RetryTokenError("mismatch"));
            return {
              content: [{ type: "text", text: errorText }],
              isError: true,
              details: { error: true },
            };
          }

          if (_signal?.aborted) {
            return {
              content: [{
                type: "text",
                text: "Cancelled",
              }],
              isError: true,
              details: retryErrorDetails(retryToken),
            };
          }
          const askWait = parseAskWait(params.wait);
          if (askWait instanceof Error) {
            return { content: [{ type: "text", text: askWait.message }], isError: true, details: { error: true } };
          }
          let wait: ReplyWait | null = null;
          let retryIdentity: RetryIdentityAttempt | undefined;
          let askDelivered = false;

          try {
            retryIdentity = retryIdentities.begin({
              sessionId: toolSessionId,
              action: "ask",
              target: to,
              text: message ?? "",
              attachments,
              replyTo,
              expectsReply: true,
            }, retryToken);
            const metadata = getMetadata();
            const currentSupervisorId = connectedClient.supervisorSessionId ?? undefined;
            const metadataSupervisorId = metadata?.supervisor?.supervisorSessionId;
            const directParentTarget = Boolean(
              metadata &&
              (to === metadata.orchestratorTarget ||
                to === currentSupervisorId ||
                to === metadataSupervisorId),
            );
            let parentTarget = directParentTarget;
            const claimParentAsk = (resolvedTargetId: string): boolean =>
              Boolean(
                metadata &&
                requestParentAskHandoff(pi.events, metadata, {
                  kind: "intercom",
                  question: typeof message === "string" ? message : "",
                  attachments: params.attachments,
                  resolvedTargetId,
                }),
              );
            if (
              retryToken === undefined &&
              directParentTarget &&
              claimParentAsk(currentSupervisorId ?? metadataSupervisorId ?? to)
            ) {
              retryIdentities.release(retryIdentity);
              retryIdentity = undefined;
              return {
                content: [{ type: "text", text: "Parent ask claimed; this child is ending for a fresh subagent start." }],
                isError: false,
                details: { yielded: true },
              };
            }

            const goneChild = await awaitSubagentChildRestoration(pi.events, toolSessionId, to);
            if (goneChild !== undefined) {
              retryIdentities.release(retryIdentity);
              retryIdentity = undefined;
              return {
                content: [{ type: "text", text: goneChild }],
                isError: true,
                details: { error: true, delivered: false, reason: goneChild },
              };
            }
            const sendTo = await resolveRecipient(connectedClient, to);
            if (_signal?.aborted) {
              const retained = retryIdentity === undefined
                ? undefined
                : retainInconclusiveRetry(retryIdentities, retryIdentity);
              retryIdentity = undefined;
              return {
                content: [{
                  type: "text",
                  text: "Cancelled",
                }],
                isError: true,
                details: retryErrorDetails(retained?.retryToken),
              };
            }
            if (sendTo === connectedClient.sessionId) {
              const retained = retryIdentity === undefined
                ? undefined
                : retainInconclusiveRetry(retryIdentities, retryIdentity);
              retryIdentity = undefined;
              return {
                content: [{
                  type: "text",
                  text: "Cannot message the current session",
                }],
                isError: true,
                details: retryErrorDetails(retained?.retryToken),
              };
            }
            if (metadata && !directParentTarget) {
              const authoritativeParent = [currentSupervisorId, metadataSupervisorId].find(
                (candidate) => candidate === sendTo,
              );
              const resolvedParent =
                authoritativeParent ?? await resolveTarget(connectedClient, metadata.orchestratorTarget);
              parentTarget = resolvedParent !== null && resolvedParent === sendTo;
              if (retryToken === undefined && parentTarget && claimParentAsk(sendTo)) {
                retryIdentities.release(retryIdentity);
                retryIdentity = undefined;
                return {
                  content: [{ type: "text", text: "Parent ask claimed; this child is ending for a fresh subagent start." }],
                  isError: false,
                  details: { yielded: true },
                };
              }
            }

            if (!message && !parentTarget) {
              retryIdentities.release(retryIdentity);
              retryIdentity = undefined;
              return {
                content: [{ type: "text", text: "Missing 'to' or 'message' parameter" }],
                isError: true,
                details: { error: true },
              };
            }

			const questionId = retryIdentity.messageId;
			let replyFrom = sendTo;
			const question = message ?? "";
			// #4751: the asker waits for the reply only within its wait budget; an omitted `wait` uses the same
			// automatic budget as bash, `background` yields at delivery, and `undefined` waits until the reply.
			const budgetMs = askWait?.kind === "background"
				? 0
				: askWait?.budgetMs !== undefined ? askWait.budgetMs : automaticAskWaitBudgetMs(ctx);
			outboundAsks().open({ askId: questionId, to, recipientId: replyFrom, question });
			if (budgetMs !== 0) {
				// The caller's own signal, not the retry operation's: a delivered ask's wait outlives retry recovery.
				const admission = beginReplyWait(replyFrom, questionId, signal, budgetMs ?? null);
				if (!admission.ok && admission.reason === "cancelled") {
					outboundAsks().forget(questionId);
					const retained = retainInconclusiveRetry(retryIdentities, retryIdentity);
					retryIdentity = undefined;
					return {
						content: [{ type: "text", text: "Cancelled" }],
						isError: true,
						details: retryErrorDetails(retained.retryToken),
					};
				}
				// With every reply-wait slot taken, the ask still goes out; its reply arrives as a message.
				if (admission.ok) wait = admission.wait;
			}
            const sendResult = await sendUnlessWorkflowTarget(connectedClient, sendTo, {
              messageId: questionId,
              beforeWrite: guardWrite(questionId),
              logicalTarget: to,
              text: question,
              attachments,
              replyTo,
              expectsReply: true,
              // #5999: a subagent that ended but can be resumed is resumed for the ask; its reply arrives as a message.
              wakeEndedRecipient: true,
              ...deliveryOption,
              // The broker names the recipient it authorized to answer, so its reply is matched to this ask: a target
              // the listing could not resolve (such as a peer's own session id, #3760), or a recipient that
              // reconnected under a new session id before confirming (#3761).
              onReplyTarget: (sender) => {
                replyFrom = sender;
                wait?.bindSender(sender);
              },
            });

            const endedQueue = sendResult.queued === true ? endedRecipientQueue(sendResult.target) : undefined;
            if (endedQueue !== undefined) {
              // #5999: the recipient is being resumed for this ask, or gets it when it is continued: the ask stays open,
              // and its reply arrives later as a message ("Reply to your ask ..."), or its failure as a failed ask.
              askDelivered = true;
              retryIdentities.release(retryIdentity);
              retryIdentity = undefined;
              wait?.cancel(new Error(`Ask queued for ${to}, which had ended`));
              wait = null;
              await outboundAsks().persist(questionId);
              await pi.appendEntry("intercom_sent", {
                to,
                message: { text: message, attachments, replyTo },
                messageId: sendResult.id,
                timestamp: Date.now(),
              });
              return {
                content: [{ type: "text", text: resumingRecipientText(to, endedQueue, true, questionId) }],
                isError: false,
                details: {
                  messageId: sendResult.id,
                  delivered: false,
                  queued: true,
                  [endedQueue]: true,
                  askId: questionId,
                  target: sendResult.target,
                  position: sendResult.position,
                },
              };
            }
            if (sendResult.queued === true) {
              outboundAsks().forget(questionId);
              retryIdentities.release(retryIdentity);
              retryIdentity = undefined;
              wait?.cancel(new Error(`Message queued for ${to}`));
              await pi.appendEntry("intercom_sent", {
                to,
                message: { text: message, attachments, replyTo },
                messageId: sendResult.id,
                timestamp: Date.now(),
              });
              return {
                content: [{ type: "text", text: `Message queued for ${to}` }],
                isError: false,
                details: {
                  messageId: sendResult.id,
                  delivered: false,
                  queued: true,
                  target: sendResult.target,
                  position: sendResult.position,
                },
              };
            }
            if (!sendResult.delivered) {
              outboundAsks().forget(questionId);
              const retained = retainInconclusiveRetry(retryIdentities, retryIdentity);
              retryIdentity = undefined;
              const errorText = sendResult.reason ?? "Session may not exist or has disconnected.";
              wait?.cancel(new Error(`Message to "${to}" was not delivered: ${errorText}`));
              return {
                content: [{
                  type: "text",
                  text: `Message to "${to}" was not delivered: ${errorText}`,
                }],
                isError: true,
                details: retryErrorDetails(retained.retryToken),
              };
            }
            askDelivered = true;
            retryIdentities.release(retryIdentity);
            retryIdentity = undefined;
            outboundAsks().open({ askId: questionId, to, recipientId: replyFrom, question });
            await pi.appendEntry("intercom_sent", {
              to,
              message: { text: message, attachments, replyTo },
              messageId: sendResult.id,
              timestamp: Date.now(),
            });
            await outboundAsks().persist(questionId);
            const recipient = await describeAskRecipient(connectedClient, to, replyFrom);
            const pendingResult = (stopped?: string) => ({
              content: [{
                type: "text" as const,
                text: askPendingText(questionId, to, recipient, stopped),
              }],
              isError: false,
              details: { askId: questionId, delivered: true, recipient, pending: true },
            });
            if (wait === null) return pendingResult();
            const activeWait: ReplyWait = wait;
            if (budgetMs !== undefined) {
              await prepareReleasedReplyWait(
                pi,
                activeWait,
                signal,
                { toolCallId, questionId, from: replyFrom, retryCount: retries },
                () => deps.mayDetachReplyWait?.() === true,
              );
            }
            let replyMessage: Message;
            try {
              replyMessage = await activeWait.promise;
            } catch (waitError) {
              if (waitError instanceof ReleasedReplyHandoff) throw waitError;
              if (waitError instanceof PeerDisconnectedError) {
                await outboundAsks().settle(questionId, "failed");
                return {
                  content: [{ type: "text", text: `Failed: ${getErrorMessage(waitError)}` }],
                  isError: true,
                  details: { error: true, askId: questionId },
                };
              }
              // The wait budget ended, the call was interrupted, or the connection dropped: the ask stays pending
              // and its reply arrives later as a message.
              return pendingResult(signal?.aborted === true ? "stopped waiting" : "the wait budget ended");
            }
            await outboundAsks().settle(questionId, replyMessage.replyError === undefined ? "answered" : "failed");
            const replyText = replyMessage.content.text;
            const replyAttachments = replyMessage.content.attachments?.length
              ? formatAttachments(replyMessage.content.attachments)
              : "";
            await appendEntryUnlessReleased(pi, "intercom_received", {
              from: to,
              message: { text: replyText, attachments: replyMessage.content.attachments },
              messageId: replyMessage.id,
              timestamp: replyMessage.timestamp,
            });
            if (replyMessage.replyError !== undefined) {
              return {
                content: [{ type: "text", text: `Failed: ${replyMessage.replyError}` }],
                isError: true,
                details: {
                  error: true,
                  askId: questionId,
                  replyTo: replyMessage.replyTo,
                  ...(replyMessage.retryLater === true ? { retryLater: true as const } : {}),
                },
              };
            }
            return {
              content: [{ type: "text", text: `**Reply from ${to}:**\n${replyText}${replyAttachments}` }],
              isError: false,
              details: { askId: questionId, delivered: true, recipient, replied: true },
            };
          } catch (error) {
            if (error instanceof ReleasedReplyHandoff) {
              if (retryIdentity !== undefined) retryIdentities.release(retryIdentity);
              return releasedReplyHandoffResult();
            }
            wait?.cancel(toError(error));
            if (!askDelivered && retryIdentity !== undefined) outboundAsks().forget(retryIdentity.messageId);
            let failure = error;
            let retained: { readonly retryToken?: string; readonly remainingRetries: number } | undefined;
            if (retryIdentity !== undefined) {
              if (isRecoverableIntercomDisconnect(error)) {
                try {
                  retained = retainRecoverableRetry(retryIdentities, retryIdentity);
                } catch (retentionError) {
                  failure = retentionError;
                }
              } else {
                retryIdentities.release(retryIdentity);
              }
            }
            if (failure instanceof ReachChangedRetryError) return reachChangedRetryResult(failure);
            return {
              content: [{
                type: "text",
                text: `Failed: ${getErrorMessage(failure)}`,
              }],
              isError: true,
              details: { ...retryErrorDetails(retained?.retryToken), retryable: isRecoverableIntercomDisconnect(error), deliveryUncertain: askDelivered },
            };
          }
        }

        case "reply": {
          if (!message) {
            const errorText = retryToken === undefined
              ? "Missing 'message' parameter"
              : getErrorMessage(new RetryTokenError("mismatch"));
            return {
              content: [{ type: "text", text: errorText }],
              isError: true,
              details: { error: true },
            };
          }

          if (_signal?.aborted) {
            return { content: [{ type: "text", text: "Cancelled" }], isError: true, details: retryErrorDetails(retryToken) };
          }
          let retryIdentity: RetryIdentityAttempt | undefined;
          try {
            retryIdentity = retryIdentities.begin({
              sessionId: toolSessionId,
              action: "reply",
              target: to,
              text: message,
              attachments,
              replyTo,
              expectsReply: false,
            }, retryToken);
            if (retryToken === undefined) {
              const target = activeReplyTracker().resolveReplyTarget({ to, replyTo });
              retryIdentities.bindReplyRoute(retryIdentity, {
                senderId: target.from.id,
                ...(target.from.name === undefined ? {} : { senderName: target.from.name }),
                messageId: target.message.id,
                expectsReply: target.message.expectsReply === true,
              });
            }
            const route = retryIdentities.replyRoute(retryIdentity);
            if (route === undefined) throw new RetryTokenError("invalid");
            let replySendTo = to ?? route.senderId;
            if (to !== undefined) {
              const listed = await connectedClient.listSessions();
              const replyCandidates: Array<Pick<SessionInfo, "id" | "name">> = listed.some(
                (session) => session.id === route.senderId,
              )
                ? listed
                : [
                    ...listed,
                    {
                      id: route.senderId,
                      ...(route.senderName === undefined ? {} : { name: route.senderName }),
                    },
                  ];
              const replyTarget = resolveSessionTarget(replyCandidates, to);
              if (replyTarget.kind !== "resolved" && replyTarget.kind !== "not_found") {
                throw new Error(sessionTargetFailureReason(to, replyTarget));
              }
              if (replyTarget.kind === "resolved" && replyTarget.session.id !== route.senderId) {
                throw new Error("Reply target cannot be resolved safely; use the exact sender ID");
              }
              if (replyTarget.kind === "resolved") {
                const trimmedTo = to.trim();
                const exactId = replyTarget.session.id === trimmedTo;
                const exactName =
                  replyTarget.session.name !== undefined &&
                  replyTarget.session.name.toLowerCase() === trimmedTo.toLowerCase();
                // Exact IDs and names must reach the broker unchanged so hidden
                // collisions can be refused. Genuine unique UUID prefixes still
                // canonicalize to the stored session ID.
                if (!exactId && !exactName) replySendTo = replyTarget.session.id;
              }
            }
            const replyLogicalTarget = to ?? route.senderId;
            const displayTarget = route.senderName || route.senderId;
            if (route.senderId === connectedClient.sessionId) {
              const retained = retainInconclusiveRetry(retryIdentities, retryIdentity);
              retryIdentity = undefined;
              return {
                content: [{
                  type: "text",
                  text: "Cannot message the current session",
                }],
                isError: true,
                details: retryErrorDetails(retained.retryToken),
              };
            }
            const replyMessageId = retryIdentity.messageId;
            const sendReply = (targetId: string) => sendUnlessWorkflowTarget(connectedClient, targetId, {
              messageId: replyMessageId,
              logicalTarget: replyLogicalTarget,
              ...(route.expectsReply ? { requirePendingReply: true as const } : {}),
              ...(to === undefined && replyTo === undefined ? {} : { expectedRecipientId: route.senderId }),
              text: message,
              attachments,
              replyTo: route.messageId,
            });
            let result = await sendReply(replySendTo);
            if (
              to === undefined &&
              replyTo === undefined &&
              result.delivered === false &&
              result.reasonCode === "session_not_found" &&
              route.senderName !== undefined
            ) {
              result = await sendReply(route.senderName);
            }
            if (result.queued === true) {
              retryIdentities.release(retryIdentity);
              retryIdentity = undefined;
              await pi.appendEntry("intercom_sent", {
                to: displayTarget,
                message: { text: message, attachments, replyTo: route.messageId },
                messageId: result.id,
                timestamp: Date.now(),
              });
              activeReplyTracker().markReplied(route.messageId);
              // #4751: a reply to an asker that is closed is held for it and delivered once it is back.
              const heldForAsker = result.target === HELD_FOR_AWAY_ASKER_TARGET || result.target === OFFLINE_SESSION_TARGET;
              return {
                content: [{
                  type: "text",
                  text: heldForAsker ? `Reply delivered (held for ${displayTarget} until it is back)` : `Reply queued for ${displayTarget}`,
                }],
                isError: false,
                details: {
                  messageId: result.id,
                  delivered: false,
                  queued: true,
                  replyTo: route.messageId,
                  target: result.target,
                  position: result.position,
                },
              };
            }
            if (!result.delivered) {
              const retained = retainInconclusiveRetry(retryIdentities, retryIdentity);
              retryIdentity = undefined;
              const errorText = result.reason ?? "Session may not exist or has disconnected.";
              // #4997, #5101: not a final refusal: the reply may be authorized once the ask's route is restored.
              const retryLater = result.reasonCode === "route_unavailable"
                ? { reasonCode: result.reasonCode, retryLater: true as const }
                : {};
              // #6168: an ask no reply can reach any more is closed, so it does not stay pending for good.
              const closed = route.expectsReply
                ? await closeRefusedAsk(pi, activeReplyTracker(), toolSessionId, route.messageId, result)
                : undefined;
              return {
                content: [{
                  type: "text",
                  text: `Reply to "${displayTarget}" was not delivered: ${errorText}${closed === undefined ? "" : `\n${closed}`}`,
                }],
                isError: true,
                details: retryToken === undefined
                  ? { messageId: result.id, delivered: false, reason: result.reason, ...retryLater, ...(closed === undefined ? {} : { askClosed: true }) }
                  : {
                      delivered: false,
                      reason: result.reason,
                      ...retryLater,
                      ...(closed === undefined ? {} : { askClosed: true }),
                      ...(retained.retryToken === undefined ? {} : { retryToken: retained.retryToken }),
                    },
              };
            }
            retryIdentities.release(retryIdentity);
            retryIdentity = undefined;
            await pi.appendEntry("intercom_sent", {
              to: displayTarget,
              message: { text: message, attachments, replyTo: route.messageId },
              messageId: result.id,
              timestamp: Date.now(),
            });
            activeReplyTracker().markReplied(route.messageId);
            return {
              content: [{ type: "text", text: `Reply sent to ${displayTarget}` }],
              isError: false,
              details: { messageId: result.id, delivered: true, replyTo: route.messageId },
            };
          } catch (error) {
            let failure = error;
            let retained: { readonly retryToken?: string; readonly remainingRetries: number } | undefined;
            if (retryIdentity !== undefined) {
              if (isRecoverableIntercomDisconnect(error)) {
                try {
                  retained = retainRecoverableRetry(retryIdentities, retryIdentity);
                } catch (retentionError) {
                  failure = retentionError;
                }
              } else {
                retryIdentities.release(retryIdentity);
              }
            }
            return {
              content: [{
                type: "text",
                text: `Failed to reply: ${getErrorMessage(failure)}`,
              }],
              isError: true,
              details: { ...retryErrorDetails(retained?.retryToken), retryable: isRecoverableIntercomDisconnect(error) },
            };
          }
        }

        case "pending": {
          const pendingAsks = activeReplyTracker().listPending();
          const outbound = outboundAsks().pending();
          const structuredContent = {
            action: "pending",
            inbound: pendingAsks.map(({ from, message, receivedAt }) => ({
              messageId: message.id,
              from: from.name || from.id,
              fromSessionId: from.id,
              receivedAt,
              text: message.content.text,
            })),
            outbound: outbound.map(({ askId, to, askedAt }) => ({ askId, to, askedAt })),
          };
          if (pendingAsks.length === 0 && outbound.length === 0) {
            return {
              content: [{ type: "text", text: "No unresolved inbound or outbound asks." }],
              isError: false,
              structuredContent,
              details: { outbound: [] },
            };
          }

          const now = Date.now();
          const elapsed = (since: number) => `${Math.max(0, Math.floor((now - since) / 1000))}s ago`;
          const sections: string[] = [];
          if (pendingAsks.length > 0) {
            const lines = pendingAsks.map(({ from, message, receivedAt }) => {
              const preview = sliceHead(message.content.text.replace(/\s+/g, " "), 80);
              return `- ${from.name || from.id} · ${message.id} · ${elapsed(receivedAt)} · ${preview}`;
            });
            sections.push(`**Pending asks:**\n${lines.join("\n")}`);
          }
          if (outbound.length > 0) {
            const lines = outbound.map(({ askId, to, question, askedAt }) =>
              `- ${askId} → ${to} · ${elapsed(askedAt)} · ${sliceHead(question.replace(/\s+/g, " "), 80)}`
            );
            sections.push(`**Your asks awaiting a reply:**\n${lines.join("\n")}`);
          }
          return {
            content: [{ type: "text", text: sections.join("\n\n") }],
            isError: false,
            structuredContent,
            details: { outbound: outbound.map(({ askId, to, askedAt }) => ({ askId, to, askedAt })) },
          };
        }

        case "cancel": {
          const requested = typeof params.askId === "string" ? params.askId.trim() : "";
          const closing = typeof replyTo === "string" ? replyTo.trim() : "";
          if (!requested && closing) {
            // #6168: close an ask this session was sent, without replying; nothing is sent to its sender.
            let context: IntercomContext;
            try {
              context = activeReplyTracker().resolveReplyTarget({ replyTo: closing });
            } catch (error) {
              return { content: [{ type: "text", text: getErrorMessage(error) }], isError: true, details: { error: true } };
            }
            if (context.message.expectsReply !== true || !activeReplyTracker().listPending().includes(context)) {
              return {
                content: [{ type: "text", text: `No pending ask "${closing}" sent to you` }],
                isError: true,
                details: { error: true },
              };
            }
            const sender = context.from.name || context.from.id;
            if (!(await closeInboundAsk(pi, activeReplyTracker(), context.message.id, "closed"))) {
              return {
                content: [{ type: "text", text: `Ask ${context.message.id} from ${sender} was not closed: its close could not be saved to the session. It is still pending; try again.` }],
                isError: true,
                details: { error: true, replyTo: context.message.id },
              };
            }
            return {
              content: [{
                type: "text",
                text: `Closed ask ${context.message.id} from ${sender} without replying; nothing was sent to ${sender}.`,
              }],
              isError: false,
              details: { replyTo: context.message.id, closed: true },
            };
          }
          if (!requested) {
            return {
              content: [{ type: "text", text: "Missing 'askId' (one of your asks) or 'replyTo' (an ask sent to you)" }],
              isError: true,
              details: { error: true },
            };
          }
          const matches = outboundAsks().pending().filter(({ askId }) => askId === requested || askId.startsWith(requested));
          const exact = matches.find(({ askId }) => askId === requested);
          const target = exact ?? (matches.length === 1 ? matches[0] : undefined);
          if (target === undefined) {
            const text = matches.length > 1
              ? `"${requested}" matches several pending asks; use the full ask id`
              : `No pending ask "${requested}"`;
            return { content: [{ type: "text", text }], isError: true, details: { error: true } };
          }
          deps.cancelReplyWait?.(target.askId);
          await outboundAsks().settle(target.askId, "cancelled");
          return {
            content: [{ type: "text", text: `Cancelled ask ${target.askId} to ${target.to}. A reply that still arrives is shown once, marked late.` }],
            isError: false,
            details: { askId: target.askId, cancelled: true },
          };
        }

        case "status": {
          try {
            const mySessionId = connectedClient.sessionId;
            const sessions = await connectedClient.listSessions();
            const ownGroups = resolveOwnGroups(sessions);
            const selectedGroup = isOnlyOwnGroup(requestedGroup, ownGroups) ? undefined : requestedGroup;
            const selectedGroupSessions = selectedGroup === undefined
              ? undefined
              : await connectedClient.listSessions(selectedGroup);
            const selectedSection = selectedGroupSessions === undefined
              ? ""
              : `\nSelected group [${selectedGroup}]: ${selectedGroupSessions.length} session(s)`;
            const multiNode = await multiNodeStatus(connectedClient);
            const multiNodeSection = multiNode === undefined ? "" : `\nMulti-node routing: ${multiNode.line}`;
            return {
              content: [{
                type: "text",
                text: `**Intercom Status:**\nConnected: Yes\nSession ID: ${mySessionId}\nGroups: ${ownGroups.join(", ")}${reach === undefined ? "" : `\nReachable groups: ${reach.reachable.join(", ") || "none"}`}\nActive visible sessions: ${sessions.length}${selectedSection}${multiNodeSection}\nYour asks awaiting a reply: ${outboundAsks().pending().length}`,
              }],
              isError: false,
              structuredContent: {
                action: "status",
                sessionId: mySessionId ?? "",
                groups: ownGroups,
                sessions: (selectedGroupSessions ?? sessions).map((session) => scriptSessionEntry(session, mySessionId)),
                outboundAsks: outboundAsks().pending().length,
              },
              details: {
                group: ownGroups.at(-1),
                groups: ownGroups,
                ...(selectedGroup === undefined
                  ? {}
                  : { selectedGroup, selectedGroupSessionCount: selectedGroupSessions?.length ?? 0 }),
                ...(multiNode?.multiNode === undefined ? {} : { multiNode: multiNode.multiNode }),
              },
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
      };
      const sendPattern = (action === "send" || action === "ask") && typeof to === "string" ? parseSendPatternTarget(to) : undefined;
      if (sendPattern !== undefined && action === "ask") {
        return {
          content: [{ type: "text", text: `ask needs one exact target, and "${to}" is a pattern: a reply to a broadcast question would be ambiguous. Use send to reach every match, or ask each recipient by its exact name.` }],
          isError: true,
          details: { error: true },
        };
      }
      if (sendPattern !== undefined && typeof to === "string") {
        return sendToPatternTarget(to, sendPattern, {
          message,
          replyTo,
          toolSessionId,
          attachments,
          broadcast: params.broadcast === true,
          signal,
          ctx,
          sendOne: (recipient, sendTo, broadcastId) =>
            runIntercomOperation(
              (token, attemptSignal, retries) => executeAttempt(token, attemptSignal, retries, { recipient, sendTo, broadcastId }),
              (token) => retryIdentities.discard(token),
              signal,
            ),
        });
      }
      if (action !== "send" && action !== "ask" && action !== "reply") return executeAttempt(undefined, signal);
      const result = await runIntercomOperation(executeAttempt, (token) => retryIdentities.discard(token), signal);
      return action === "send" && typeof to === "string" ? { ...result, structuredContent: scriptSendOutcome(to, result) } : result;
    },
    renderCall: renderIntercomCall,
    renderResult: renderIntercomResult,
  });
}
