import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

function countImagesInCurrentUserMessage(messages: AgentMessage[]): number {
	const currentUser = messages.filter((message) => message.role === "user").at(-1);
	return currentUser?.role === "user" && typeof currentUser.content !== "string"
		? currentUser.content.filter((part) => part.type === "image").length
		: 0;
}

describe("AgentSession image prompt handling", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("attaches images for back-to-back image prompts", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const firstImagePath = join(harness.tempDir, "first.png");
		const secondImagePath = join(harness.tempDir, "second.png");
		writeFileSync(firstImagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
		writeFileSync(secondImagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
		const currentUserImageCounts: number[] = [];

		harness.setResponses([
			(context) => {
				currentUserImageCounts.push(countImagesInCurrentUserMessage(context.messages));
				return fauxAssistantMessage("first ok");
			},
			(context) => {
				currentUserImageCounts.push(countImagesInCurrentUserMessage(context.messages));
				return fauxAssistantMessage("second ok");
			},
		]);

		await harness.session.prompt(`${firstImagePath} first image`);
		await harness.session.prompt(`${secondImagePath} second image`);

		expect(currentUserImageCounts).toEqual([1, 1]);
		expect(getMessageText(harness.session.messages[2]!)).toContain(`<file name="${secondImagePath}">`);
	});
});
