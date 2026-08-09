import { afterEach, describe, expect, it, vi } from "vitest";
import {
	checkForNewPiVersion,
	comparePackageVersions,
	formatVersionCheckError,
	getLatestPiRelease,
	getLatestPiVersion,
	isDevVersion,
	isNewerPackageVersion,
} from "../src/utils/version-check.ts";

const originalSkipVersionCheck = process.env.ATOMIC_SKIP_VERSION_CHECK;
const originalOffline = process.env.ATOMIC_OFFLINE;

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	if (originalSkipVersionCheck === undefined) {
		delete process.env.ATOMIC_SKIP_VERSION_CHECK;
	} else {
		process.env.ATOMIC_SKIP_VERSION_CHECK = originalSkipVersionCheck;
	}
	if (originalOffline === undefined) {
		delete process.env.ATOMIC_OFFLINE;
	} else {
		process.env.ATOMIC_OFFLINE = originalOffline;
	}
});

describe("version checks", () => {
	it("compares package versions", () => {
		expect(comparePackageVersions("0.70.6", "0.70.5")).toBeGreaterThan(0);
		expect(comparePackageVersions("0.70.5", "0.70.5")).toBe(0);
		expect(comparePackageVersions("0.70.4", "0.70.5")).toBeLessThan(0);
		expect(comparePackageVersions("5.0.0-beta.20", "5.0.0-beta.9")).toBeGreaterThan(0);
		expect(isNewerPackageVersion("0.70.5", "0.70.5")).toBe(false);
		expect(isNewerPackageVersion("0.70.6", "0.70.5")).toBe(true);
	});

	it("returns only newer versions", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "1.2.3" }));
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
		await expect(checkForNewPiVersion("1.2.2")).resolves.toBe("1.2.3");
	});

	it("retries a transient version request when explicitly requested", async () => {
		const fetchMock = vi
			.fn()
			.mockRejectedValueOnce(new Error("fetch failed"))
			.mockRejectedValueOnce(new Error("fetch failed"))
			.mockResolvedValueOnce(Response.json({ version: "1.2.4" }));
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

		await expect(getLatestPiRelease({ retry: true })).resolves.toEqual({ version: "1.2.4" });
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("keeps automatic version checks to one request", async () => {
		const fetchMock = vi.fn().mockRejectedValue(new Error("fetch failed"));
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("formats nested network error details", () => {
		const error = new Error("fetch failed", {
			cause: new AggregateError([
				Object.assign(new Error("connect timeout"), { code: "ETIMEDOUT" }),
				Object.assign(new Error("network unreachable"), { code: "ENETUNREACH" }),
			]),
		});

		expect(formatVersionCheckError(error)).toBe("fetch failed (ETIMEDOUT, ENETUNREACH)");
	});

	it("queries the npm registry for the package's latest version", async () => {
		const fetchMock = vi.fn(async () => Response.json({ name: "@bastani/atomic", version: "1.2.4" }));
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

		await expect(getLatestPiVersion()).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledWith(
			"https://registry.npmjs.org/@bastani/atomic/latest",
			expect.objectContaining({
				headers: expect.objectContaining({
					accept: "application/json",
				}),
			}),
		);
	});

	it("returns the package name from the registry response", async () => {
		const fetchMock = vi.fn(async () => Response.json({ name: "@bastani/atomic", version: "1.2.4" }));
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

		await expect(getLatestPiRelease()).resolves.toEqual({ packageName: "@bastani/atomic", version: "1.2.4" });
	});

	it.each(["ATOMIC_SKIP_VERSION_CHECK", "PI_SKIP_VERSION_CHECK"])(
		"skips automatic api calls when %s is set",
		async (name) => {
			vi.stubEnv(name, "1");
			const fetchMock = vi.fn(async () => Response.json({ version: "1.2.4" }));
			vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

			await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it.each(["ATOMIC_SKIP_VERSION_CHECK", "PI_SKIP_VERSION_CHECK"])(
		"allows explicit release checks when %s disables startup checks",
		async (name) => {
			vi.stubEnv(name, "1");
			const fetchMock = vi.fn(async () => Response.json({ version: "1.2.4" }));
			vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

			await expect(getLatestPiVersion()).resolves.toBe("1.2.4");
			expect(fetchMock).toHaveBeenCalledOnce();
		},
	);

	it("treats the versionless placeholder as a dev build", () => {
		expect(isDevVersion("0.0.0")).toBe(true);
		expect(isDevVersion(" 0.0.0 ")).toBe(true);
		expect(isDevVersion("1.2.3")).toBe(false);
		expect(isDevVersion("0.0.1")).toBe(false);
	});

	it("does not nag dev builds (0.0.0) for updates", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "1.2.3" }));
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

		await expect(checkForNewPiVersion("0.0.0")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
