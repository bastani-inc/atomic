/**
 * Request bodies for the Slack and Teams presets, the default body for a custom
 * destination, and the starter document the settings screen writes for a fresh
 * file.
 *
 * Every body here is a template: string values may contain `{{placeholders}}`
 * that {@link renderWebhookBody} fills in. Presets are plain data, not code, so a
 * user can copy one into `webhooks.json`, change a field, and get the same
 * treatment as the built-in.
 *
 * Vendor contracts these encode, verified 2026-09-15:
 *
 * - Slack incoming webhooks accept `{ "text": "..." }`, rendered as mrkdwn, where
 *   `&`, `<` and `>` must be sent as `&amp;`, `&lt;` and `&gt;`. Newlines render.
 *   (docs.slack.dev/messaging/formatting-message-text)
 * - Teams Workflows "When a Teams webhook request is received" accepts POST only,
 *   with a `message` carrying one Adaptive Card attachment. The `contentUrl: null`
 *   and card version `1.2` are Microsoft's own example verbatim. With the "Anyone"
 *   authentication option no auth header may be sent; tenant-restricted flows need
 *   a token the user adds to `headers` by hand. (learn.microsoft.com/connectors/teams)
 */
import { WEBHOOK_EVENT_IDS, WEBHOOK_TIMEOUT_MS_DEFAULT, type WebhookDestinationType } from "./constants.ts";
import type { JsonObject, JsonValue } from "./types.ts";

/** Slack: one `text` field, mrkdwn. */
export function slackPresetBody(): JsonObject {
	return { text: "{{message}}" };
}

/** Teams Workflows: a message with a single Adaptive Card. `wrap` keeps long lines readable. */
export function teamsPresetBody(): JsonObject {
	return {
		type: "message",
		attachments: [
			{
				contentType: "application/vnd.microsoft.card.adaptive",
				contentUrl: null,
				content: {
					$schema: "http://adaptivecards.io/schemas/adaptive-card.json",
					type: "AdaptiveCard",
					version: "1.2",
					body: [{ type: "TextBlock", text: "{{message}}", wrap: true }],
				},
			},
		],
	};
}

/**
 * Custom destinations get every field as its own key, so a receiver can route on
 * `event` or `outcome` without parsing prose. Absent context renders as "".
 */
export function customPresetBody(): JsonObject {
	return {
		event: "{{event}}",
		outcome: "{{outcome}}",
		headline: "{{headline}}",
		message: "{{message}}",
		project: "{{project}}",
		session: "{{session}}",
		sessionId: "{{sessionId}}",
		workflow: "{{workflow}}",
		runId: "{{runId}}",
		stage: "{{stage}}",
		model: "{{model}}",
		details: "{{details}}",
		time: "{{time}}",
	};
}

/** The body used when a destination does not set its own. */
export function presetBodyFor(type: WebhookDestinationType): JsonValue {
	switch (type) {
		case "slack":
			return slackPresetBody();
		case "teams":
			return teamsPresetBody();
		default:
			return customPresetBody();
	}
}

/**
 * A complete custom destination showing every field, for the docs and the
 * custom-webhook help screen. It is never written into the file on the user's
 * behalf: a fresh file starts empty, so the settings list shows nothing until
 * the user adds something. `enabled: false` and an `.invalid` host mean that
 * pasting it verbatim sends nothing.
 */
export function exampleCustomDestination(): JsonObject {
	return {
		name: "My service",
		type: "custom",
		enabled: false,
		events: [...WEBHOOK_EVENT_IDS],
		url: "https://example.invalid/atomic-webhook",
		method: "POST",
		headers: { Authorization: "Bearer REPLACE_ME" },
		body: customPresetBody(),
		timeoutMs: WEBHOOK_TIMEOUT_MS_DEFAULT,
	};
}
