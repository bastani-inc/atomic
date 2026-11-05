import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
	isManagedToolDownloadError,
	isManagedToolError,
	isManagedToolTimeoutError,
	isRetryableManagedToolError,
	ManagedToolDownloadError,
	type ManagedToolDownloadFields,
	ManagedToolError,
	ManagedToolTimeoutError,
} from "../src/utils/managed-tool-errors.ts";

const RELEASE_URL = "https://github.com/BurntSushi/ripgrep/releases/latest";
const ARCHIVE_URL =
	"https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-x86_64-pc-windows-msvc.zip";
const DOWNLOAD_HINT =
	"Check that github.com is reachable from this machine and try again, or install ripgrep with your system package manager.";

describe("managed tool download errors (#4389)", () => {
	it.each<[ManagedToolDownloadFields, string]>([
		[
			{
				tool: "rg",
				phase: "resolve-version",
				url: RELEASE_URL,
				detail: "fetch failed: getaddrinfo ENOTFOUND github.com",
			},
			`Could not download ripgrep: resolving the latest release at ${RELEASE_URL} failed: fetch failed: getaddrinfo ENOTFOUND github.com (download-failed). ${DOWNLOAD_HINT}`,
		],
		[
			{ tool: "rg", phase: "download", url: ARCHIVE_URL, httpStatus: 404 },
			`Could not download ripgrep: downloading ${ARCHIVE_URL} failed with HTTP 404 (download-failed). ${DOWNLOAD_HINT}`,
		],
		[
			{ tool: "fd", phase: "download", url: ARCHIVE_URL },
			`Could not download fd: downloading ${ARCHIVE_URL} failed (download-failed). Check that github.com is reachable from this machine and try again, or install fd with your system package manager.`,
		],
	])("renders the download failure and its remediation (%o)", (fields, message) => {
		const error = new ManagedToolDownloadError(fields);
		assert.equal(error.message, message);
		assert.equal(error.hint, message.slice(message.indexOf("Check")));
	});

	it("renders a timeout with its limit and elapsed time", () => {
		const error = new ManagedToolTimeoutError({
			tool: "rg",
			phase: "resolve-version",
			url: RELEASE_URL,
			timeoutMs: 10_000,
			elapsedMs: 10_004,
		});
		assert.equal(
			error.message,
			`Could not download ripgrep: resolving the latest release at ${RELEASE_URL} did not finish within 10000ms (stopped after 10004ms) (download-timeout). Check the network connection to github.com and try again, or install ripgrep with your system package manager.`,
		);
		assert.equal(
			error.hint,
			"Check the network connection to github.com and try again, or install ripgrep with your system package manager.",
		);
	});

	it("carries a stable name, code, fields and cause", () => {
		const cause = new TypeError("fetch failed");
		const fields: ManagedToolDownloadFields = {
			tool: "rg",
			phase: "download",
			url: ARCHIVE_URL,
			detail: "fetch failed",
		};
		const download = new ManagedToolDownloadError(fields, { cause });
		assert.ok(download instanceof ManagedToolError);
		assert.equal(download.name, "ManagedToolDownloadError");
		assert.equal(download.code, "download-failed");
		assert.equal(download.fields, fields);
		assert.equal(download.cause, cause);

		const timeout = new ManagedToolTimeoutError(
			{ tool: "fd", phase: "download", url: ARCHIVE_URL, timeoutMs: 120_000, elapsedMs: 120_001 },
			{ cause },
		);
		assert.ok(timeout instanceof ManagedToolError);
		assert.equal(timeout.name, "ManagedToolTimeoutError");
		assert.equal(timeout.code, "download-timeout");
		assert.equal(timeout.retryable, true);
		assert.equal(timeout.cause, cause);
	});

	it.each<[number | undefined, boolean]>([
		[undefined, true],
		[408, true],
		[425, true],
		[429, true],
		[500, true],
		[502, true],
		[503, true],
		[504, true],
		[200, false],
		[302, false],
		[403, false],
		[404, false],
		[501, false],
	])("marks a download failure with HTTP status %s retryable: %s", (httpStatus, retryable) => {
		const error = new ManagedToolDownloadError({
			tool: "rg",
			phase: "download",
			url: ARCHIVE_URL,
			...(httpStatus === undefined ? {} : { httpStatus }),
		});
		assert.equal(error.retryable, retryable);
		assert.equal(isRetryableManagedToolError(error), retryable);
	});

	it("recognizes errors from other realms by name and code", () => {
		const download = { name: "ManagedToolDownloadError", code: "download-failed" };
		const timeout = { name: "ManagedToolTimeoutError", code: "download-timeout" };
		assert.ok(isManagedToolDownloadError(download));
		assert.ok(isManagedToolTimeoutError(timeout));
		assert.ok(isManagedToolError(download));
		assert.ok(isManagedToolError(timeout));
		assert.ok(!isManagedToolDownloadError(timeout));
		assert.ok(!isManagedToolTimeoutError(download));
		assert.ok(!isManagedToolDownloadError({ name: "ManagedToolDownloadError", code: "download-timeout" }));
		assert.ok(!isManagedToolTimeoutError({ name: "ManagedToolTimeoutError", code: "download-failed" }));
		assert.ok(!isManagedToolError({ name: "GitUnavailableError", code: "download-failed" }));
		const namedFunction = Object.assign(function ManagedToolDownloadError() {}, { code: "download-failed" });
		for (const value of [undefined, null, "ManagedToolDownloadError", namedFunction, new Error("download-failed")])
			assert.ok(!isManagedToolError(value));
	});

	it("finds a retryable failure anywhere in a bounded cause chain", () => {
		const timeout = new ManagedToolTimeoutError({
			tool: "rg",
			phase: "resolve-version",
			url: RELEASE_URL,
			timeoutMs: 10_000,
			elapsedMs: 10_000,
		});
		const wrapped = new Error("grep failed", { cause: new Error("ensureTool failed", { cause: timeout }) });
		assert.ok(isRetryableManagedToolError(wrapped));
		assert.ok(
			isRetryableManagedToolError({ name: "ManagedToolTimeoutError", code: "download-timeout", retryable: true }),
		);
		assert.ok(
			!isRetryableManagedToolError(
				new Error("outer", {
					cause: new ManagedToolDownloadError({
						tool: "rg",
						phase: "download",
						url: ARCHIVE_URL,
						httpStatus: 404,
					}),
				}),
			),
		);

		let deep: Error = timeout;
		for (let depth = 0; depth < 8; depth++) deep = new Error(`wrapper ${depth}`, { cause: deep });
		assert.ok(!isRetryableManagedToolError(deep));
		const circular = new Error("circular");
		Object.assign(circular, { cause: circular });
		assert.ok(!isRetryableManagedToolError(circular));
		assert.ok(!isRetryableManagedToolError("download-timeout"));
		assert.ok(!isRetryableManagedToolError(undefined));
		assert.ok(!isRetryableManagedToolError(null));
	});
});
