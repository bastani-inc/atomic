/**
 * Message templates and presets (`src/extensions/webhooks/template.ts`,
 * `src/extensions/webhooks/presets.ts`).
 *
 * Issue #2345: a structured JSON template is parsed, string placeholders are
 * substituted in one pass, and the result is serialised with a JSON library, so
 * quotes and newlines in a message can never break the request and nothing in a
 * template is ever executed. Absent context is omitted, never `undefined`.
 * Excerpts are bounded. The Slack preset escapes Slack's control characters;
 * the Teams preset matches Microsoft's documented Adaptive Card envelope.
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { parseWebhooksDocument } from "../../packages/coding-agent/src/extensions/webhooks/config.js";
import {
	WEBHOOK_DETAILS_LIMIT,
	WEBHOOK_EVENT_IDS,
	WEBHOOK_EVENT_OUTCOMES,
	WEBHOOK_PLACEHOLDERS,
	WEBHOOK_TIMEOUT_MS_DEFAULT,
	WEBHOOKS_CONFIG_VERSION,
} from "../../packages/coding-agent/src/extensions/webhooks/constants.js";
import {
	customPresetBody,
	exampleCustomDestination,
	presetBodyFor,
	slackPresetBody,
	teamsPresetBody,
} from "../../packages/coding-agent/src/extensions/webhooks/presets.js";
import {
	boundDetails,
	escapeSlackText,
	placeholderValues,
	renderWebhookBody,
	renderWebhookHeadline,
	renderWebhookMessage,
	substitutePlaceholders,
} from "../../packages/coding-agent/src/extensions/webhooks/template.js";
import type {
	WebhookDestination,
	WebhookEventOutcome,
	WebhookMessageContext,
	WebhookMessageFields,
} from "../../packages/coding-agent/src/extensions/webhooks/types.js";

const AT = Date.UTC(2026, 8, 15, 12, 30, 0);

/** A context for one event pair (default: a workflow asking for input) with the given fields. */
function context(
	over: Partial<WebhookMessageFields> = {},
	pair: WebhookEventOutcome = { event: "workflow_needs_input", outcome: "needs_input" },
): WebhookMessageContext {
	return { ...pair, at: AT, ...over };
}

const control = (...codes: number[]) => codes.map((code) => String.fromCharCode(code)).join("");

describe("renderWebhookMessage", () => {
	test("renders the issue's illustration line for line", () => {
		const message = renderWebhookMessage(
			context({
				project: "storefront",
				session: "Checkout fixes",
				workflow: "Review checkout changes",
				details: "Proceed with the migration?",
			}),
		);
		assert.equal(
			message,
			[
				"Atomic: Workflow needs input",
				"Project: storefront",
				"Session: Checkout fixes",
				"Workflow: Review checkout changes",
				"Details: Proceed with the migration?",
			].join("\n"),
		);
	});

	test("omits every absent field rather than rendering undefined or an empty label", () => {
		const message = renderWebhookMessage(context({}, { event: "agent_finished", outcome: "completed" }));
		assert.equal(message, "Atomic: Main agent finished");
		assert.ok(!message.includes("undefined"));
		assert.ok(!message.includes(":\n"));
	});

	test("headlines cover every event, agent_stopped tells an abort from an error, and the headline is the message's first line", () => {
		const headline = (pair: WebhookEventOutcome) => {
			const line = renderWebhookHeadline(context({ project: "storefront" }, pair));
			assert.equal(renderWebhookMessage(context({ project: "storefront" }, pair)).split("\n")[0], line);
			return line;
		};
		assert.equal(headline({ event: "agent_finished", outcome: "completed" }), "Atomic: Main agent finished");
		assert.equal(
			headline({ event: "agent_needs_input", outcome: "needs_input" }),
			"Atomic: Main agent needs your input",
		);
		assert.equal(headline({ event: "agent_stopped", outcome: "error" }), "Atomic: Main agent stopped with an error");
		assert.equal(headline({ event: "agent_stopped", outcome: "aborted" }), "Atomic: Main agent was stopped");
		assert.equal(headline({ event: "workflow_completed", outcome: "completed" }), "Atomic: Workflow completed");
		assert.equal(headline({ event: "workflow_needs_input", outcome: "needs_input" }), "Atomic: Workflow needs input");
		assert.equal(headline({ event: "workflow_blocked", outcome: "blocked" }), "Atomic: Workflow is blocked");
		assert.equal(headline({ event: "workflow_failed", outcome: "failed" }), "Atomic: Workflow failed");
	});

	test("the outcome table names every event, and an outcome the table does not allow is a type error", () => {
		assert.deepEqual(Object.keys(WEBHOOK_EVENT_OUTCOMES), [...WEBHOOK_EVENT_IDS]);
		for (const event of WEBHOOK_EVENT_IDS) assert.ok(WEBHOOK_EVENT_OUTCOMES[event].length > 0, event);
		// The pair below is refused at compile time; root tsc covers this file, so
		// the directive fails the typecheck if the constraint is ever loosened.
		// @ts-expect-error agent_finished cannot carry an error outcome
		const refused: WebhookMessageContext = { event: "agent_finished", outcome: "error", at: AT };
		assert.equal(refused.event, "agent_finished");
	});

	test("field order is project, session, workflow, stage, run, model, details", () => {
		const message = renderWebhookMessage(
			context({
				project: "p",
				session: "s",
				workflow: "w",
				stage: "verify",
				runId: "run-1",
				model: "claude-opus-5",
				details: "d",
			}),
		);
		assert.deepEqual(
			message
				.split("\n")
				.slice(1)
				.map((line) => line.split(":")[0]),
			["Project", "Session", "Workflow", "Stage", "Run", "Model", "Details"],
		);
	});
});

describe("placeholderValues", () => {
	test("every documented placeholder is present, absent context is an empty string, time is ISO UTC", () => {
		const values = placeholderValues(context());
		assert.deepEqual(Object.keys(values).sort(), [...WEBHOOK_PLACEHOLDERS].sort());
		assert.equal(values.project, "");
		assert.equal(values.workflow, "");
		assert.equal(values.event, "workflow_needs_input");
		assert.equal(values.outcome, "needs_input");
		assert.equal(values.time, "2026-09-15T12:30:00.000Z");
		assert.equal(values.message, "Atomic: Workflow needs input");
		assert.equal(values.headline, "Atomic: Workflow needs input");
	});

	test("an escape function is applied to every value, including the composed message", () => {
		const values = placeholderValues(context({ project: "a<b" }), (value) => value.toUpperCase());
		assert.equal(values.project, "A<B");
		assert.equal(values.message, "ATOMIC: WORKFLOW NEEDS INPUT\nPROJECT: A<B");
	});
});

describe("substitutePlaceholders", () => {
	test("replaces placeholders in strings at any depth and leaves other leaves and keys alone", () => {
		const out = substitutePlaceholders(
			{
				text: "Hi {{name}}",
				"{{name}}": "keys are not substituted",
				nested: { list: ["{{name}}", 1, true, null, { deep: "{{ name }}" }] },
				count: 42,
			},
			{ name: "Mark" },
		);
		assert.deepEqual(out, {
			text: "Hi Mark",
			"{{name}}": "keys are not substituted",
			nested: { list: ["Mark", 1, true, null, { deep: "Mark" }] },
			count: 42,
		});
	});

	test("an unknown placeholder renders empty rather than leaking the braces to the receiver", () => {
		assert.equal(substitutePlaceholders("a {{typo}} b", {}), "a  b");
	});

	test("single pass: a value containing braces is inserted as text, never expanded", () => {
		const out = substitutePlaceholders("{{details}}", { details: "use {{message}} here", message: "BOOM" });
		assert.equal(out, "use {{message}} here");
	});

	test("does not mutate the template", () => {
		const template = { text: "{{message}}" };
		substitutePlaceholders(template, { message: "x" });
		assert.deepEqual(template, { text: "{{message}}" });
	});
});

describe("renderWebhookBody", () => {
	test("quotes, newlines and backslashes in the message cannot break the JSON body", () => {
		const details = 'She said "yes"\nthen \\ left';
		const body = renderWebhookBody({ type: "custom" }, context({ details }));
		const parsed = JSON.parse(body) as Record<string, string>;
		assert.equal(parsed.details, details);
		assert.ok(parsed.message.endsWith(`Details: ${details}`));
	});

	test("a destination's own body wins over the preset for its type", () => {
		const body = renderWebhookBody(
			{ type: "slack", body: { blocks: [{ type: "section", text: { type: "mrkdwn", text: "*{{event}}*" } }] } },
			context(),
		);
		assert.deepEqual(JSON.parse(body), {
			blocks: [{ type: "section", text: { type: "mrkdwn", text: "*workflow_needs_input*" } }],
		});
	});

	test("Slack destinations escape &, < and > in every value, including a custom body", () => {
		const body = renderWebhookBody({ type: "slack" }, context({ details: "<div> & </div>" }));
		const parsed = JSON.parse(body) as { text: string };
		assert.ok(parsed.text.endsWith("Details: &lt;div&gt; &amp; &lt;/div&gt;"));
		assert.ok(!parsed.text.includes("<div>"));
		const custom = renderWebhookBody({ type: "slack", body: { text: "{{details}}" } }, context({ details: "a<b" }));
		assert.equal((JSON.parse(custom) as { text: string }).text, "a&lt;b");
	});

	test("Teams and custom destinations are not escaped", () => {
		const teams = JSON.parse(renderWebhookBody({ type: "teams" }, context({ details: "a<b" }))) as {
			attachments: Array<{ content: { body: Array<{ text: string }> } }>;
		};
		assert.ok(teams.attachments[0]!.content.body[0]!.text.endsWith("Details: a<b"));
		const custom = JSON.parse(renderWebhookBody({ type: "custom" }, context({ details: "a<b" }))) as {
			details: string;
		};
		assert.equal(custom.details, "a<b");
	});
});

describe("escapeSlackText", () => {
	test("replaces exactly Slack's three control characters", () => {
		assert.equal(escapeSlackText("a & b < c > d \"e\" 'f'"), "a &amp; b &lt; c &gt; d \"e\" 'f'");
	});
});

describe("boundDetails", () => {
	test("trims, strips control characters other than tab and newline, and cuts to the limit with an ellipsis", () => {
		assert.equal(boundDetails("  hello  "), "hello");
		assert.equal(boundDetails(`a${control(0, 7, 27)}b${control(9)}c${control(10)}d${control(127)}`), "ab\tc\nd");
		assert.equal(boundDetails(control(0, 1, 2)), undefined);
		assert.equal(boundDetails(undefined), undefined);
		const long = "x".repeat(WEBHOOK_DETAILS_LIMIT + 100);
		const bounded = boundDetails(long);
		assert.equal(bounded?.length, WEBHOOK_DETAILS_LIMIT);
		assert.ok(bounded?.endsWith("…"));
		assert.equal(boundDetails("x".repeat(WEBHOOK_DETAILS_LIMIT)), "x".repeat(WEBHOOK_DETAILS_LIMIT));
	});

	test("the limit counts code points, so a cut never leaves half of a surrogate pair", () => {
		// An astral character is two UTF-16 units; counting units would either
		// cut it in half at the boundary or reject a string that fits.
		const astral = String.fromCodePoint(0x1f600);
		assert.equal(astral.length, 2, "the fixture must be a surrogate pair");
		const fits = `${"x".repeat(WEBHOOK_DETAILS_LIMIT - 1)}${astral}`;
		assert.equal(boundDetails(fits), fits, "exactly limit code points is not cut");
		const cutAtPair = `${"x".repeat(WEBHOOK_DETAILS_LIMIT - 1)}${astral}y`;
		const bounded = boundDetails(cutAtPair) ?? "";
		assert.ok(bounded.isWellFormed(), "no lone surrogate may reach the receiver");
		assert.equal(Array.from(bounded).length, WEBHOOK_DETAILS_LIMIT);
		assert.ok(bounded.endsWith("…"));
	});
});

describe("presets", () => {
	test("Slack: the documented incoming-webhook shape", () => {
		assert.deepEqual(slackPresetBody(), { text: "{{message}}" });
	});

	test("Teams: Microsoft's Workflows envelope, verbatim fields", () => {
		const body = teamsPresetBody() as {
			type: string;
			attachments: Array<{ contentType: string; contentUrl: null; content: Record<string, unknown> }>;
		};
		assert.equal(body.type, "message");
		assert.equal(body.attachments.length, 1);
		const [attachment] = body.attachments;
		assert.equal(attachment!.contentType, "application/vnd.microsoft.card.adaptive");
		assert.equal(attachment!.contentUrl, null);
		assert.equal(attachment!.content.$schema, "http://adaptivecards.io/schemas/adaptive-card.json");
		assert.equal(attachment!.content.type, "AdaptiveCard");
		assert.equal(attachment!.content.version, "1.2");
		assert.deepEqual(attachment!.content.body, [{ type: "TextBlock", text: "{{message}}", wrap: true }]);
	});

	test("custom: one key per placeholder so a receiver can route without parsing prose", () => {
		assert.deepEqual(Object.keys(customPresetBody()).sort(), [...WEBHOOK_PLACEHOLDERS].sort());
		for (const [key, value] of Object.entries(customPresetBody())) assert.equal(value, `{{${key}}}`);
	});

	test("presetBodyFor maps each type to its body", () => {
		assert.deepEqual(presetBodyFor("slack"), slackPresetBody());
		assert.deepEqual(presetBodyFor("teams"), teamsPresetBody());
		assert.deepEqual(presetBodyFor("custom"), customPresetBody());
	});

	test("the documented custom example validates, is disabled, and points nowhere real", () => {
		const parsed = parseWebhooksDocument({
			version: WEBHOOKS_CONFIG_VERSION,
			destinations: [exampleCustomDestination()],
		});
		assert.equal(parsed.kind, "current");
		assert.ok(parsed.kind === "current");
		assert.deepEqual(parsed.diagnostics, []);
		const [destination] = parsed.destinations as WebhookDestination[];
		assert.equal(destination!.enabled, false);
		assert.ok(new URL(destination!.url).hostname.endsWith(".invalid"));
		assert.equal(destination!.events.length, WEBHOOK_EVENT_IDS.length);
		assert.equal(
			destination!.timeoutMs,
			WEBHOOK_TIMEOUT_MS_DEFAULT,
			"the example shows the default the sender applies",
		);
	});
});
