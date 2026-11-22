import { Type } from "@bastani/atomic-ai";
import { ASK_DESCRIPTION, ASK_PROMPT_SNIPPET, ASK_USAGE, askIdSchema, askWaitSchema } from "./ask-wait.js";
import { RETURN_PATH_TOOL_NOTE } from "./group.js";

export const INTERCOM_TOOL_DESCRIPTION = `Send a message to another local agent session running on this machine.
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
one shared membership; contact_supervisor remains the only cross-group path.`;

export const INTERCOM_TOOL_PROMPT_SNIPPET = `Use to coordinate with other local agent sessions that share an intercom group. ${ASK_PROMPT_SNIPPET} Send/ask/reply retry reconnects internally; do not automatically repeat an unknown delivery outcome.`;

export function createIntercomToolParameters() {
	return Type.Object({
		action: Type.String({
			description: "Action: 'list', 'groups', 'join', 'leave', 'send', 'ask', 'reply', 'pending', 'cancel', or 'status'",
		}),
		to: Type.Optional(
			Type.String({
				description:
					"Live session name, exact full session ID, or unique 8-hex session UUID prefix. Send also takes a session-name glob (`subagent-worker-*`, `*`) or `subagents:*` / `subagents:<runId>/*` for the subagents this session launched; ask needs one exact target (for 'send', 'ask', or targeted 'reply')",
			}),
		),
		message: Type.Optional(
			Type.String({
				description: "Message to send (for 'send', 'ask', or 'reply' action)",
			}),
		),
		broadcast: Type.Optional(
			Type.Boolean({
				description:
					"For 'send' to a session-name glob: true to reach every match. Without it, a glob that matches more than one session is refused with the list of matches. `subagents:` targets broadcast without it.",
			}),
		),
		attachments: Type.Optional(
			Type.Array(
				Type.Object({
					type: Type.Union([Type.Literal("file"), Type.Literal("snippet"), Type.Literal("context")]),
					name: Type.String(),
					content: Type.String(),
					language: Type.Optional(Type.String()),
				}),
			),
		),
		delivery: Type.Optional(
			Type.Union([Type.Literal("steer"), Type.Literal("followUp"), Type.Literal("interrupt")], {
				description:
					"For 'send'/'ask'; choose per message by urgency. 'steer' (default): arrives after the recipient's current tool calls, never cancelling work. 'interrupt': the recipient must stop now (urgent correction, stop order); cancels its current model call or tool call. 'followUp': can wait until the recipient finishes (low priority, after you're done).",
			}),
		),
		wait: Type.Optional(askWaitSchema),
		askId: Type.Optional(askIdSchema),
		replyTo: Type.Optional(
			Type.String({
				description:
					"Exact pending-ask message ID or unique 8-hex UUID prefix; disambiguates concurrent asks, including asks from one sender. With 'cancel', closes that ask sent to you without replying",
			}),
		),
		group: Type.Optional(
			Type.String({
				description:
					"Group name for 'join' or optional targeted 'leave'; read-only group filter for 'list'/'status'. 'send'/'ask' use shared memberships.",
			}),
		),
	});
}

export const CONTACT_SUPERVISOR_TOOL_DESCRIPTION =
	"Subagent-only tool for contacting the supervisor agent that delegated this task. need_decision and interview_request ask the supervisor over Intercom and wait for its reply, which this same child continues with; if the result instead ends the child with a fresh-subagent handoff, follow it. One blocking supervisor request is allowed per child and may coexist with ordinary intercom asks. progress_update is fire-and-forget. Do not use for routine completion handoffs.";

export const CONTACT_SUPERVISOR_TOOL_PROMPT_SNIPPET =
	"Subagent-only: ask the supervisor for decisions or structured interviews and continue with its answers, or send meaningful plan-changing progress updates.";

export const CONTACT_SUPERVISOR_TOOL_PROMPT_GUIDELINES = [
	"Use contact_supervisor with reason='need_decision' when a subagent is blocked, uncertain, needs approval, or faces a product/API/scope decision. The supervisor's reply comes back to this child; follow the actual tool result.",
	"Use contact_supervisor with reason='interview_request' when the child needs multiple structured answers. The answers come back to this child; follow the actual tool result.",
	"Use contact_supervisor with reason='progress_update' only for meaningful progress or unexpected discoveries that change the plan.",
	"Do not use contact_supervisor for routine completion handoffs; return the final subagent result normally.",
];

export function createContactSupervisorToolParameters() {
	return Type.Object({
		reason: Type.String({
			enum: ["need_decision", "progress_update", "interview_request"],
			description:
				"Contact reason: 'need_decision' and 'interview_request' wait for the supervisor's reply; 'progress_update' sends a non-blocking update",
		}),
		message: Type.Optional(
			Type.String({
				description: "Decision request, optional interview note, or meaningful progress update for the supervisor",
			}),
		),
		interview: Type.Optional(
			Type.Object(
				{
					title: Type.Optional(Type.String()),
					description: Type.Optional(Type.String()),
					questions: Type.Array(
						Type.Object({
							id: Type.String(),
							type: Type.String({ description: "Question type: single, multi, text, image, or info" }),
							question: Type.String(),
							options: Type.Optional(Type.Array(Type.Unknown())),
							context: Type.Optional(Type.String()),
						}),
					),
				},
				{ description: "Structured interview request for reason='interview_request'" },
			),
		),
	});
}
