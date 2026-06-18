/**
 * Verify the documentation compaction hook examples compile with the deletion-shaped contract.
 */

import { describe, expect, it } from "vitest";
import type { ExtensionAPI, SessionBeforeCompactEvent, SessionCompactEvent } from "../src/core/extensions/index.ts";

describe("Documentation example", () => {
	it("deletion-shaped compaction before hook should type-check correctly", () => {
		const exampleExtension = (pi: ExtensionAPI) => {
			pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx) => {
				const { preparation, branchEntries, reason } = event;
				const { sessionManager, modelRegistry } = ctx;

				expect(Array.isArray(preparation.transcript.entries)).toBe(true);
				expect(Array.isArray(preparation.transcript.protectedEntryIds)).toBe(true);
				expect(typeof preparation.transcript.tokensBefore).toBe("number");
				expect(Array.isArray(branchEntries)).toBe(true);
				expect(["manual", "threshold", "overflow"]).toContain(reason);
				expect(typeof sessionManager.getEntries).toBe("function");
				expect(typeof modelRegistry.getApiKeyAndHeaders).toBe("function");

				const deletable = preparation.transcript.entries.find((entry) => !entry.protected);
				if (!deletable) return undefined;

				return {
					deletionRequest: {
						deletions: [{ kind: "entry", entryId: deletable.entryId }],
					},
				};
			});
		};

		expect(typeof exampleExtension).toBe("function");
	});

	it("compact event should expose context compaction result fields", () => {
		const checkCompactEvent = (pi: ExtensionAPI) => {
			pi.on("session_compact", async (event: SessionCompactEvent) => {
				const entry = event.contextCompactionEntry;
				const result = event.result;

				expect(entry.type).toBe("context_compaction");
				expect(entry.deletedTargets).toBe(result.deletedTargets);
				expect(entry.stats).toBe(result.stats);
				expect(typeof event.fromExtension).toBe("boolean");
				expect(["manual", "threshold", "overflow"]).toContain(event.reason);
			});
		};

		expect(typeof checkCompactEvent).toBe("function");
	});
});
