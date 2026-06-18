import { afterEach, describe, expect, it, vi } from "vitest";
import {
	checkForNewPiVersion,
	comparePackageVersions,
	getLatestPiRelease,
	getLatestPiVersion,
	isNewerPackageVersion,
} from "../src/utils/version-check.ts";

const originalSkipVersionCheck = process.env.ATOMIC_SKIP_VERSION_CHECK;
const originalOffline = process.env.ATOMIC_OFFLINE;

afterEach(() => {
	vi.restoreAllMocks();
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

	it("skips api calls when version checks are disabled", async () => {
		process.env.ATOMIC_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn(async () => Response.json({}));
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

		await expect(getLatestPiVersion()).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
