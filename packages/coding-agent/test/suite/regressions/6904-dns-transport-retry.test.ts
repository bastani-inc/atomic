import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createHarness } from "../harness.ts";

const dnsErrors = [
	"The pending stream has been canceled (caused by: getaddrinfo ENOTFOUND bedrock-runtime.us-east-1.amazonaws.com)",
	"fetch failed: ENOTFOUND api.example.com",
	"request failed: EAI_AGAIN api.example.com",
] as const;

describe("issue #6904 DNS transport failure retry", () => {
	it.each(dnsErrors)("retries bounded transient DNS failure: %s", async (errorMessage) => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 0 } } });
		try {
			harness.setResponses([
				fauxAssistantMessage("", { stopReason: "error", errorMessage }),
				fauxAssistantMessage("recovered after DNS retry"),
			]);

			await harness.session.prompt("test");

			expect(harness.faux.state.callCount).toBe(2);
			expect(harness.eventsOfType("auto_retry_start").map((event) => event.errorMessage)).toEqual([errorMessage]);
			expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([true]);
		} finally {
			harness.cleanup();
		}
	});

	it("stops after the configured DNS retry bound", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 } } });
		try {
			const errorMessage = dnsErrors[0];
			harness.setResponses(
				Array.from({ length: 4 }, () => fauxAssistantMessage("", { stopReason: "error", errorMessage })),
			);

			await harness.session.prompt("test");

			expect(harness.faux.state.callCount).toBe(3);
			expect(harness.eventsOfType("auto_retry_start")).toHaveLength(2);
			expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([false]);
		} finally {
			harness.cleanup();
		}
	});
});
