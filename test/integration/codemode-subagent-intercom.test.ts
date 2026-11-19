import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseFactory, fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { afterAll, beforeAll, test, vi } from "vitest";
import { IntercomBrokerFixture } from "../helpers/intercom-broker-fixture.js";

const broker = new IntercomBrokerFixture(mkdtempSync(join(tmpdir(), "script-peers-")));
broker.overrideAgentDir();
const { createCodemodeExtension } = await import("../../packages/coding-agent/src/extensions/codemode/index.js");
const { createHarness, getMessageText } = await import("../../packages/coding-agent/test/suite/harness.js");
const { default: subagents } = await import("../../packages/subagents/src/extension/index.js");
const { default: intercom } = await import("../../packages/intercom/index.js");

const BROKER_AND_CHILD_START_MS = 90_000;
beforeAll(() => broker.startSourceBroker(BROKER_AND_CHILD_START_MS - 5000), BROKER_AND_CHILD_START_MS);
afterAll(() => broker.cleanup());

test(
	"two children admitted by a script exchange a message over their Intercom group",
	async () => {
		// Use real SDK child sessions, not the subagent runner's NODE_ENV=test model stub.
		vi.stubEnv("NODE_ENV", "development");
		const h = await createHarness({
			extensionFactories: [createCodemodeExtension(), subagents, intercom],
			initialActiveToolNames: ["codemode", "subagent"],
			childSessions: {
				agentDir: broker.agentDir,
				builtins: { workflows: false, subagents: false, intercom: true, mcp: false, "web-access": false },
			},
		});
		const target = Promise.withResolvers<string>();
		const receiving = Promise.withResolvers<void>();
		const sent = Promise.withResolvers<void>();
		let peerRead = false;
		try {
			await h.session.bindExtensions({ mode: "print" });
			const respond: FauxResponseFactory = async ({ messages }) => {
				const first = messages.find((m) => m.role === "user");
				const task = getMessageText(first);
				if (task.startsWith("Receiver task")) {
					receiving.resolve();
					if (messages.some((m) => getMessageText(m).includes("verified-by-the-peer"))) peerRead = true;
					await sent.promise;
					return fauxAssistantMessage("Receiver finished");
				}
				if (task.startsWith("Sender task")) {
					if (messages.some((m) => m.role === "toolResult" && m.toolName === "intercom")) {
						sent.resolve();
						return fauxAssistantMessage("Sender finished");
					}
					await receiving.promise;
					return fauxAssistantMessage(
						fauxToolCall("intercom", {
							action: "send",
							to: await target.promise,
							message: "verified-by-the-peer",
						}),
						{ stopReason: "toolUse" },
					);
				}
				return fauxAssistantMessage("Parent finished");
			};
			h.setResponses([
				fauxAssistantMessage(
					fauxToolCall("codemode", {
						code: `return (await tools.subagent({group:true, context:'fresh', tasks:[{agent:'worker',task:'Receiver task',progress:false},{agent:'worker',task:'Sender task',progress:false}]})).tasks`,
					}),
					{ stopReason: "toolUse" },
				),
				...Array.from({ length: 30 }, () => respond),
			]);
			await h.session.prompt("Start peers");
			const message = h.session.messages.find((m) => m.role === "toolResult" && m.toolName === "codemode");
			assert(message?.role === "toolResult" && !message.isError, getMessageText(message));
			const [receiver, sender] = JSON.parse(getMessageText(message).split("\n").at(-1)!);
			assert.ok(receiver.intercomTarget);
			assert.notEqual(receiver.intercomTarget, sender.intercomTarget);
			target.resolve(receiver.intercomTarget);
			await vi.waitFor(
				() =>
					assert.ok(
						peerRead,
						h.sessionManager
							.getEntries()
							.filter((e) => e.type === "custom_message")
							.map(getMessageText)
							.join("\n"),
					),
				{ timeout: 30000 },
			);
		} finally {
			target.resolve("");
			receiving.resolve();
			sent.resolve();
			await h.cleanup();
			vi.unstubAllEnvs();
		}
	},
	BROKER_AND_CHILD_START_MS,
);
