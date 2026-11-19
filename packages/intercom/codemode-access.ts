import type { ToolScriptAccess } from "@bastani/atomic";
import type { JsonValue } from "@bastani/atomic-ai";
import { Type } from "typebox";
import { normalizeGroups } from "./group.js";
import type { SessionInfo } from "./types.js";

/** #5087: the Intercom actions codemode scripts may call. The rest stay model-only. */
export const INTERCOM_SCRIPT_ACTIONS = ["list", "status", "pending", "send"] as const;

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

export const intercomScriptOutputSchema = Type.Union([
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

const MODEL_ONLY_HINT = `Scripts may call intercom only with ${INTERCOM_SCRIPT_ACTIONS.map((action) => `"${action}"`).join(", ")}; call the intercom tool directly for anything else.`;

/** Why a codemode script may not make this Intercom call, or `undefined` when it may. */
export function refuseIntercomScriptCall(params: { action: string; to?: string; replyTo?: string }): string | undefined {
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

export const intercomScriptAccess: ToolScriptAccess<{ action: string; to?: string; replyTo?: string }> = {
	description: `Coordinate with other local agent sessions that share an intercom group. Scripts may use these actions; the others (ask, reply, cancel, join, leave, groups) are model-only.
- { action: "list", group? }: sessions visible through your groups, or one group's sessions with group, as { sessionId, name?, cwd, state, activity?, groups, replyCapability?, self }.
- { action: "status", group? }: your session id, groups, the visible sessions, and how many of your asks await a reply.
- { action: "pending" }: unanswered asks sent to you (inbound) and your asks awaiting a reply (outbound).
- { action: "send", to, message, attachments?, delivery? }: send to one exact target: a live session name, or a full session id or unique 8-hex prefix. Globs, "*" and "subagents:" targets are refused. Resolves to { target, outcome, messageId?, reason? }, where outcome is "delivered", "queued", "refused", "unknown" (do not resend automatically) or "cancelled".`,
	outputSchema: intercomScriptOutputSchema,
	refuse: refuseIntercomScriptCall,
};

/** One session as scripts see it. */
export function scriptSessionEntry(session: SessionInfo, selfId: string | null | undefined): JsonValue {
	const entry: Record<string, JsonValue> = { sessionId: session.id };
	if (session.name) entry.name = session.name;
	entry.cwd = session.cwd;
	const status = session.status?.trim();
	const activity = status ? (status.split(" · ")[0] ?? status) : undefined;
	entry.state = activity === undefined ? "unknown" : activity === "idle" ? "idle" : "busy";
	if (activity !== undefined && activity !== "idle") entry.activity = activity;
	entry.groups = [...normalizeGroups(session.groups, session.group)];
	if (session.replyCapability !== undefined) entry.replyCapability = session.replyCapability;
	entry.self = session.id === selfId;
	return entry;
}

/** The delivery outcome of one exact-target send, from its result. */
export function scriptSendOutcome(
	target: string,
	result: { content: Array<{ text: string }>; isError: boolean; details: Record<string, unknown> },
): JsonValue {
	const { details } = result;
	const outcome: Record<string, JsonValue> = { action: "send", target };
	if (typeof details.messageId === "string") outcome.messageId = details.messageId;
	if (!result.isError) {
		outcome.outcome = details.queued === true ? "queued" : details.delivered === true ? "delivered" : "cancelled";
		return outcome;
	}
	outcome.outcome = details.outcome === "unknown" ? "unknown" : "refused";
	outcome.reason =
		typeof details.reason === "string" ? details.reason : result.content.map(({ text }) => text).join("\n");
	return outcome;
}
