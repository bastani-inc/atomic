import { Type } from "@bastani/atomic-ai";
import { Text } from "@bastani/atomic-tui";
import { APP_NAME, getEnvValue } from "../../../config.js";
import { renderDormantIntercomWakeMessage } from "../../../modes/interactive/components/dormant-builtin-messages.js";
import type { SessionEntry } from "../../session-manager.ts";
import type { WaitPolicy } from "../../tasks/contracts.js";
import type { LazyBuiltinController, LazyBuiltinSpec } from "../lazy-builtin.js";
import { isStaleExtensionContextError } from "../stale-context.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition, ToolScriptAccess } from "../types.ts";

const INTERCOM_SCRIPT_ACTIONS = ["list", "status", "pending", "send"] as const;
const MODEL_ONLY_HINT = `Scripts may call intercom only with ${INTERCOM_SCRIPT_ACTIONS.map((action) => `"${action}"`).join(", ")}; call the intercom tool directly for anything else.`;

const RETURN_PATH_WINDOW_MS = 30 * 60_000;
const RETURN_PATH_MESSAGE_LIMIT = 3;
const RETURN_PATH_TOOL_NOTE = `except an answer to a sender outside your groups whose message reached you (up to ${RETURN_PATH_MESSAGE_LIMIT} messages within ${Math.round(RETURN_PATH_WINDOW_MS / 60_000)} minutes of its latest one)`;

const ASK_REPLY_TIMEOUT_MS = 10 * 60 * 1000;
const STARTUP_JOIN_DELAY_MS = 3_000;
const STARTUP_JOIN_RETRIES = 5;
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000] as const;
const INTERCOM_JOIN_AT_STARTUP_ENV = "ATOMIC_INTERCOM_JOIN_AT_STARTUP";
const INTERCOM_STARTUP_JOIN_EVENT = "intercom:startup-join";

const SUBAGENT_CONTROL_INTERCOM_EVENT = "subagent:control-intercom";
const SUBAGENT_RESULT_INTERCOM_EVENT = "subagent:result-intercom";
const SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT = "subagent:result-intercom-delivery";
const SUBAGENT_SUPERVISOR_AUTHORIZATION_EVENT = "subagent:supervisor-authorization";
const SUBAGENT_AWAIT_INTERCOM_PEER_EVENT = "subagent:await-intercom-peer";
const SUBAGENT_RESERVE_RESTORING_CHILD_EVENT = "subagent:reserve-restoring-child";
const SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT = "subagent:reserve-released-children";
const SUBAGENT_DROP_RELEASED_CHILDREN_EVENT = "subagent:drop-released-children";
const SUBAGENT_ACKNOWLEDGE_RELEASED_CHILD_WAKE_EVENT = "subagent:acknowledge-released-child-wake";
const SUBAGENT_MARK_ENDED_CHILDREN_EVENT = "subagent:mark-ended-children";
const SUBAGENT_RELEASE_RESTORING_CHILD_EVENT = "subagent:release-restoring-child";
const RELEASED_REPLY_FORMAT_EVENT = "intercom:format-released-reply";

const INTERCEPTED_BUS_EVENTS: readonly string[] = [
	INTERCOM_STARTUP_JOIN_EVENT,
	SUBAGENT_CONTROL_INTERCOM_EVENT,
	SUBAGENT_RESULT_INTERCOM_EVENT,
	SUBAGENT_SUPERVISOR_AUTHORIZATION_EVENT,
	SUBAGENT_AWAIT_INTERCOM_PEER_EVENT,
	SUBAGENT_RESERVE_RESTORING_CHILD_EVENT,
	SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT,
	SUBAGENT_DROP_RELEASED_CHILDREN_EVENT,
	SUBAGENT_ACKNOWLEDGE_RELEASED_CHILD_WAKE_EVENT,
	SUBAGENT_MARK_ENDED_CHILDREN_EVENT,
	SUBAGENT_RELEASE_RESTORING_CHILD_EVENT,
	RELEASED_REPLY_FORMAT_EVENT,
];

const MANAGED_EVENTS: readonly string[] = ["session_recovery_restore", "session_recovery_replay"];

const SUBAGENT_ENV_PREFIX = `${APP_NAME.toUpperCase()}_SUBAGENT_`;

function readSubagentEnv(name: string): string | undefined {
	const value = getEnvValue(`${SUBAGENT_ENV_PREFIX}${name}`)?.trim();
	return value || undefined;
}

function hasSubagentIntercomEnv(): boolean {
	return readSubagentEnv("ORCHESTRATOR_TARGET") !== undefined;
}

function startupJoinFromEnv(): boolean | undefined {
	const value = getEnvValue(INTERCOM_JOIN_AT_STARTUP_ENV)?.trim().toLowerCase();
	if (value === "0" || value === "false") return false;
	if (value === "1" || value === "true") return true;
	return undefined;
}

function joinsIntercomAtStartup(ctx: ExtensionContext, activeTools: () => readonly string[]): boolean {
	return (
		ctx.mode === "tui" &&
		ctx.hasUI &&
		ctx.isPresentationOnly !== true &&
		ctx.subagentPolicy === undefined &&
		activeTools().includes("intercom")
	);
}

function reconnectDelayMs(attempt: number): number {
	return RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)]!;
}

function projectTrusted(ctx: ExtensionContext): boolean {
	try {
		return typeof ctx.isProjectTrusted !== "function" || ctx.isProjectTrusted();
	} catch {
		return false;
	}
}

const ENDED_CHILD_WAKE_MESSAGE_TYPE = "intercom_subagent_wake";

function hasIntercomHistory(entries: readonly SessionEntry[]): boolean {
	return entries.some(
		(entry) =>
			(entry.type === "custom_message" && entry.customType === "intercom_message") ||
			(entry.type === "custom" && entry.customType === "intercom_inbox") ||
			(entry.type === "custom" && entry.customType === "intercom_ask") ||
			(entry.type === "custom" && entry.customType === "subagent-child") ||
			(entry.type === "message" &&
				entry.message.role === "toolResult" &&
				(entry.message.toolName === "intercom" || entry.message.toolName === "contact_supervisor")),
	);
}

const sessionEntrySchema = Type.Object({
	sessionId: Type.String(),
	name: Type.Optional(Type.String()),
	cwd: Type.String(),
	state: Type.Union([Type.Literal("idle"), Type.Literal("busy"), Type.Literal("unknown")]),
	activity: Type.Optional(Type.String({ description: "What a busy session is doing, such as `tool:bash`" })),
	groups: Type.Array(Type.String()),
	replyCapability: Type.Optional(Type.Union([Type.Literal("live"), Type.Literal("terminal")])),
	self: Type.Boolean(),
});

const intercomScriptOutputSchema = Type.Union([
	Type.Object({
		action: Type.Literal("list"),
		groups: Type.Array(Type.String()),
		peekGroup: Type.Optional(Type.String()),
		sessions: Type.Array(sessionEntrySchema),
	}),
	Type.Object({
		action: Type.Literal("status"),
		sessionId: Type.String(),
		groups: Type.Array(Type.String()),
		sessions: Type.Array(sessionEntrySchema),
		outboundAsks: Type.Number(),
	}),
	Type.Object({
		action: Type.Literal("pending"),
		inbound: Type.Array(
			Type.Object({
				messageId: Type.String(),
				from: Type.String(),
				fromSessionId: Type.String(),
				receivedAt: Type.Number(),
				text: Type.String(),
			}),
		),
		outbound: Type.Array(Type.Object({ askId: Type.String(), to: Type.String(), askedAt: Type.Number() })),
	}),
	Type.Object({
		action: Type.Literal("send"),
		target: Type.String(),
		outcome: Type.Union([
			Type.Literal("delivered"),
			Type.Literal("queued"),
			Type.Literal("refused"),
			Type.Literal("unknown"),
			Type.Literal("cancelled"),
		]),
		messageId: Type.Optional(Type.String()),
		reason: Type.Optional(Type.String()),
	}),
]);

function refuseIntercomScriptCall(params: { action: string; to?: string; replyTo?: string }): string | undefined {
	const { action } = params;
	if (!(INTERCOM_SCRIPT_ACTIONS as readonly string[]).includes(action)) {
		return `intercom "${action}" is model-only: call the intercom tool directly, not from a script. ${MODEL_ONLY_HINT}`;
	}
	if (action !== "send") return undefined;
	if (params.replyTo !== undefined) {
		return `A send with replyTo answers an ask, which is model-only: call the intercom tool directly, not from a script. ${MODEL_ONLY_HINT}`;
	}
	const to = params.to?.trim() ?? "";
	if (to.includes("*") || to.startsWith("subagents:")) {
		return `Scripts may send only to an exact target: a live session name, or a full session id or unique 8-hex prefix. "${to}" is a pattern; send to each recipient by its exact name, or call the intercom tool directly to send to a pattern.`;
	}
	return undefined;
}

const intercomScriptAccess: ToolScriptAccess<{ action: string; to?: string; replyTo?: string }> = {
	description: `Coordinate with other local agent sessions that share an intercom group. Scripts may use these actions; the others (ask, reply, cancel, join, leave, groups) are model-only.
- { action: "list", group? }: sessions visible through your groups, or one group's sessions with group, as { sessionId, name?, cwd, state, activity?, groups, replyCapability?, self }.
- { action: "status", group? }: your session id, groups, the visible sessions, and how many of your asks await a reply.
- { action: "pending" }: unanswered asks sent to you (inbound) and your asks awaiting a reply (outbound).
- { action: "send", to, message, attachments?, delivery? }: send to one exact target: a live session name, or a full session id or unique 8-hex prefix. Globs, "*" and "subagents:" targets are refused. Resolves to { target, outcome, messageId?, reason? }, where outcome is "delivered", "queued", "refused", "unknown" (do not resend automatically) or "cancelled".`,
	outputSchema: intercomScriptOutputSchema,
	refuse: refuseIntercomScriptCall,
};

const askWaitSchema = Type.Unsafe<WaitPolicy>({
	type: "object",
	properties: {
		kind: { type: "string", enum: ["background", "foreground"] },
		budgetMs: {
			type: "number",
			minimum: 0,
			description: "Foreground observation budget in milliseconds; only valid with foreground.",
		},
	},
	required: ["kind"],
	additionalProperties: false,
	description:
		"For 'ask': how long to wait for the reply before yielding, as in bash. Omit for owner-configured automatic yield (default 10s). The ask stays pending after a yield and its reply arrives later as a message.",
});

const askIdSchema = Type.String({
	description:
		"For 'cancel': the id (or a unique prefix) of one of your pending asks, as 'ask' or 'pending' reported it",
});

const ASK_DESCRIPTION = `\`ask\` never blocks you: it returns once the question is delivered, with an ask id and whether the recipient is
idle or busy. A reply that comes within the wait (\`wait\` as in bash: omitted waits up to the automatic yield,
\`{ kind: "foreground", budgetMs }\` up to the budget, \`{ kind: "background" }\` not at all) is returned inline;
otherwise the ask stays pending with no expiry and its reply arrives later as a message starting
"Reply to your ask <id> from <name>", which starts a turn when you are idle or arrives after your current tool call.
A refusal or a recipient that ended arrives the same way as a failed-ask message. Do not re-ask while one is pending.`;

const ASK_USAGE = `  intercom({ action: "ask", to: "session-name", message: "..." })   → Ask; reply inline if quick, else later as a message
  intercom({ action: "ask", to: "session-name", message: "...", wait: { kind: "background" } }) → Ask without waiting
  intercom({ action: "cancel", askId: "..." })                       → Cancel one of your pending asks
  intercom({ action: "cancel", replyTo: "..." })                     → Close an ask sent to you without replying`;

const ASK_PROMPT_SNIPPET =
	'`ask` does not block: a reply that misses the wait arrives later as a message ("Reply to your ask <id> from <name>").';

const INTERCOM_DESCRIPTION = `Send a message to another local agent session running on this machine.
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

const INTERCOM_PROMPT_SNIPPET = `Use to coordinate with other local agent sessions that share an intercom group. ${ASK_PROMPT_SNIPPET} Send/ask/reply retry reconnects internally; do not automatically repeat an unknown delivery outcome.`;

function createIntercomParameters() {
	return Type.Object({
		action: Type.String({
			description:
				"Action: 'list', 'groups', 'join', 'leave', 'send', 'ask', 'reply', 'pending', 'cancel', or 'status'",
		}),
		to: Type.Optional(
			Type.String({
				description:
					"Live session name, exact full session ID, or unique 8-hex session UUID prefix. Send also takes a session-name glob (`subagent-worker-*`, `*`) or `subagents:*` / `subagents:<runId>/*` for the subagents this session launched; ask needs one exact target (for 'send', 'ask', or targeted 'reply')",
			}),
		),
		message: Type.Optional(Type.String({ description: "Message to send (for 'send', 'ask', or 'reply' action)" })),
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

const CONTACT_SUPERVISOR_DESCRIPTION =
	"Subagent-only tool for contacting the supervisor agent that delegated this task. need_decision and interview_request ask the supervisor over Intercom and wait for its reply, which this same child continues with; if the result instead ends the child with a fresh-subagent handoff, follow it. One blocking supervisor request is allowed per child and may coexist with ordinary intercom asks. progress_update is fire-and-forget. Do not use for routine completion handoffs.";

const CONTACT_SUPERVISOR_PROMPT_SNIPPET =
	"Subagent-only: ask the supervisor for decisions or structured interviews and continue with its answers, or send meaningful plan-changing progress updates.";

const CONTACT_SUPERVISOR_PROMPT_GUIDELINES = [
	"Use contact_supervisor with reason='need_decision' when a subagent is blocked, uncertain, needs approval, or faces a product/API/scope decision. The supervisor's reply comes back to this child; follow the actual tool result.",
	"Use contact_supervisor with reason='interview_request' when the child needs multiple structured answers. The answers come back to this child; follow the actual tool result.",
	"Use contact_supervisor with reason='progress_update' only for meaningful progress or unexpected discoveries that change the plan.",
	"Do not use contact_supervisor for routine completion handoffs; return the final subagent result normally.",
];

function createContactSupervisorParameters() {
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

function intercomCallMayDetach(params: { readonly action?: string }): boolean {
	return params.action === "ask";
}

function contactSupervisorCallMayDetach(params: { readonly reason?: string }): boolean {
	return params.reason === "need_decision" || params.reason === "interview_request";
}

type ToolRenderCallArgs = Parameters<NonNullable<ToolDefinition["renderCall"]>>;
type ToolRenderResultArgs = Parameters<NonNullable<ToolDefinition["renderResult"]>>;

function renderCallFallback(
	controller: LazyBuiltinController,
	name: "intercom" | "contact_supervisor",
	args: ToolRenderCallArgs,
) {
	const loaded = controller.active?.captured.tools.get(name)?.renderCall;
	if (loaded) return loaded(...args);
	const theme = args[1];
	const label = name === "intercom" ? "Intercom" : "Supervisor";
	return new Text(theme.fg("toolTitle", theme.bold(label)), 0, 0);
}

function renderResultFallback(
	controller: LazyBuiltinController,
	name: "intercom" | "contact_supervisor",
	args: ToolRenderResultArgs,
) {
	const loaded = controller.active?.captured.tools.get(name)?.renderResult;
	if (loaded) return loaded(...args);
	const [result, , theme] = args;
	const firstText = result.content.find((block) => block.type === "text")?.text ?? "";
	return new Text(theme.fg("toolOutput", firstText), 0, 0);
}

interface ReleasedReplyFormatRequest {
	readonly toolName: string;
	readonly args: { readonly to?: string; readonly reason?: string; readonly interview?: object };
	readonly outcome:
		| {
				readonly kind: "reply";
				readonly reply: {
					readonly replyTo: string;
					readonly text: string;
					readonly replyError?: string;
					readonly attachments?: ReadonlyArray<{ name: string; content: string; language?: string }>;
				};
		  }
		| { readonly kind: "timeout"; readonly from: string; readonly retryCount: number };
	result?:
		| {
				readonly ok: true;
				readonly formatted: {
					readonly content: { type: "text"; text: string }[];
					readonly details: Record<string, unknown>;
					readonly isError: boolean;
				};
		  }
		| { readonly ok: false; readonly reason: string };
}

function isReleasedReplyFormatRequest(payload: unknown): payload is ReleasedReplyFormatRequest {
	if (typeof payload !== "object" || payload === null) return false;
	const request = payload as Partial<ReleasedReplyFormatRequest>;
	return (
		typeof request.toolName === "string" &&
		typeof request.args === "object" &&
		request.args !== null &&
		typeof request.outcome === "object" &&
		request.outcome !== null
	);
}

function formatAttachments(attachments: ReadonlyArray<{ name: string; content: string; language?: string }>): string {
	let text = "";
	for (const att of attachments) {
		if (att.language) {
			text += `\n\n---\n📎 ${att.name}\n~~~${att.language}\n${att.content}\n~~~`;
		} else {
			text += `\n\n---\n📎 ${att.name}\n${att.content}`;
		}
	}
	return text;
}

function formatDormantReleasedReply(request: ReleasedReplyFormatRequest): ReleasedReplyFormatRequest["result"] {
	const { toolName, args, outcome } = request;
	if (outcome.kind === "timeout") {
		if (toolName === "intercom") {
			return {
				ok: true,
				formatted: {
					content: [
						{
							type: "text",
							text: `No reply from "${outcome.from}" yet; stopped waiting. The ask stays pending.`,
						},
					],
					details: { pending: true },
					isError: false,
				},
			};
		}
		const reason = `Failed: No reply from "${outcome.from}" within ${Math.round(ASK_REPLY_TIMEOUT_MS / 60_000)} minutes`;
		return {
			ok: true,
			formatted: { content: [{ type: "text", text: reason }], details: { error: true }, isError: true },
		};
	}
	const { reply } = outcome;
	if (reply.replyError !== undefined) {
		return {
			ok: true,
			formatted: {
				content: [{ type: "text", text: `Failed: ${reply.replyError}` }],
				details: { error: true, replyTo: reply.replyTo },
				isError: true,
			},
		};
	}
	const attachments = reply.attachments?.length ? formatAttachments(reply.attachments) : "";
	if (toolName === "intercom") {
		return {
			ok: true,
			formatted: {
				content: [{ type: "text", text: `**Reply from ${args.to}:**\n${reply.text}${attachments}` }],
				details: {},
				isError: false,
			},
		};
	}
	return {
		ok: true,
		formatted: {
			content: [{ type: "text", text: `**Reply from supervisor:**\n${reply.text}${attachments}` }],
			details: {},
			isError: false,
		},
	};
}

function rejectLazyResultRelay(atomic: ExtensionAPI, eventName: string, payload: unknown, error: unknown): void {
	if (eventName !== SUBAGENT_RESULT_INTERCOM_EVENT || !payload || typeof payload !== "object") return;
	const requestId = (payload as { requestId?: unknown }).requestId;
	if (typeof requestId !== "string") return;
	try {
		atomic.events.emit(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, {
			requestId,
			delivered: false,
			error: error instanceof Error ? error.message : String(error),
		});
	} catch (emitError) {
		if (!isStaleExtensionContextError(emitError)) throw emitError;
	}
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const intercomLazyBuiltinSpec: LazyBuiltinSpec = {
	label: "intercom",
	managedEvents: MANAGED_EVENTS,
	interceptedBusEvents: INTERCEPTED_BUS_EVENTS,
	register(atomic, controller) {
		const inheritedDelegatedSessionName = readSubagentEnv("INTERCOM_SESSION_NAME");
		let typedContactSupervisorRegistered = hasSubagentIntercomEnv();

		const heavyReplyWaitMayDetach = (name: string, params: { action?: string; reason?: string }): boolean => {
			const active = controller.active;
			if (!active) return true;
			const predicate = active.captured.tools.get(name)?.detachable;
			return typeof predicate === "function" ? predicate(params) : predicate !== false;
		};

		const activateTypedContactSupervisor = (): void => {
			const activeTools = atomic.getActiveTools();
			if (!activeTools.includes("contact_supervisor")) atomic.setActiveTools([...activeTools, "contact_supervisor"]);
		};

		const registerTypedContactSupervisor = (): void => {
			if (!typedContactSupervisorRegistered) {
				typedContactSupervisorRegistered = true;
				controller.markStaticSurface("tool", "contact_supervisor");
				atomic.registerTool({
					name: "contact_supervisor",
					exposure: "model-only",
					detachable: (params) =>
						contactSupervisorCallMayDetach(params) && heavyReplyWaitMayDetach("contact_supervisor", params),
					detachmentRequiresReady: true,
					label: "Contact Supervisor",
					description: CONTACT_SUPERVISOR_DESCRIPTION,
					promptSnippet: CONTACT_SUPERVISOR_PROMPT_SNIPPET,
					promptGuidelines: CONTACT_SUPERVISOR_PROMPT_GUIDELINES,
					parameters: createContactSupervisorParameters(),
					execute: (...args) => controller.executeTool("contact_supervisor", args),
					renderCall: (...args) => renderCallFallback(controller, "contact_supervisor", args),
					renderResult: (...args) => renderResultFallback(controller, "contact_supervisor", args),
				});
			}
			activateTypedContactSupervisor();
		};

		// Off-first-prompt startup join timer: activates packages/intercom in the background a few seconds
		// after startup so top-level interactive sessions stay discoverable without loading Intercom at startup.
		type DormantStartupJoin = {
			timer: ReturnType<typeof setTimeout> | null;
			waitingForTrust: boolean;
			settled: boolean;
			ctx: ExtensionContext;
		};
		let dormantJoin: DormantStartupJoin | null = null;
		let everSawAgentStart = false;
		const cancelDormantJoin = (): void => {
			if (dormantJoin?.timer) clearTimeout(dormantJoin.timer);
			dormantJoin = null;
		};
		controller.onDormantShutdown(() => {
			cancelDormantJoin();
			everSawAgentStart = false;
		});

		const triggerImplStartupJoin = async (ctx: ExtensionContext): Promise<void> => {
			const handle = await controller.activate(ctx, { background: true });
			handle.assertCurrent();
			const request: { completion?: Promise<void> } = {};
			await controller.dispatchBusEvent(INTERCOM_STARTUP_JOIN_EVENT, request);
			if (!request.completion) throw new Error("Intercom cannot join at startup");
			await request.completion;
		};

		const scheduleDormantStartupJoin = (ctx: ExtensionContext, attempt = 0, startupSettled = false): void => {
			cancelDormantJoin();
			const entry: DormantStartupJoin = {
				timer: null,
				waitingForTrust: false,
				settled: startupSettled || everSawAgentStart,
				ctx,
			};
			dormantJoin = entry;
			entry.timer = setTimeout(
				() => {
					entry.timer = null;
					if (dormantJoin !== entry || !controller.isCurrentLease()) return;
					if (!entry.settled && !everSawAgentStart && !projectTrusted(ctx)) {
						if (attempt < STARTUP_JOIN_RETRIES) scheduleDormantStartupJoin(ctx, attempt + 1);
						if (dormantJoin) dormantJoin.waitingForTrust = true;
						return;
					}
					triggerImplStartupJoin(ctx).then(
						() => {
							if (dormantJoin === entry) dormantJoin = null;
						},
						() => {
							if (dormantJoin !== entry || !controller.isCurrentLease()) return;
							if (attempt >= STARTUP_JOIN_RETRIES) dormantJoin = null;
							else scheduleDormantStartupJoin(ctx, attempt + 1, entry.settled || everSawAgentStart);
						},
					);
				},
				attempt === 0 ? STARTUP_JOIN_DELAY_MS : reconnectDelayMs(attempt - 1),
			);
			entry.timer.unref?.();
		};

		controller.onSessionStart(async (_event, ctx) => {
			cancelDormantJoin();
			everSawAgentStart = false;
			const typedIdentity = ctx.subagentPolicy?.intercom;
			if (typedIdentity) {
				if (typedIdentity.sessionName && typeof atomic.setSessionName === "function") {
					await atomic.setSessionName(typedIdentity.sessionName);
				}
				registerTypedContactSupervisor();
				// Admitted subagent children register on Intercom before their first turn.
				await controller.activate(ctx);
				return;
			}
			if (inheritedDelegatedSessionName && typeof atomic.setSessionName === "function") {
				await atomic.setSessionName(inheritedDelegatedSessionName);
			}
			// A resumed session with existing Intercom history activates the lightweight wrapper so custom
			// intercom_message cards and tool renderers have their rich components immediately.
			try {
				if (hasIntercomHistory(ctx.sessionManager.getEntries())) {
					await controller.activate(ctx);
					return;
				}
			} catch {
				// Partial context without sessionManager entries stays dormant.
			}
			if (
				!controller.active &&
				startupJoinFromEnv() !== false &&
				!hasSubagentIntercomEnv() &&
				!inheritedDelegatedSessionName &&
				joinsIntercomAtStartup(ctx, () =>
					typeof atomic.getActiveTools === "function" ? atomic.getActiveTools() : [],
				)
			) {
				scheduleDormantStartupJoin(ctx);
			}
		});

		controller.onAgentStart(() => {
			everSawAgentStart = true;
			const pending = dormantJoin;
			if (pending && !pending.settled && controller.isCurrentLease()) {
				if (pending.waitingForTrust) scheduleDormantStartupJoin(pending.ctx, 0, true);
				else pending.settled = true;
			}
		});

		atomic.on("session_recovery_restore", async (event, ctx) => {
			let needsIntercom = false;
			try {
				needsIntercom = hasIntercomHistory(ctx.sessionManager.getEntries());
			} catch {
				needsIntercom = false;
			}
			if (!needsIntercom && !controller.active) return undefined;
			await controller.activate(ctx);
			return (await controller.dispatchHandlers("session_recovery_restore", event, ctx)) as
				| { notices?: string[] }
				| undefined;
		});

		atomic.on("session_recovery_replay", async (event, ctx) => {
			if (!event.pending.some((delivery) => delivery.customType === "intercom_message")) return undefined;
			await controller.activate(ctx);
			return (await controller.dispatchHandlers("session_recovery_replay", event, ctx)) as
				| import("../types.ts").SessionRecoveryReplayResult
				| undefined;
		});

		// Bus requests that require activating Intercom when dormant.
		for (const channel of [
			SUBAGENT_SUPERVISOR_AUTHORIZATION_EVENT,
			SUBAGENT_AWAIT_INTERCOM_PEER_EVENT,
			SUBAGENT_RESERVE_RESTORING_CHILD_EVENT,
			SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT,
		] as const) {
			atomic.events.on(channel, (payload) => {
				if (!isObjectRecord(payload) || payload.completion) return;
				if (controller.active) {
					void controller.dispatchBusEvent(channel, payload);
					return;
				}
				const forwarded = { ...payload };
				payload.completion = controller
					.activate(controller.latestContext())
					.then(async (handle) => {
						handle.assertCurrent();
						await controller.dispatchBusEvent(channel, forwarded);
						return forwarded.completion ? await (forwarded.completion as Promise<unknown>) : undefined;
					})
					.catch((error: unknown) => {
						if (channel === SUBAGENT_AWAIT_INTERCOM_PEER_EVENT) return false;
						throw error;
					});
			});
		}

		// Bus requests for active broker holds/reservations: no-op when Intercom never activated.
		for (const channel of [
			SUBAGENT_DROP_RELEASED_CHILDREN_EVENT,
			SUBAGENT_ACKNOWLEDGE_RELEASED_CHILD_WAKE_EVENT,
			SUBAGENT_MARK_ENDED_CHILDREN_EVENT,
			SUBAGENT_RELEASE_RESTORING_CHILD_EVENT,
		] as const) {
			atomic.events.on(channel, (payload) => {
				if (!isObjectRecord(payload) || payload.completion) return;
				if (!controller.active) {
					payload.completion = Promise.resolve();
					return;
				}
				void controller.dispatchBusEvent(channel, payload);
			});
		}

		// Background subagent control & result relays.
		for (const channel of [SUBAGENT_CONTROL_INTERCOM_EVENT, SUBAGENT_RESULT_INTERCOM_EVENT] as const) {
			atomic.events.on(channel, (payload) => {
				if (controller.active) {
					void controller.dispatchBusEvent(channel, payload);
					return;
				}
				void controller
					.activate(controller.latestContext())
					.then(async (handle) => {
						handle.assertCurrent();
						await controller.dispatchBusEvent(channel, payload);
					})
					.catch((error: unknown) => {
						rejectLazyResultRelay(atomic, channel, payload, error);
					});
			});
		}

		// Synchronous released-reply formatting protocol.
		atomic.events.on(RELEASED_REPLY_FORMAT_EVENT, (payload) => {
			if (!isReleasedReplyFormatRequest(payload) || payload.result !== undefined) return;
			const active = controller.active;
			if (active) {
				for (const handler of active.captured.eventHandlers.get(RELEASED_REPLY_FORMAT_EVENT) ?? []) {
					handler(payload);
					if (payload.result !== undefined) return;
				}
			}
			payload.result = formatDormantReleasedReply(payload);
		});

		atomic.registerTool({
			name: "intercom",
			exposure: "model-only",
			scriptAccess: intercomScriptAccess,
			detachable: (params) => intercomCallMayDetach(params) && heavyReplyWaitMayDetach("intercom", params),
			detachmentRequiresReady: true,
			label: "Intercom",
			description: INTERCOM_DESCRIPTION,
			promptSnippet: INTERCOM_PROMPT_SNIPPET,
			parameters: createIntercomParameters(),
			execute: (...args) => controller.executeTool("intercom", args),
			renderCall: (...args) => renderCallFallback(controller, "intercom", args),
			renderResult: (...args) => renderResultFallback(controller, "intercom", args),
		});

		atomic.registerMessageRenderer(ENDED_CHILD_WAKE_MESSAGE_TYPE, (message, options, theme) => {
			const loaded = controller.active?.captured.messageRenderers.get(ENDED_CHILD_WAKE_MESSAGE_TYPE);
			if (loaded) return loaded(message, options, theme);
			return renderDormantIntercomWakeMessage(message, options, theme);
		});

		atomic.registerMessageRenderer("intercom_message", (message, options, theme) => {
			const loaded = controller.active?.captured.messageRenderers.get("intercom_message");
			if (loaded) return loaded(message, options, theme);
			const content = typeof message.content === "string" ? message.content : "";
			return new Text(theme.fg("toolOutput", content), 0, 0);
		});

		atomic.registerToolRenderer((toolName, next) => {
			const registered = next();
			if (registered?.renderCall || registered?.renderResult || registered?.renderShell === "self")
				return registered;
			if (toolName === "contact_supervisor") {
				return {
					...registered,
					renderCall: (...args) => renderCallFallback(controller, "contact_supervisor", args),
					renderResult: (...args) => renderResultFallback(controller, "contact_supervisor", args),
				};
			}
			if (toolName === "intercom") {
				return {
					...registered,
					renderCall: (...args) => renderCallFallback(controller, "intercom", args),
					renderResult: (...args) => renderResultFallback(controller, "intercom", args),
				};
			}
			return registered;
		});

		if (hasSubagentIntercomEnv()) {
			atomic.registerTool({
				name: "contact_supervisor",
				exposure: "model-only",
				detachable: (params) =>
					contactSupervisorCallMayDetach(params) && heavyReplyWaitMayDetach("contact_supervisor", params),
				detachmentRequiresReady: true,
				label: "Contact Supervisor",
				description: CONTACT_SUPERVISOR_DESCRIPTION,
				promptSnippet: CONTACT_SUPERVISOR_PROMPT_SNIPPET,
				promptGuidelines: CONTACT_SUPERVISOR_PROMPT_GUIDELINES,
				parameters: createContactSupervisorParameters(),
				execute: (...args) => controller.executeTool("contact_supervisor", args),
				renderCall: (...args) => renderCallFallback(controller, "contact_supervisor", args),
				renderResult: (...args) => renderResultFallback(controller, "contact_supervisor", args),
			});
		}

		atomic.registerShortcut("alt+m", {
			description: "Open session intercom overlay",
			handler: (ctx) => controller.runShortcut("alt+m", ctx),
		});

		atomic.registerCommand("intercom", {
			description: "Open session intercom overlay",
			handler: (args, ctx) => controller.runCommand("intercom", args, ctx),
		});
	},
};
