import type { WaitPolicy } from "@bastani/atomic";
import { Type } from "typebox";

/** #4751: an `ask`'s `wait`, with bash's field names and semantics. */
export const askWaitSchema = Type.Unsafe<WaitPolicy>({
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

export const askIdSchema = Type.String({
	description: "For 'cancel': the id (or a unique prefix) of one of your pending asks, as 'ask' or 'pending' reported it",
});

/** What the tool description says about `ask`, shared by the lightweight and loaded registrations. */
export const ASK_DESCRIPTION = `\`ask\` never blocks you: it returns once the question is delivered, with an ask id and whether the recipient is
idle or busy. A reply that comes within the wait (\`wait\` as in bash: omitted waits up to the automatic yield,
\`{ kind: "foreground", budgetMs }\` up to the budget, \`{ kind: "background" }\` not at all) is returned inline;
otherwise the ask stays pending with no expiry and its reply arrives later as a message starting
"Reply to your ask <id> from <name>", which starts a turn when you are idle or arrives after your current tool call.
A refusal or a recipient that ended arrives the same way as a failed-ask message. Do not re-ask while one is pending.`;

export const ASK_USAGE = `  intercom({ action: "ask", to: "session-name", message: "..." })   → Ask; reply inline if quick, else later as a message
  intercom({ action: "ask", to: "session-name", message: "...", wait: { kind: "background" } }) → Ask without waiting
  intercom({ action: "cancel", askId: "..." })                       → Cancel one of your pending asks`;

export const ASK_PROMPT_SNIPPET =
	'`ask` does not block: a reply that misses the wait arrives later as a message ("Reply to your ask <id> from <name>").';

/** Validate an `ask`'s `wait`, with bash's field names and semantics. */
export function parseAskWait(value: unknown): WaitPolicy | undefined | Error {
	if (value === undefined) return undefined;
	const invalid = new Error(
		'Invalid ask wait: expected { kind: "background" } or { kind: "foreground", budgetMs? } with a finite non-negative budgetMs',
	);
	if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid;
	const wait = value as { kind?: unknown; budgetMs?: unknown };
	if (Object.keys(wait).some((key) => key !== "kind" && (wait.kind !== "foreground" || key !== "budgetMs")))
		return invalid;
	if (wait.kind === "background") return { kind: "background" };
	if (wait.kind !== "foreground") return invalid;
	if (wait.budgetMs === undefined) return { kind: "foreground" };
	if (typeof wait.budgetMs !== "number" || !Number.isFinite(wait.budgetMs) || wait.budgetMs < 0) return invalid;
	return { kind: "foreground", budgetMs: wait.budgetMs };
}
