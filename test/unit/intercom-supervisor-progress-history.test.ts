import assert from "node:assert/strict";
import { test } from "vitest";
import {
	buildIncomingCustomMessage,
	frameHistoricalSupervisorUpdate,
} from "../../packages/intercom/incoming-message-delivery.js";
import type { InboundMessageEntry } from "../../packages/intercom/intercom-utils.js";

// #3039: presentation cannot narrow accepted identity, timestamp or raw-content shapes.
test("supervisor snapshots preserve permissive identities, attachments and verbatim bodies", () => {
	for (const text of ["", " \n\t", "修正: earlier hypothesis wrong\n  keep spaces  "]) {
		for (const timestamp of [0, 1, Number.MAX_VALUE, Number.NaN]) {
			for (const source of [undefined, { subagentRunId: "arbitrary run / λ", subagentAgent: "worker?" }]) {
				const entry: InboundMessageEntry = {
					from: {
						id: "arbitrary id",
						name: "",
						cwd: "/repo",
						model: "test",
						pid: 1,
						startedAt: 1,
						lastActivity: 1,
					},
					message: {
						id: "not-a-uuid",
						timestamp,
						source,
						content: {
							text,
							attachments: [{ type: "snippet", name: "same", content: "  raw attachment\n", language: "ts" }],
						},
					},
					channel: "supervisor",
					replyCommand: "unchanged",
					bodyText: text,
				};
				const framed = frameHistoricalSupervisorUpdate(entry);
				assert.strictEqual(framed.from, entry.from);
				assert.strictEqual(framed.message, entry.message);
				assert.equal(framed.replyCommand, entry.replyCommand);
				assert.equal(entry.bodyText, text);
				assert.equal(entry.message.content.text, text);
				assert.ok(framed.bodyText.endsWith(`\n\n${text}`));
				const date = new Date(timestamp);
				assert.ok(
					framed.bodyText.includes(
						`Sent: ${Number.isNaN(date.getTime()) ? String(timestamp) : date.toISOString()}`,
					),
				);
				assert.match(buildIncomingCustomMessage(framed).content, /not current task status/);
			}
		}
	}
});
