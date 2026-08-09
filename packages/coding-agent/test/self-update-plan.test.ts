import { afterEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "../src/config.ts";
import { resolveSelfUpdatePlan } from "../src/self-update-plan.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("self-update plans", () => {
	it("retries transient version checks before planning a forced update", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockRejectedValueOnce(new Error("fetch failed"))
			.mockRejectedValueOnce(new Error("fetch failed"))
			.mockResolvedValueOnce(Response.json({ version: VERSION }));

		await expect(resolveSelfUpdatePlan(true)).resolves.toMatchObject({ version: VERSION, shouldRun: true });
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});
});
