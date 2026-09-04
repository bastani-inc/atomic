import type { ExtensionAPI } from "@bastani/atomic";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { IntercomClient } from "./broker/client.js";
import type { SessionInfo, SessionDirectory, WorkflowStageRosterEntry, WorkflowFutureStageRosterEntry } from "./types.js";
import { requestParentAskHandoff } from "./parent-ask-handoff.js";
import type { ReplyWait, ReplyWaitAdmission } from "./reply-waiter.ts";
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
import { resolveSessionTargetId } from "./session-target.js";
import { normalizeGroup, normalizeGroups, validateRuntimeGroup } from "./group.js";
import { parseWorkflowStageTarget, withWorkflowStageTargetFinalSegment } from "./workflow-stage-target.js";
import { isRecoverableIntercomDisconnect } from "./recoverable-disconnect.js";
import { RetryIdentityReservations, type RetryIdentityAttempt, RetryTokenError } from "./retry-identity.js";

function retryTokenGuidance(retryToken: string | undefined, remainingRetries: number): string {
	if (retryToken === undefined) return "";
	return ` Retry this exact operation with retryToken \`${retryToken}\` (${remainingRetries} claimed ${remainingRetries === 1 ? "attempt" : "attempts"} remain; the original deadline is unchanged).`;
}

function retryErrorDetails(retryToken: string | undefined): Record<string, unknown> {
	return retryToken === undefined ? { error: true } : { error: true, retryToken };
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
	return `- **${stage.stageName}** — workflow stage [${stage.lifecycle.toUpperCase()}] — target: \`${stage.target}\`${
		stage.sessionId === undefined ? "" : ` — intercom session: ${stage.sessionId}`
	}`;
}

/** D7 (slice 4): one possible-future row from the run's persisted scan (or the `**` broadcast row). */
function formatWorkflowFutureStageRow(stage: WorkflowFutureStageRosterEntry): string {
	return `- future workflow stage \`${stage.target}\` — ${stage.queuedCount} queued message${
		stage.queuedCount === 1 ? "" : "s"
	}`;
}

interface IntercomToolDeps {
  childOrchestratorMetadata?: ChildOrchestratorMetadata | null | (() => ChildOrchestratorMetadata | null);
  ensureConnected(reason: "tool"): Promise<IntercomClient>;
  syncPresenceIdentity(sessionId: string): void;
  resolveSessionTarget?(activeClient: IntercomClient, nameOrId: string): Promise<string | null>;
  homeGroup(): string;
  setJoinedGroups(groups: readonly string[]): void;
  clearJoinedGroups(): void;
  confirmSend: boolean;
  /** Atomically reserves one correlation-keyed reply waiter. */
  beginReplyWait(from: string, replyTo: string, signal?: AbortSignal): ReplyWaitAdmission;
  replyTracker: ReplyTracker | (() => ReplyTracker);
  /** Internal test seam for exercising retry pressure before public tool side effects. */
  retryIdentityMaxEntries?: number;
}

export function registerIntercomTool(pi: ExtensionAPI, deps: IntercomToolDeps): void {
  const retryIdentities = new RetryIdentityReservations({ maxEntries: deps.retryIdentityMaxEntries });
  const { childOrchestratorMetadata, ensureConnected, syncPresenceIdentity, beginReplyWait } = deps;
  const resolveTarget = deps.resolveSessionTarget ?? resolveSessionTargetId;
  const getMetadata = typeof childOrchestratorMetadata === "function"
    ? childOrchestratorMetadata
    : () => childOrchestratorMetadata ?? null;
  const activeReplyTracker = (): ReplyTracker =>
    typeof deps.replyTracker === "function" ? deps.replyTracker() : deps.replyTracker;
  pi.registerTool({
    name: "intercom",
    label: "Intercom",
    description: `Send a message to another local agent session running on this machine.
Use this to communicate findings, request help, or coordinate work with other sessions.

Sessions belong to an intercom group and can ONLY message sessions in the same group;
cross-group sends are rejected by the broker. Ungrouped sessions share the "default" group.

For send, live session names and exact full session IDs remain supported. Workflow-stage targets use
\`workflow:<rootRunId>/<segment>[/<segment>...]\`; a segment may be a stage name, run id, or glob
(\`*\` matches one segment and may be embedded, while \`**\` matches any depth). Use \`intercom list\`
inside the invocation group to see live, pending, and possible future targets with queued counts.
\`workflow:<rootRunId>/**\` reaches every live stage immediately and remains sticky for every future
stage until the root run terminates; narrower name or pattern sends likewise reach every future match.
A valid target outside the known set queues speculatively with a \`notInKnownSet\` warning and settles
undeliverable at terminal only if never delivered. Use \`ask\` only for a live, reply-capable target.
Stage paths win over same-named owned subgroups for send/ask; \`list\` with \`group\` continues to
select the group.
If a \`send\`, \`ask\`, or \`reply\` fails with \`Client disconnected\`, retry that exact operation with the returned \`retryToken\`, up to three claimed attempts; a call without the token is always a distinct operation.

Usage:
  intercom({ action: "list" })                    → List sessions visible through your groups
  intercom({ action: "list", group: "name" })     → Read-only peek at one group's sessions
  intercom({ action: "groups" })                  → Discover every available group and your memberships
  intercom({ action: "join", group: "name" })     → Add a named group membership
  intercom({ action: "leave", group: "name" })    → Leave one named group
  intercom({ action: "leave" })                   → Return to your resolved home group
  intercom({ action: "send", to: "session-name", message: "..." })  → Send message (shared group only)
  intercom({ action: "ask", to: "session-name", message: "..." })   → Ask and wait for reply
  intercom({ action: "reply", message: "..." })                      → Reply to the active or exact pending ask
  intercom({ action: "send", to: "session-name", message: "...", retryToken: "..." }) → Claim the exact retry returned by a retryable failure
  intercom({ action: "pending" })                                      → List unresolved inbound asks
  intercom({ action: "status" })                  → Show connection status and all your groups

The "join" action is additive. "default" is the shared default group; "true" and
"auto" are reserved for subagent auto-groups. Ordinary delivery requires at least
one shared membership; contact_supervisor remains the only cross-group path.`,
    promptSnippet:
      "Use to coordinate with other local agent sessions that share an intercom group. For a retryable send/ask/reply failure, repeat the exact operation with its returned retryToken; omit retryToken for fresh operations.",
    parameters: Type.Object({
      action: Type.String({
        description: "Action: 'list', 'groups', 'join', 'leave', 'send', 'ask', 'reply', 'pending', or 'status'",
      }),
      to: Type.Optional(Type.String({
        description: "Live session name, exact full session ID, or `workflow:<rootRunId>/<segment>[/<segment>...]` path; `*` matches one segment and `**` any depth. Send queues sticky delivery for pending/future matches; `workflow:<rootRunId>/**` broadcasts to live and future stages. Use `ask` only on live targets (for 'send', 'ask', or targeted 'reply')",
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
        description: "Exact pending-ask message ID; disambiguates concurrent asks, including asks from one sender",
      })),
      retryToken: Type.Optional(Type.String({
        minLength: 1,
        maxLength: 128,
        description: "Opaque token returned after a retryable send/ask/reply failure. Repeat the exact same action and arguments with this token; omit it for every fresh operation.",
      })),
      group: Type.Optional(Type.String({
        description: "Group name for 'join' or optional targeted 'leave'; read-only group filter for 'list'/'status'. 'send'/'ask' use shared memberships.",
      })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const toolSessionId = ctx.sessionManager.getSessionId();
      const { action, to, message, attachments, replyTo, retryToken, group } = params;
      let retryPreflightRemaining: number | undefined;
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
          retryPreflightRemaining = retryIdentities.validateRetryToken(retryToken, toolSessionId, action);
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
        const retainedToken = retryToken !== undefined && isRecoverableIntercomDisconnect(error) ? retryToken : undefined;
        return {
          content: [{
            type: "text",
            text: `Intercom not connected: ${getErrorMessage(error)}${retryTokenGuidance(retainedToken, retryPreflightRemaining ?? 0)}`,
          }],
          isError: true,
          details: retryErrorDetails(retainedToken),
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
            deps.setJoinedGroups(groups);
            return {
              content: [{ type: "text", text: `Joined intercom group "${targetGroup}". Memberships: ${groups.join(", ")}.` }],
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
              deps.clearJoinedGroups();
            } else {
              groups = await connectedClient.leaveGroup(targetGroup);
              deps.setJoinedGroups(groups);
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
			  const section = rows.length === 0
				? `**Group [${requestedGroup}] (read-only peek):**\nNo sessions or workflow stages in this group.`
				: `**Group [${requestedGroup}] (read-only peek):**\n${rows.join("\n")}`;
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
                text: `Cancelled${retryTokenGuidance(retryToken, retryPreflightRemaining ?? 0)}`,
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
            if (!replyTo && deps.confirmSend && ctx.hasUI) {
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
            const sendTo = await resolveTarget(connectedClient, to) ?? to;
            if (_signal?.aborted) {
              const retained = retainInconclusiveRetry(retryIdentities, retryIdentity);
              retryIdentity = undefined;
              return {
                content: [{ type: "text", text: `Cancelled${retryTokenGuidance(retained.retryToken, retained.remainingRetries)}` }],
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
                  text: `Cannot message the current session${retryTokenGuidance(retained.retryToken, retained.remainingRetries)}`,
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
            });

            if (result.queued === true) {
              retryIdentities.release(retryIdentity);
              retryIdentity = undefined;
              pi.appendEntry("intercom_sent", {
                to,
                message: { text: message, attachments, replyTo },
                messageId: result.id,
                timestamp: Date.now(),
              });
              const notInKnownSet = result.notInKnownSet === true;
              return {
                content: [{
                  type: "text",
                  text: notInKnownSet
                    ? `Message queued for ${to} (not in the workflow's known stage set; it will be delivered to every matching stage that starts before the run terminates)`
                    : `Message queued for ${to}`,
                }],
                isError: false,
                details: {
                  messageId: result.id,
                  delivered: false,
                  queued: true,
                  target: result.target,
                  position: result.position,
                  ...(notInKnownSet ? { notInKnownSet: true } : {}),
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
                  text: `Message to "${to}" was not delivered: ${errorText}${retryTokenGuidance(retained.retryToken, retained.remainingRetries)}`,
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
            pi.appendEntry("intercom_sent", {
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
            return {
              content: [{
                type: "text",
                text: `Failed to send: ${getErrorMessage(failure)}${retryTokenGuidance(retained?.retryToken, retained?.remainingRetries ?? 0)}`,
              }],
              isError: true,
              details: retryErrorDetails(retained?.retryToken),
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
                text: `Cancelled${retryTokenGuidance(retryToken, retryPreflightRemaining ?? 0)}`,
              }],
              isError: true,
              details: retryErrorDetails(retryToken),
            };
          }
          let wait: ReplyWait | null = null;
          let retryIdentity: RetryIdentityAttempt | undefined;

          try {
            if (retryToken !== undefined && !message) throw new RetryTokenError("mismatch");
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
            const claimParentAsk = (resolvedTargetId: string): boolean =>
              Boolean(
                metadata &&
                requestParentAskHandoff(pi.events, metadata, {
                  kind: "intercom",
                  question: typeof message === "string" ? message : "",
                  attachments,
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

            const sendTo = await resolveTarget(connectedClient, to) ?? to;
            if (_signal?.aborted) {
              const retained = retryIdentity === undefined
                ? undefined
                : retainInconclusiveRetry(retryIdentities, retryIdentity);
              retryIdentity = undefined;
              return {
                content: [{
                  type: "text",
                  text: `Cancelled${retryTokenGuidance(retained?.retryToken, retained?.remainingRetries ?? 0)}`,
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
                  text: `Cannot message the current session${retryTokenGuidance(retained?.retryToken, retained?.remainingRetries ?? 0)}`,
                }],
                isError: true,
                details: retryErrorDetails(retained?.retryToken),
              };
            }
            if (retryToken === undefined && metadata && !directParentTarget) {
              const authoritativeParent = [currentSupervisorId, metadataSupervisorId].find(
                (candidate) => candidate === sendTo,
              );
              const resolvedParent =
                authoritativeParent ?? await resolveTarget(connectedClient, metadata.orchestratorTarget);
              if (resolvedParent !== null && resolvedParent === sendTo && claimParentAsk(sendTo)) {
                retryIdentities.release(retryIdentity);
                retryIdentity = undefined;
                return {
                  content: [{ type: "text", text: "Parent ask claimed; this child is ending for a fresh subagent start." }],
                  isError: false,
                  details: { yielded: true },
                };
              }
            }

            if (!message) {
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
						text: `Message to "${to}" is ambiguous: ${replySender.reason}. Use the exact target shown by intercom list.${retryTokenGuidance(retained?.retryToken, retained?.remainingRetries ?? 0)}`,
					}],
					isError: true,
					details: retryErrorDetails(retained?.retryToken),
				};
			}
			const questionId = retryIdentity.messageId;
			const replyFrom = replySender.kind === "resolved" ? replySender.sessionId : sendTo;
			const admission = beginReplyWait(replyFrom, questionId, _signal);
            if (!admission.ok) {
              const retained = retainInconclusiveRetry(retryIdentities, retryIdentity);
              retryIdentity = undefined;
              const text = admission.reason === "busy"
                ? `Too many pending asks (${admission.limit}); reply-wait slots are full`
                : "Cancelled";
              return {
                content: [{
                  type: "text",
                  text: `${text}${retryTokenGuidance(retained.retryToken, retained.remainingRetries)}`,
                }],
                isError: true,
                details: retryErrorDetails(retained.retryToken),
              };
            }
            wait = admission.wait;
            const sendResult = await connectedClient.send(sendTo, {
              messageId: questionId,
              logicalTarget: to,
              text: message,
              attachments,
              replyTo,
              expectsReply: true,
            });

            if (sendResult.queued === true) {
              retryIdentities.release(retryIdentity);
              retryIdentity = undefined;
              wait.cancel(new Error(`Message queued for ${to}`));
              pi.appendEntry("intercom_sent", {
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
              const retained = retainInconclusiveRetry(retryIdentities, retryIdentity);
              retryIdentity = undefined;
              const errorText = sendResult.reason ?? "Session may not exist or has disconnected.";
              wait.cancel(new Error(`Message to "${to}" was not delivered: ${errorText}`));
							const pendingStageAskRefusal = errorText.startsWith(
								"Cannot ask a workflow stage whose session has not initialized.",
							);
              return {
                content: [{
                  type: "text",
                  text: `Message to "${to}" was not delivered: ${errorText}${retryTokenGuidance(retained.retryToken, retained.remainingRetries)}`,
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
            pi.appendEntry("intercom_sent", {
              to,
              message: { text: message, attachments, replyTo },
              messageId: sendResult.id,
              timestamp: Date.now(),
            });
            const replyMessage = await wait.promise;
            retryIdentities.release(retryIdentity);
            retryIdentity = undefined;
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
            if (replyMessage.replyError !== undefined) {
              return {
                content: [{ type: "text", text: `Failed: ${replyMessage.replyError}` }],
                isError: true,
                details: { error: true, replyTo: replyMessage.replyTo },
              };
            }
            return {
              content: [{ type: "text", text: `**Reply from ${to}:**\n${replyText}${replyAttachments}` }],
              isError: false,
              details: {},
            };
          } catch (error) {
            wait?.cancel(toError(error));
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
                text: `Failed: ${getErrorMessage(failure)}${retryTokenGuidance(retained?.retryToken, retained?.remainingRetries ?? 0)}`,
              }],
              isError: true,
              details: retryErrorDetails(retained?.retryToken),
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
            const replySendTo = to ?? route.senderId;
            const replyLogicalTarget = to ?? route.senderId;
            const displayTarget = route.senderName || route.senderId;
            if (route.senderId === connectedClient.sessionId) {
              const retained = retainInconclusiveRetry(retryIdentities, retryIdentity);
              retryIdentity = undefined;
              return {
                content: [{
                  type: "text",
                  text: `Cannot message the current session${retryTokenGuidance(retained.retryToken, retained.remainingRetries)}`,
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
              text: message,
              attachments,
              replyTo: route.messageId,
            });
            let result = await sendReply(replySendTo);
            if (
              to === undefined &&
              result.delivered === false &&
              result.reasonCode === "session_not_found" &&
              route.senderName !== undefined
            ) {
              result = await sendReply(route.senderName);
            }
            if (result.queued === true) {
              retryIdentities.release(retryIdentity);
              retryIdentity = undefined;
              activeReplyTracker().markReplied(route.messageId);
              pi.appendEntry("intercom_sent", {
                to: displayTarget,
                message: { text: message, attachments, replyTo: route.messageId },
                messageId: result.id,
                timestamp: Date.now(),
              });
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
                  text: `Reply to "${displayTarget}" was not delivered: ${errorText}${retryTokenGuidance(retained.retryToken, retained.remainingRetries)}`,
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
            activeReplyTracker().markReplied(route.messageId);
            pi.appendEntry("intercom_sent", {
              to: displayTarget,
              message: { text: message, attachments, replyTo: route.messageId },
              messageId: result.id,
              timestamp: Date.now(),
            });
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
                text: `Failed to reply: ${getErrorMessage(failure)}${retryTokenGuidance(retained?.retryToken, retained?.remainingRetries ?? 0)}`,
              }],
              isError: true,
              details: retryErrorDetails(retained?.retryToken),
            };
          }
        }

        case "pending": {
          const pendingAsks = activeReplyTracker().listPending();
          if (pendingAsks.length === 0) {
            return {
              content: [{ type: "text", text: "No unresolved inbound asks." }],
              isError: false,
              details: {},
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
            details: {},
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
            return {
              content: [{
                type: "text",
                text: `**Intercom Status:**\nConnected: Yes\nSession ID: ${mySessionId}\nGroups: ${ownGroups.join(", ")}\nActive visible sessions: ${sessions.length}${selectedSection}`,
              }],
              isError: false,
              details: {
                group: ownGroups.at(-1),
                groups: ownGroups,
                ...(selectedGroup === undefined
                  ? {}
                  : { selectedGroup, selectedGroupSessionCount: selectedGroupSessions?.length ?? 0 }),
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
