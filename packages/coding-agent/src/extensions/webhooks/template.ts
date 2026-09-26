/**
 * Turns a notification into a request body.
 *
 * The pipeline is deliberately dumb: build a flat map of placeholder name to
 * string, walk the destination's JSON body template, replace `{{name}}` inside
 * string values, and serialise the result with `JSON.stringify`. Because the
 * template is parsed JSON rather than text, a message containing quotes or
 * newlines can never break the request, and because replacement is a single
 * pass, a message containing a literal `{{...}}` is inserted as text rather
 * than expanded again. Nothing here evaluates expressions; there is no way to
 * run code from a template.
 *
 * The default `{{message}}` is the multi-line summary from the issue:
 *
 *     Atomic: Workflow needs input
 *     Project: storefront
 *     Session: Checkout fixes
 *     Workflow: Review checkout changes
 *     Details: Proceed with the migration?
 *
 * A line whose value is absent is left out, never rendered as `undefined`.
 * `{{details}}` is bounded, so rich never means a transcript.
 */
import { WEBHOOK_DETAILS_LIMIT, WEBHOOK_PLACEHOLDERS, type WebhookPlaceholder } from "./constants.ts";
import { presetBodyFor } from "./presets.ts";
import type { JsonValue, WebhookDestination, WebhookMessageContext } from "./types.ts";

const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
/** C0 controls except tab, LF and CR, plus DEL. */
// biome-ignore lint/complexity/useRegexLiterals: a regex literal written with \u escapes reached the file as raw control bytes through the editing tool; the string form keeps them as escapes
const CONTROL_CHARACTERS = new RegExp("[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]", "g");

/** The headline, then one `Label: value` line per present field. */
export function renderWebhookMessage(context: WebhookMessageContext): string {
	const lines = [renderWebhookHeadline(context)];
	const field = (label: string, value: string | undefined) => {
		if (value !== undefined && value.length > 0) lines.push(`${label}: ${value}`);
	};
	field("Project", context.project);
	field("Session", context.session);
	field("Workflow", context.workflow);
	field("Stage", context.stage);
	field("Run", context.runId);
	field("Model", context.model);
	field("Details", boundDetails(context.details));
	return lines.join("\n");
}

/**
 * The first line of the message on its own, `Atomic: <what happened>`, so an
 * envelope with a title slot (a Teams card title, a Slack block header) can
 * carry it apart from the body. The prefix says who sent it; the rest is the
 * event, with `agent_stopped` reading differently for an abort and an error.
 */
export function renderWebhookHeadline(context: WebhookMessageContext): string {
	return `Atomic: ${headlineFor(context)}`;
}

function headlineFor(context: WebhookMessageContext): string {
	switch (context.event) {
		case "agent_finished":
			return "Main agent finished";
		case "agent_needs_input":
			return "Main agent needs your input";
		case "agent_stopped":
			return context.outcome === "aborted" ? "Main agent was stopped" : "Main agent stopped with an error";
		case "workflow_completed":
			return "Workflow completed";
		case "workflow_needs_input":
			return "Workflow needs input";
		case "workflow_blocked":
			return "Workflow is blocked";
		case "workflow_failed":
			return "Workflow failed";
	}
}

/**
 * The flat placeholder map. Every documented placeholder is present, absent
 * context rendering as "", so a template never sees a hole. `escapeText` is applied
 * to every value for destinations whose receiver treats text as markup.
 */
export function placeholderValues(
	context: WebhookMessageContext,
	escapeText: (value: string) => string = (value) => value,
): Record<WebhookPlaceholder, string> {
	const raw: Record<WebhookPlaceholder, string> = {
		headline: renderWebhookHeadline(context),
		message: renderWebhookMessage(context),
		event: context.event,
		outcome: context.outcome,
		project: context.project ?? "",
		session: context.session ?? "",
		sessionId: context.sessionId ?? "",
		workflow: context.workflow ?? "",
		runId: context.runId ?? "",
		stage: context.stage ?? "",
		model: context.model ?? "",
		details: boundDetails(context.details) ?? "",
		time: new Date(context.at).toISOString(),
	};
	for (const key of WEBHOOK_PLACEHOLDERS) raw[key] = escapeText(raw[key]);
	return raw;
}

/**
 * Replace `{{name}}` in every string value of a parsed JSON template. Keys are
 * never substituted, and non-string leaves pass through untouched. An unknown
 * placeholder renders as "" rather than being left in the request, so a typo
 * shows up as a blank field at the receiver instead of a literal `{{typo}}`.
 * Single pass: replacement text is inserted verbatim and never rescanned.
 */
export function substitutePlaceholders(template: JsonValue, values: Readonly<Record<string, string>>): JsonValue {
	if (typeof template === "string") {
		return template.replace(PLACEHOLDER_PATTERN, (_match, name: string) => values[name] ?? "");
	}
	if (Array.isArray(template)) return template.map((item) => substitutePlaceholders(item, values));
	if (template !== null && typeof template === "object") {
		const out: Record<string, JsonValue> = {};
		for (const [key, value] of Object.entries(template)) out[key] = substitutePlaceholders(value, values);
		return out;
	}
	return template;
}

/**
 * Slack parses `&`, `<` and `>` as control characters in text, so they must be
 * sent as entities or a response containing `<div>` renders broken. Applied to
 * every placeholder value of a Slack destination, including a user-customised
 * body, since any string field Slack renders is mrkdwn.
 */
export function escapeSlackText(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** The serialised request body for a destination: its own template, or the preset for its type. */
export function renderWebhookBody(
	destination: Pick<WebhookDestination, "type" | "body">,
	context: WebhookMessageContext,
): string {
	const escapeText = destination.type === "slack" ? escapeSlackText : undefined;
	const template = destination.body ?? presetBodyFor(destination.type);
	return JSON.stringify(substitutePlaceholders(template, placeholderValues(context, escapeText)));
}

/**
 * Trim, drop control characters that are not line structure (a model's output
 * can carry terminal escapes; a receiver should never get them), collapse to
 * the limit with an ellipsis. The limit counts code points, not UTF-16 units,
 * so a cut can never split a surrogate pair and hand the receiver a lone half
 * that renders as a replacement character.
 */
export function boundDetails(details: string | undefined, limit: number = WEBHOOK_DETAILS_LIMIT): string | undefined {
	if (details === undefined) return undefined;
	const cleaned = details.replace(CONTROL_CHARACTERS, "").trim();
	if (cleaned.length === 0) return undefined;
	const points = Array.from(cleaned);
	if (points.length <= limit) return cleaned;
	return `${points.slice(0, limit - 1).join("")}…`;
}
