import {
  automaticWaitBudgetMs,
  type ExtensionAPI,
  type ExtensionContext,
  isIntercomRoutingError,
  isProjectGroupError,
  isRetryableIntercomRoutingError,
} from "@bastani/atomic";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { IntercomClient, SendResult } from "./broker/client.js";
import type { Attachment, BrokerMultiNodeStatus, Message, SessionInfo, SessionDirectory, WorkflowStageRosterEntry, WorkflowFutureStageRosterEntry } from "./types.js";
import { OutboundAsks } from "./outbound-asks.js";
import { ASK_DESCRIPTION, ASK_PROMPT_SNIPPET, ASK_USAGE, askIdSchema, askWaitSchema, parseAskWait } from "./ask-wait.js";
import { PeerDisconnectedError } from "./peer-disconnect-routing.js";
import { describeMultiNodeStatus } from "./broker/broker-status.js";
import { appendEntryUnlessReleased, intercomCallMayDetach } from "./detachable-calls.js";
import { requestParentAskHandoff } from "./parent-ask-handoff.js";
import { ReleasedReplyHandoff, type ReplyWait, type ReplyWaitAdmission } from "./reply-waiter.ts";
import { prepareReleasedReplyWait, releasedReplyHandoffResult } from "./released-reply-wait.js";
import { renderIntercomResult } from "./result-renderers.js";
import {
  type ChildOrchestratorMetadata,
  formatAttachments,
  formatSessionListRow,
  getErrorMessage,
  previewText,
  toError,
} from "./intercom-utils.js";
import type { ReplyTracker } from "./reply-tracker.js";
import { awaitSubagentChildRestoration } from "./session-recovery.js";
import { resolveSessionTarget, resolveSessionTargetId, sessionTargetFailureReason } from "./session-target.js";
import { DEFAULT_GROUP, normalizeGroup, normalizeGroups, validateRuntimeGroup } from "./group.js";
import { DEFAULT_GROUP_WARNING } from "./project-group.js";
import { parseWorkflowStageTarget, withWorkflowStageTargetFinalSegment } from "./workflow-stage-target.js";
import { isRecoverableIntercomDisconnect } from "./recoverable-disconnect.js";
import { RetryIdentityReservations, type RetryIdentityAttempt, RetryTokenError } from "./retry-identity.js";
import { runIntercomOperation, type IntercomAttemptResult } from "./tool-retry.js";
import { PendingSendTimeoutError } from "./broker/pending-send-registry.js";
import {
  closeSessionNames,
  listIntercomChildren,
  matchSessionPattern,
  parseSendPatternTarget,
  type PatternRecipientOutcome,
  patternSendResult,
  type SendPatternTarget,
} from "./send-pattern-targets.js";

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
	return { sessions: await client.listSessions(group), workflowStages: [], workflowFutureStages: [] };
}

type ReplySenderResolution =
	| { readonly kind: "resolved"; readonly sessionId: string }
	| { readonly kind: "unresolved" }
	| { readonly kind: "ambiguous"; readonly reason: string };

/**
 * Map a canonical workflow-stage target to the live session id its reply will arrive
 * from. `unresolved` keeps today's behavior of keying the waiter on the send target
 * (ordinary miss handling); `ambiguous` must refuse the ask — keying on the raw path
 * string is the #2784 hang-to-timeout class because inbound reply routing only ever
 * produces the stage session's id or name.
 */
async function resolveReplySender(
	client: IntercomClient,
	logicalTarget: string,
	sendTarget: string,
): Promise<ReplySenderResolution> {
	if (logicalTarget !== sendTarget) return { kind: "unresolved" };
	// Only a canonical workflow path needs the roster lookup that maps it to the
	// stage's live session id. Ordinary name/id asks stay off this directory round-trip.
	const parsedTarget = parseWorkflowStageTarget(logicalTarget);
	if (parsedTarget?.kind !== "path") return { kind: "unresolved" };
	// The roster publishes the depth-faithful id form; live routing also registers the name
	// form (final segment swapped). Sibling stages can share a boundary name, so more than
	// one alias may match — that is an ambiguous target, not a first-match wins.
	const stages = (await listDirectory(client)).workflowStages;
	const aliasMatches = stages.filter(
		(candidate) =>
			candidate.sessionId !== undefined &&
			(candidate.target === logicalTarget ||
				withWorkflowStageTargetFinalSegment(candidate.target, candidate.stageName) === logicalTarget),
	);
	const aliasSessionIds = new Set(aliasMatches.map((candidate) => candidate.sessionId));
	if (aliasSessionIds.size > 1) {
		return {
			kind: "ambiguous",
			reason: `multiple live workflow stages share the target "${logicalTarget}"`,
		};
	}
	if (aliasSessionIds.size === 1) {
		const [onlySessionId] = aliasSessionIds;
		if (onlySessionId !== undefined) return { kind: "resolved", sessionId: onlySessionId };
	}
	// Boundary forms (`workflow:<root>/<boundary...>/<stage>`) match neither alias. Start from
	// every live nested candidate under the same invocation root whose final segment matches,
	// then narrow to candidates whose boundary segments agree with the target's (the candidate
	// target's segment at that depth, or the owning run id at the candidate's own depth).
	const finalSegment = parsedTarget.segments.at(-1);
	const middleSegments = parsedTarget.segments.slice(0, -1);
	const boundaryAgrees = (candidate: WorkflowStageRosterEntry): boolean => {
		const parsedCandidate = parseWorkflowStageTarget(candidate.target);
		if (
			parsedCandidate === undefined ||
			parsedCandidate.rootRunId !== parsedTarget.rootRunId ||
			parsedCandidate.segments.length < 2
		) {
			return false;
		}
		if (middleSegments.length === 0) return true;
		const candidateMiddles = parsedCandidate.segments.slice(0, -1);
		return middleSegments.every((segment, index) => {
			const owningRunIdentity = index === candidateMiddles.length - 1 ? candidate.runId : undefined;
			return segment === candidateMiddles[index] || segment === owningRunIdentity;
		});
	};
	const looseCandidates = stages.filter((candidate) => {
		if (candidate.sessionId === undefined) return false;
		if (candidate.stageId !== finalSegment && candidate.stageName !== finalSegment) return false;
		const parsedCandidate = parseWorkflowStageTarget(candidate.target);
		return (
			parsedCandidate !== undefined &&
			parsedCandidate.rootRunId === parsedTarget.rootRunId &&
			parsedCandidate.segments.length >= 2
		);
	});
	const strictMatches = looseCandidates.filter(boundaryAgrees);
	const strictSessionIds = new Set(strictMatches.map((candidate) => candidate.sessionId));
	if (strictSessionIds.size === 1) {
		const [onlySessionId] = strictSessionIds;
		if (onlySessionId !== undefined) return { kind: "resolved", sessionId: onlySessionId };
	}
	// Never key a waiter on the raw path when the final segment names several live stages:
	// inbound reply routing could never correlate it, so the ask would block to its timeout.
	const looseSessionIds = new Set(looseCandidates.map((candidate) => candidate.sessionId));
	if (looseSessionIds.size > 1 || strictSessionIds.size > 1) {
		return {
			kind: "ambiguous",
			reason: `multiple live workflow stages share the final segment "${finalSegment}" under different boundaries`,
		};
	}
	if (looseSessionIds.size === 1) {
		const [onlySessionId] = looseSessionIds;
		if (onlySessionId !== undefined) return { kind: "resolved", sessionId: onlySessionId };
	}
	return { kind: "unresolved" };
}

function formatWorkflowStageRow(stage: WorkflowStageRosterEntry): string {
	return `- \`${stage.target}\` [${stage.lifecycle.toUpperCase()}] workflow stage: ${stage.stageName}${
		stage.sessionId === undefined ? "" : ` session: \`${stage.sessionId}\``
	}`;
}

/**
 * A queued send's result text. A workflow target the decision model judged unlikely gets one line naming the closest
 * known stage; a target outside the known set gets the longer note only when `intercom.showUnknownTargetWarnings` is on.
 */
export function queuedSendText(
  to: string,
  result: Pick<SendResult, "prediction" | "unexpected" | "suggestion">,
  showUnknownTargetWarnings: boolean,
): string {
  const queued = `Message queued for ${to}`;
  if (result.unexpected === true) {
    const stagePath = parseWorkflowStageTarget(to)?.segments.join("/") ?? to;
    const suggestion = result.suggestion === undefined ? "." : `; did you mean ${result.suggestion}?`;
    return `${queued}\nNo stage named ${stagePath} is expected${suggestion}`;
  }
  if (showUnknownTargetWarnings && result.prediction === "unknown") {
    return `${queued} (not in the workflow's known stage set; it will be delivered to every matching stage that starts before the run terminates)`;
  }
  return queued;
}

/** D7 (slice 4): one possible-future row from the run's persisted scan (or the `**` broadcast row). */
function formatWorkflowFutureStageRow(stage: WorkflowFutureStageRosterEntry): string {
	return `- \`${stage.target}\` [${stage.deliveryOnly === true ? "delivery" : "future"}${formatPredictionLabel(stage)}] ${stage.queuedCount} queued message${
		stage.queuedCount === 1 ? "" : "s"
	}${(stage.deliveryStates ?? []).map((delivery) => `\n  delivery ${delivery.messageId} stage ${delivery.runId}/${delivery.stageId}${delivery.sessionId === undefined ? "" : ` session ${delivery.sessionId}`} ${delivery.state} — ${delivery.reason}`).join("")}${formatDeliveryStateSummary(stage)}`;
}

/** `, predicted 0.92`, `, confirmed` or `, unused` on rows the decision model predicted. */
function formatPredictionLabel(stage: WorkflowFutureStageRosterEntry): string {
	if (stage.prediction === undefined) return "";
	return stage.prediction === "predicted" && stage.probability !== undefined
		? `, predicted ${stage.probability.toFixed(2)}`
		: `, ${stage.prediction}`;
}

/** Per-state totals of a row whose delivery states were bounded, and how many the row omits. */
function formatDeliveryStateSummary(stage: WorkflowFutureStageRosterEntry): string {
	const omitted = stage.omittedDeliveryStates ?? 0;
	if (omitted === 0 || stage.deliveryStateCounts === undefined) return "";
	const counts = Object.entries(stage.deliveryStateCounts)
		.map(([state, count]) => `${count} ${state}`)
		.join(", ");
	return `\n  … ${omitted} more delivery state${omitted === 1 ? "" : "s"} omitted (all: ${counts})`;
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

export function registerIntercomTool(pi: ExtensionAPI, deps: IntercomToolDeps): void {
  const retryIdentities = new RetryIdentityReservations({ maxEntries: deps.retryIdentityMaxEntries });
  const { childOrchestratorMetadata, ensureConnected, syncPresenceIdentity, beginReplyWait } = deps;
  const resolveTarget = deps.resolveSessionTarget ?? resolveSessionTargetId;
  const resolveRecipient = async (client: IntercomClient, target: string): Promise<string> =>
    parseWorkflowStageTarget(target) === undefined ? (await resolveTarget(client, target)) ?? target : target;
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
   * send's retries, refusals and receipts; the result lists how each one fared.
   */
  const sendToPatternTarget = async (
    target: string,
    pattern: SendPatternTarget,
    request: {
      readonly message: string | undefined;
      readonly replyTo: string | undefined;
      readonly toolSessionId: string;
      readonly attachments: Attachment[] | undefined;
      readonly signal: AbortSignal | undefined;
      readonly ctx: { readonly hasUI: boolean; readonly ui: { confirm(title: string, message: string): Promise<boolean> } };
      readonly sendOne: (recipient: string) => Promise<IntercomAttemptResult>;
    },
  ): Promise<IntercomAttemptResult> => {
    if (!request.message) return patternError("Missing 'to' or 'message' parameter");
    if (pattern.kind === "invalid") return patternError(pattern.reason);
    if (request.replyTo) {
      return patternError(`replyTo answers one ask, so it needs one exact target; "${target}" is a pattern.`);
    }
    let recipients: Array<{ readonly target: string; readonly label: string }> = [];
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
          }));
        } else {
          const children = await listIntercomChildren(pi.events, request.toolSessionId, pattern.runId);
          if (children.length === 0) {
            return patternError(`This session has no running, released or paused subagents${
              pattern.runId === undefined ? "" : ` in run ${pattern.runId}`
            } to send to.`);
          }
          recipients = children.map((child) => ({ target: child.childName, label: `${child.childName} (${child.childId})` }));
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
    const outcomes = await Promise.all(recipients.map(async (recipient): Promise<PatternRecipientOutcome> => {
      const result = await request.sendOne(recipient.target);
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
    detachable: (params) => (deps.mayAdmitReplyWait ?? deps.mayDetachReplyWait)?.() === true && intercomCallMayDetach(params),
    detachmentRequiresReady: true,
    label: "Intercom",
    description: `Send a message to another local agent session running on this machine.
Use this to communicate findings, request help, or coordinate work with other sessions.

Sessions belong to an intercom group and can ONLY message sessions in the same group;
cross-group sends are rejected by the broker. Ungrouped sessions share the "default" group; with multi-node routing on, a project group (project:<owner>/<repo>).

For send, live session names, exact full session IDs, and unique 8-hex session UUID prefixes
remain supported. \`send\` also takes a name glob (\`subagent-worker-*\`, or \`*\` for every session
visible in your groups except you) and \`subagents:*\` (every running, released or paused subagent this
session launched) or \`subagents:<runId>/*\` (those of one run). Each recipient gets its own direct send,
and the result lists every recipient's outcome; a glob that matches no session is an error naming close
names. Patterns never reach outside your groups. Workflow-stage targets use
\`workflow:<rootRunId>/<segment>[/<segment>...]\`; a segment may be a stage name, run id, or glob
(\`*\` matches one segment and may be embedded, while \`**\` matches any depth). Use \`intercom list\`
inside the invocation group to see live, pending, and possible future targets with queued counts.
\`workflow:<rootRunId>/**\` reaches every live stage immediately and remains sticky for every future
stage until the root run terminates; narrower name or pattern sends likewise reach every future match.
A valid target outside the known set still queues and settles undeliverable at terminal only if never
delivered; the result carries \`prediction\` (\`known\`, \`predicted\` or \`unknown\`) and shows a note only
when the target looks like a typo of a known stage. Use \`ask\` only for a live, reply-capable target.
${ASK_DESCRIPTION}
Stage paths win over same-named owned subgroups for send/ask; \`list\` with \`group\` continues to
select the group.
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
  intercom({ action: "send", to: "subagent-worker-*", message: "..." }) → Send to every matching session
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
        description: "Live session name, exact full session ID, unique 8-hex session UUID prefix, or `workflow:<rootRunId>/<segment>[/<segment>...]` path; `*` matches one segment and `**` any depth. Send also takes a session-name glob (`subagent-worker-*`, `*`) or `subagents:*` / `subagents:<runId>/*` for the subagents this session launched; ask needs one exact target. Send queues sticky delivery for pending/future matches; `workflow:<rootRunId>/**` broadcasts to live and future stages. Use `ask` only on live targets (for 'send', 'ask', or targeted 'reply')",
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
      delivery: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("followUp"), Type.Literal("interrupt")], {
        description: "For 'send'/'ask'; choose per message by urgency. 'steer' (default): arrives after the recipient's current tool calls, never cancelling work. 'interrupt': the recipient must stop now (urgent correction, stop order); cancels its current model call or tool call. 'followUp': can wait until the recipient finishes (low priority, after you're done).",
      })),
      wait: Type.Optional(askWaitSchema),
      askId: Type.Optional(askIdSchema),
      replyTo: Type.Optional(Type.String({
        description: "Exact pending-ask message ID or unique 8-hex UUID prefix; disambiguates concurrent asks, including asks from one sender",
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
      // A pattern send (#4752) runs this once per recipient, as a direct send to `fanOutRecipient`.
      const executeAttempt = async (retryToken: string | undefined, _signal?: AbortSignal, retries = 0, fanOutRecipient?: string): Promise<IntercomAttemptResult> => {
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
			  const rows = [
				...peeked.sessions.map((session) => formatSessionListRow(session, currentSession.cwd, session.id === mySessionId)),
				...peeked.workflowStages.map(formatWorkflowStageRow),
				...(peeked.workflowFutureStages ?? []).map(formatWorkflowFutureStageRow),
			  ];
			  const heading = `**Group [${requestedGroup}] (read-only peek):**`;
			  const section = peeked.restricted === true
				? `${heading}\nWorkflow group ${requestedGroup} is visible only to its members. Join it with \`intercom join\` to list its stages.`
				: rows.length === 0
					? `${heading}\nNo sessions or workflow stages in this group.`
					: `${heading}\n${rows.join("\n")}`;
			  return {
				content: [{ type: "text", text: `Your groups: ${ownGroups.join(", ")}\n\n${section}` }],
				isError: false,
				details: {
					group: ownGroups.at(-1),
					groups: ownGroups,
					peekGroup: requestedGroup,
					workflowStages: peeked.workflowStages,
					...((peeked.workflowFutureStages?.length ?? 0) === 0
						? {}
						: { workflowFutureStages: peeked.workflowFutureStages }),
					...(peeked.restricted === true ? { restricted: true } : {}),
				},
			  };
            }

			const otherSessions = ownSessions.filter((session) => session.id !== mySessionId);
			const currentSection = `**Current session** (groups: ${ownGroups.join(", ")}):\n${formatSessionListRow(currentSession, currentSession.cwd, true)}`;
			const visibleRows = [
				...otherSessions.map((session) => formatSessionListRow(session, currentSession.cwd, false)),
				...ownDirectory.workflowStages.map(formatWorkflowStageRow),
				...(ownDirectory.workflowFutureStages ?? []).map(formatWorkflowFutureStageRow),
			];
			const otherSection = visibleRows.length === 0
				? "**Other sessions and workflow stages:**\nNo other sessions or workflow stages share any of your groups."
				: `**Other visible sessions and workflow stages:**\n${visibleRows.join("\n")}`;

            return {
              content: [{ type: "text", text: `${currentSection}\n\n${otherSection}` }],
              isError: false,
              details: {
				group: ownGroups.at(-1),
				groups: ownGroups,
				...(ownDirectory.workflowStages.length === 0
					? {}
					: { workflowStages: ownDirectory.workflowStages }),
				...((ownDirectory.workflowFutureStages?.length ?? 0) === 0
					? {}
					: { workflowFutureStages: ownDirectory.workflowFutureStages }),
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
            const sendTo = await resolveRecipient(connectedClient, to);
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
            // Stage closure cannot undo a submitted send. Preserve its receipt or
            // disconnect retry identity; the owning receiver suppresses late ingress.
            const result = await connectedClient.send(sendTo, {
              messageId: retryIdentity.messageId,
              logicalTarget: to,
              text: message,
              attachments,
              replyTo,
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
              return {
                content: [{
                  type: "text",
                  text: queuedSendText(to, result, pi.getSettings?.().intercom?.showUnknownTargetWarnings === true),
                }],
                isError: false,
                details: {
                  messageId: result.id,
                  delivered: false,
                  queued: true,
                  target: result.target,
                  position: result.position,
                  ...(result.prediction === undefined ? {} : { prediction: result.prediction }),
                  ...(result.unexpected === true ? { unexpected: true } : {}),
                  ...(result.suggestion === undefined ? {} : { suggestion: result.suggestion }),
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
            if (failure === error && sendOutcomeUnknown(error)) {
              return {
                content: [{
                  type: "text",
                  text: `The broker did not answer the send to "${to}" in time, so whether the message was queued or delivered is unknown: it may still arrive. Check with the recipient before sending it again (for a workflow-stage target, \`intercom list\` shows queued counts), because a new send is a new message.`,
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

			// Canonical workflow targets must remain canonical on the send path so the
			// broker can authorize invocation-to-subgroup control. The waiter, however,
			// correlates the actual inbound stage session identity.
			const replySender = await resolveReplySender(connectedClient, to, sendTo);
			if (replySender.kind === "ambiguous") {
				const retained = retryIdentity === undefined
					? undefined
					: retainInconclusiveRetry(retryIdentities, retryIdentity);
				retryIdentity = undefined;
				return {
					content: [{
						type: "text",
						text: `Message to "${to}" is ambiguous: ${replySender.reason}. Use the exact target shown by intercom list.`,
					}],
					isError: true,
					details: retryErrorDetails(retained?.retryToken),
				};
			}
			const questionId = retryIdentity.messageId;
			let replyFrom = replySender.kind === "resolved" ? replySender.sessionId : sendTo;
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
            const sendResult = await connectedClient.send(sendTo, {
              messageId: questionId,
              logicalTarget: to,
              text: question,
              attachments,
              replyTo,
              expectsReply: true,
              ...deliveryOption,
              // The broker names the recipient it authorized to answer, so its reply is matched to this ask: the
              // session behind a canonical path, a target the listing could not resolve (such as a peer's own
              // session id, #3760), or a recipient that reconnected under a new session id before confirming (#3761).
              onReplyTarget: (sender) => {
                replyFrom = sender;
                wait?.bindSender(sender);
              },
            });

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
							const pendingStageAskRefusal = errorText.startsWith(
								"Cannot ask a workflow stage whose session has not initialized.",
							);
              return {
                content: [{
                  type: "text",
                  text: `Message to "${to}" was not delivered: ${errorText}`,
                }],
                isError: true,
                details: {
                  ...(pendingStageAskRefusal
                    ? {
                        refusal: "pending_stage_ask_unsupported",
                        recommendedAction: "send",
                        reason: errorText,
                      }
                    : {}),
                  ...retryErrorDetails(retained.retryToken),
                },
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
                details: { error: true, askId: questionId, replyTo: replyMessage.replyTo },
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
            const sendReply = (targetId: string) => connectedClient.send(targetId, {
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
              return {
                content: [{ type: "text", text: `Reply queued for ${displayTarget}` }],
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
              return {
                content: [{
                  type: "text",
                  text: `Reply to "${displayTarget}" was not delivered: ${errorText}`,
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
          if (pendingAsks.length === 0 && outbound.length === 0) {
            return {
              content: [{ type: "text", text: "No unresolved inbound or outbound asks." }],
              isError: false,
              details: { outbound: [] },
            };
          }

          const now = Date.now();
          const elapsed = (since: number) => `${Math.max(0, Math.floor((now - since) / 1000))}s ago`;
          const sections: string[] = [];
          if (pendingAsks.length > 0) {
            const lines = pendingAsks.map(({ from, message, receivedAt }) => {
              const preview = message.content.text.replace(/\s+/g, " ").slice(0, 80);
              return `- ${from.name || from.id} · ${message.id} · ${elapsed(receivedAt)} · ${preview}`;
            });
            sections.push(`**Pending asks:**\n${lines.join("\n")}`);
          }
          if (outbound.length > 0) {
            const lines = outbound.map(({ askId, to, question, askedAt }) =>
              `- ${askId} → ${to} · ${elapsed(askedAt)} · ${question.replace(/\s+/g, " ").slice(0, 80)}`
            );
            sections.push(`**Your asks awaiting a reply:**\n${lines.join("\n")}`);
          }
          return {
            content: [{ type: "text", text: sections.join("\n\n") }],
            isError: false,
            details: { outbound: outbound.map(({ askId, to, askedAt }) => ({ askId, to, askedAt })) },
          };
        }

        case "cancel": {
          const requested = typeof params.askId === "string" ? params.askId.trim() : "";
          if (!requested) {
            return { content: [{ type: "text", text: "Missing 'askId' parameter" }], isError: true, details: { error: true } };
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
                text: `**Intercom Status:**\nConnected: Yes\nSession ID: ${mySessionId}\nGroups: ${ownGroups.join(", ")}\nActive visible sessions: ${sessions.length}${selectedSection}${multiNodeSection}\nYour asks awaiting a reply: ${outboundAsks().pending().length}`,
              }],
              isError: false,
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
          signal,
          ctx,
          sendOne: (recipient) =>
            runIntercomOperation(
              (token, attemptSignal, retries) => executeAttempt(token, attemptSignal, retries, recipient),
              (token) => retryIdentities.discard(token),
              signal,
            ),
        });
      }
      if (action !== "send" && action !== "ask" && action !== "reply") return executeAttempt(undefined, signal);
      return runIntercomOperation(executeAttempt, (token) => retryIdentities.discard(token), signal);
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
