import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
	attachGitCleanupFailure,
	findGitProvisionError,
	GIT_MINIMUM_VERSION,
	GitProvisionConfigError,
	GitProvisionError,
	GitProvisionTimeoutError,
	GitUnavailableError,
	type GitUnavailableFields,
	isGitProvisionConfigError,
	isGitProvisionError,
	isGitProvisionTimeoutError,
	isGitUnavailableError,
	isRetryableGitProvisionError,
	rehydrateGitProvisionError,
	type SerializedGitProvisionError,
} from "../src/utils/git-errors.js";

const HOST = { platform: "linux", arch: "x64" } as const;

const CHECKSUM_FIELDS: GitUnavailableFields = {
	...HOST,
	code: "checksum-mismatch",
	asset: "dugite-native-v2.56.0-a44aeca-ubuntu-x64.tar.gz",
	url: "https://github.com/desktop/dugite-native/releases/download/v2.56.0-2/dugite-native-v2.56.0-a44aeca-ubuntu-x64.tar.gz",
	expectedSha256: "1efd8ce0516b670b6b6d0f49ecaf395ceb8cf7fff3f5857259763d97a1238df9",
	actualSha256: "0000000000000000000000000000000000000000000000000000000000000000",
};

describe("git provisioning errors (#4322)", () => {
	it("pins the minimum system git version", () => {
		assert.equal(GIT_MINIMUM_VERSION, "2.30.0");
	});

	it.each<[string, GitUnavailableFields, string, string]>([
		[
			"unsupported musl target",
			{
				code: "unsupported-platform",
				reason: "musl",
				platform: "linux",
				arch: "x64",
				libc: "musl",
				installCommand: "apk add git",
			},
			"Git is unavailable: automatic provisioning does not support linux/x64 with musl (unsupported-platform). Install git 2.30.0 or newer with `apk add git`.",
			"Install git 2.30.0 or newer with `apk add git`.",
		],
		[
			"unsupported architecture without a command",
			{ code: "unsupported-platform", reason: "architecture", platform: "linux", arch: "ppc64" },
			"Git is unavailable: automatic provisioning does not support linux/ppc64 (unsupported-platform). Install git 2.30.0 or newer with your system package manager (https://git-scm.com/downloads).",
			"Install git 2.30.0 or newer with your system package manager (https://git-scm.com/downloads).",
		],
		[
			"offline with an old system git",
			{
				code: "offline",
				offlineVariable: "ATOMIC_OFFLINE",
				platform: "linux",
				arch: "x64",
				systemGit: { path: "/usr/bin/git", problem: "below-minimum", version: "2.25.1" },
			},
			"Git is unavailable: ATOMIC_OFFLINE is set, so no portable git is downloaded; /usr/bin/git is git 2.25.1, older than 2.30.0 (offline). Unset ATOMIC_OFFLINE so Atomic can download a portable git, or install git 2.30.0 or newer with your system package manager (https://git-scm.com/downloads).",
			"Unset ATOMIC_OFFLINE so Atomic can download a portable git, or install git 2.30.0 or newer with your system package manager (https://git-scm.com/downloads).",
		],
		[
			"not installed after a failed probe",
			{
				...HOST,
				code: "not-installed",
				installDir: "/home/u/.atomic/agent/bin/git",
				systemGit: { path: "/usr/bin/git", problem: "probe-failed" },
			},
			"Git is unavailable: no git 2.30.0 or newer is on PATH; /usr/bin/git did not report a usable git version, and no portable git is installed in /home/u/.atomic/agent/bin/git (not-installed). Call resolveGit() to download a portable git (interactive Atomic does this at startup), or install git 2.30.0 or newer with your system package manager (https://git-scm.com/downloads).",
			"Call resolveGit() to download a portable git (interactive Atomic does this at startup), or install git 2.30.0 or newer with your system package manager (https://git-scm.com/downloads).",
		],
		[
			"checksum mismatch",
			CHECKSUM_FIELDS,
			`Git is unavailable: ${CHECKSUM_FIELDS.code === "checksum-mismatch" ? CHECKSUM_FIELDS.asset : ""} has SHA-256 0000000000000000000000000000000000000000000000000000000000000000, expected 1efd8ce0516b670b6b6d0f49ecaf395ceb8cf7fff3f5857259763d97a1238df9; nothing was installed (checksum-mismatch). Check for a proxy or firewall that alters downloads from github.com, or install git 2.30.0 or newer with your system package manager (https://git-scm.com/downloads).`,
			"Check for a proxy or firewall that alters downloads from github.com, or install git 2.30.0 or newer with your system package manager (https://git-scm.com/downloads).",
		],
		[
			"download failure",
			{ ...HOST, code: "download-failed", asset: "a.tar.gz", url: "https://example.test/a.tar.gz", httpStatus: 404 },
			"Git is unavailable: a.tar.gz could not be downloaded (HTTP 404) (download-failed). Check that github.com is reachable from this machine and try again, or install git 2.30.0 or newer with your system package manager (https://git-scm.com/downloads).",
			"Check that github.com is reachable from this machine and try again, or install git 2.30.0 or newer with your system package manager (https://git-scm.com/downloads).",
		],
		[
			"extraction failure",
			{
				...HOST,
				code: "install-failed",
				phase: "extract",
				asset: "a.tar.gz",
				installDir: "/agent/bin/git",
				detail: "tar exited with status 2",
			},
			"Git is unavailable: a.tar.gz could not be extracted into /agent/bin/git: tar exited with status 2 (install-failed). Check free disk space and write access to /agent/bin/git and try again, or install git 2.30.0 or newer with your system package manager (https://git-scm.com/downloads).",
			"Check free disk space and write access to /agent/bin/git and try again, or install git 2.30.0 or newer with your system package manager (https://git-scm.com/downloads).",
		],
		[
			"verification failure",
			{ ...HOST, code: "install-failed", phase: "verify", asset: "a.tar.gz", installDir: "/agent/bin/git" },
			"Git is unavailable: a.tar.gz could not be verified into /agent/bin/git (install-failed). Check cached files and read/execute access in /agent/bin/git; if this system cannot run the portable build, install git 2.30.0 or newer with your system package manager (https://git-scm.com/downloads).",
			"Check cached files and read/execute access in /agent/bin/git; if this system cannot run the portable build, install git 2.30.0 or newer with your system package manager (https://git-scm.com/downloads).",
		],
	])("renders %s from its fields with the remediation as hint", (_label, fields, message, hint) => {
		const error = new GitUnavailableError(fields);
		assert.equal(error.message, message);
		assert.equal(error.hint, hint);
		assert.equal(error.name, "GitUnavailableError");
		assert.equal(error.code, fields.code);
		assert.deepEqual(error.fields, fields);
		assert.ok(error instanceof GitProvisionError);
		assert.ok(isGitUnavailableError(error));
		assert.ok(isGitProvisionError(error));
	});

	it.each([
		["stage", "staged"],
		["promote", "installed"],
	] as const)("names the %s phase in install failures", (phase, verb) => {
		const error = new GitUnavailableError({
			...HOST,
			code: "install-failed",
			phase,
			asset: "a.tar.gz",
			installDir: "/d",
		});
		assert.equal(
			error.message,
			`Git is unavailable: a.tar.gz could not be ${verb} into /d (install-failed). Check free disk space and write access to /d and try again, or install git 2.30.0 or newer with your system package manager (https://git-scm.com/downloads).`,
		);
	});

	it.each([
		[undefined, true],
		[408, true],
		[425, true],
		[429, true],
		[500, true],
		[502, true],
		[503, true],
		[504, true],
		[403, false],
		[404, false],
		[501, false],
	])("marks a download failure with HTTP %s retryable=%s", (httpStatus, retryable) => {
		const error = new GitUnavailableError({
			...HOST,
			code: "download-failed",
			asset: "a",
			url: "u",
			...(httpStatus === undefined ? {} : { httpStatus }),
		});
		assert.equal(error.retryable, retryable);
		assert.equal(isRetryableGitProvisionError(error), retryable);
	});

	it.each<GitUnavailableFields>([
		CHECKSUM_FIELDS,
		{ code: "offline", offlineVariable: "ATOMIC_OFFLINE", platform: "linux", arch: "x64" },
		{ code: "unsupported-platform", reason: "platform", platform: "aix", arch: "ppc64" },
		{ ...HOST, code: "not-installed", installDir: "/d" },
		{ ...HOST, code: "install-failed", phase: "extract", asset: "a", installDir: "/d" },
	])("never marks $code retryable", (fields) => {
		assert.equal(new GitUnavailableError(fields).retryable, false);
	});

	it("renders a typed timeout with its phase and timings", () => {
		const error = new GitProvisionTimeoutError({ phase: "download", timeoutMs: 600000, elapsedMs: 600012 });
		assert.equal(
			error.message,
			"Git provisioning timed out: download did not finish within 600000ms (stopped after 600012ms) (provision-timeout). Check the network connection to github.com and try again, or install git 2.30.0 or newer with your system package manager (https://git-scm.com/downloads).",
		);
		assert.equal(error.name, "GitProvisionTimeoutError");
		assert.equal(error.code, "provision-timeout");
		assert.equal(error.retryable, true);
		assert.deepEqual(error.fields, { phase: "download", timeoutMs: 600000, elapsedMs: 600012 });
		assert.ok(isGitProvisionTimeoutError(error));
		assert.ok(!isGitUnavailableError(error));
	});

	it("renders a configuration error naming source and field", () => {
		const error = new GitProvisionConfigError({ source: "sdk", field: "signal", expected: "an AbortSignal" });
		assert.equal(
			error.message,
			"Invalid git resolution option: signal from sdk must be an AbortSignal (invalid-option). Pass an AbortSignal or omit signal.",
		);
		assert.equal(error.hint, "Pass an AbortSignal or omit signal.");
		assert.equal(error.name, "GitProvisionConfigError");
		assert.equal(error.code, "invalid-option");
		assert.equal(error.retryable, false);
		assert.ok(isGitProvisionConfigError(error));
		assert.ok(!isGitProvisionTimeoutError(error));
	});

	it("matches errors from another realm by name and code", () => {
		const foreign = { name: "GitUnavailableError", code: "offline", message: "m" };
		assert.ok(isGitUnavailableError(foreign));
		assert.ok(isGitProvisionError(foreign));
		assert.ok(!isGitUnavailableError({ name: "GitUnavailableError", code: "made-up" }));
		assert.ok(!isGitUnavailableError({ name: "OtherError", code: "offline" }));
		assert.ok(!isGitUnavailableError({ name: "GitUnavailableError", code: 7 }));
		assert.ok(isGitProvisionTimeoutError({ name: "GitProvisionTimeoutError", code: "provision-timeout" }));
		assert.ok(!isGitProvisionTimeoutError({ name: "GitProvisionTimeoutError", code: "offline" }));
		assert.ok(isGitProvisionConfigError({ name: "GitProvisionConfigError", code: "invalid-option" }));
		assert.ok(!isGitProvisionConfigError({ name: "GitProvisionConfigError", code: "offline" }));
		assert.ok(isGitProvisionError({ name: "GitProvisionError", code: "anything" }));
		assert.ok(!isGitProvisionError({ name: "Error", code: "offline" }));
		assert.ok(!isGitProvisionError(null));
		assert.ok(!isGitProvisionError("GitUnavailableError"));
		assert.ok(!isGitProvisionError(undefined));
	});

	it("finds a git error in a bounded cause chain", () => {
		const root = new GitUnavailableError({ ...HOST, code: "not-installed", installDir: "/d" });
		const wrap = (cause: Error, depth: number): Error =>
			depth === 0 ? cause : wrap(new Error(`wrapper ${depth}`, { cause }), depth - 1);
		assert.equal(findGitProvisionError(wrap(root, 7)), root);
		assert.equal(findGitProvisionError(wrap(root, 8)), undefined);
		assert.equal(findGitProvisionError(new Error("plain")), undefined);
		assert.equal(findGitProvisionError("text"), undefined);
		const retryable = new GitProvisionTimeoutError({ phase: "lock", timeoutMs: 1, elapsedMs: 1 });
		assert.ok(isRetryableGitProvisionError(wrap(retryable, 7)));
		assert.ok(!isRetryableGitProvisionError(wrap(retryable, 8)));
		assert.ok(!isRetryableGitProvisionError(wrap(root, 3)));
		assert.ok(!isRetryableGitProvisionError(undefined));
	});

	it("keeps the primary error and attaches the cleanup failure", () => {
		const primary = new GitUnavailableError(CHECKSUM_FIELDS);
		const cleanup = new Error("EBUSY: rmdir");
		attachGitCleanupFailure(primary, cleanup);
		attachGitCleanupFailure(primary, new Error("second"));
		assert.equal(primary.cleanupCause, cleanup);
		assert.equal(primary.code, "checksum-mismatch");
		assert.equal(Object.keys(primary).includes("cleanupCause"), false);
		const fromString = new GitUnavailableError(CHECKSUM_FIELDS);
		attachGitCleanupFailure(fromString, "disk gone");
		assert.equal(fromString.cleanupCause?.message, "disk gone");
		const reason = new DOMException("stopped", "AbortError");
		attachGitCleanupFailure(reason, cleanup);
		assert.equal((reason as DOMException & { cleanupCause?: Error }).cleanupCause, cleanup);
		assert.doesNotThrow(() => attachGitCleanupFailure("text", cleanup));
		assert.doesNotThrow(() => attachGitCleanupFailure(null, cleanup));
	});

	it("serializes to the wire shape and rehydrates every class with its cause chain", () => {
		const transport = Object.assign(new Error("connect ECONNRESET"), { code: "ECONNRESET" });
		const fetchFailure = new TypeError("fetch failed", { cause: transport });
		const download = new GitUnavailableError(
			{ ...HOST, code: "download-failed", asset: "a.tar.gz", url: "https://example.test/a.tar.gz" },
			{ cause: fetchFailure },
		);
		const timeout = new GitProvisionTimeoutError(
			{ phase: "verify", timeoutMs: 30000, elapsedMs: 30001 },
			{ cause: download },
		);
		const config = new GitProvisionConfigError({ source: "sdk", field: "onStatus", expected: "a function" });

		const wire: SerializedGitProvisionError = JSON.parse(JSON.stringify(timeout));
		assert.deepEqual(Object.keys(wire).sort(), ["cause", "code", "fields", "hint", "message", "name", "retryable"]);
		const restored = rehydrateGitProvisionError(wire);
		assert.ok(restored instanceof GitProvisionTimeoutError);
		assert.equal(restored.message, timeout.message);
		assert.deepEqual(restored.fields, timeout.fields);
		const restoredDownload = restored.cause;
		assert.ok(restoredDownload instanceof GitUnavailableError);
		assert.equal(restoredDownload.code, "download-failed");
		assert.equal(restoredDownload.retryable, true);
		const restoredFetch = restoredDownload.cause as Error & { cause?: Error & { code?: string } };
		assert.equal(restoredFetch.name, "TypeError");
		assert.equal(restoredFetch.message, "fetch failed");
		assert.equal(restoredFetch.cause?.code, "ECONNRESET");
		assert.equal(restoredFetch.cause?.message, "connect ECONNRESET");

		const restoredConfig = rehydrateGitProvisionError(JSON.parse(JSON.stringify(config)));
		assert.ok(restoredConfig instanceof GitProvisionConfigError);
		assert.equal(restoredConfig.message, config.message);
		assert.equal(restoredConfig.cause, undefined);
		assert.equal("cause" in config.toJSON(), false);
	});

	it("rehydrates an unknown name into the family base, keeping name, code, message and hint", () => {
		const restored = rehydrateGitProvisionError({
			name: "GitFutureError",
			code: "future-code",
			message: "from a newer sender",
			hint: "upgrade",
			retryable: true,
			fields: { detail: "x" },
		});
		assert.equal(restored.constructor, GitProvisionError);
		assert.equal(restored.name, "GitFutureError");
		assert.equal(restored.code, "future-code");
		assert.equal(restored.message, "from a newer sender");
		assert.equal(restored.hint, "upgrade");
		assert.equal(restored.retryable, true);
		assert.deepEqual(restored.fields, { detail: "x" });
		assert.ok(isGitProvisionError(restored));

		const unknownCode = rehydrateGitProvisionError({
			name: "GitUnavailableError",
			code: "future-code",
			message: "m",
			hint: "h",
			retryable: false,
			fields: {},
		});
		assert.equal(unknownCode.constructor, GitProvisionError);
		assert.equal(unknownCode.name, "GitUnavailableError");
		assert.ok(!isGitUnavailableError(unknownCode));
	});

	it("bounds serialized cause chains", () => {
		let cause: Error = new Error("deepest");
		for (let depth = 0; depth < 20; depth++) cause = new Error(`level ${depth}`, { cause });
		const wire = new GitUnavailableError({ ...HOST, code: "not-installed", installDir: "/d" }, { cause }).toJSON();
		let levels = 0;
		for (let current = wire.cause; current !== undefined; current = current.cause) levels++;
		assert.equal(levels, 7);
		const opaque = new GitUnavailableError(
			{ ...HOST, code: "not-installed", installDir: "/d" },
			{ cause: { reason: 1 } },
		);
		assert.deepEqual(opaque.toJSON().cause, { name: "Error", message: "[object Object]" });
	});

	it("bounds serialized cause chains through nested git errors and cycles", () => {
		const unavailable = (cause?: Error) =>
			new GitUnavailableError(
				{ ...HOST, code: "not-installed", installDir: "/d" },
				cause === undefined ? undefined : { cause },
			);
		let typed: GitUnavailableError = unavailable();
		for (let depth = 0; depth < 20; depth++) typed = unavailable(typed);
		let levels = 0;
		for (let current = typed.toJSON().cause; current !== undefined; current = current.cause) {
			assert.equal(current.name, "GitUnavailableError");
			levels++;
		}
		assert.equal(levels, 7);

		const first = new Error("first");
		const looped = unavailable(first);
		Object.defineProperty(first, "cause", { value: unavailable(looped) });
		Object.defineProperty(looped, "cause", { value: first });
		const wire = unavailable(looped).toJSON();
		levels = 0;
		for (let current = wire.cause; current !== undefined; current = current.cause) levels++;
		assert.equal(levels, 7);
		assert.ok(isGitUnavailableError(rehydrateGitProvisionError(wire)));
	});
});

describe("git provisioning error edges (#4322)", () => {
	it.each([
		"unsupported-platform",
		"offline",
		"not-installed",
		"checksum-mismatch",
		"download-failed",
		"install-failed",
	])("recognizes a foreign GitUnavailableError with code %s", (code) => {
		assert.ok(isGitUnavailableError({ name: "GitUnavailableError", code }));
	});

	it("rejects a family-named value whose code is not a string", () => {
		assert.ok(!isGitProvisionError({ name: "GitProvisionError", code: 7 }));
	});

	it("names a directly constructed family error after the family", () => {
		const error = new GitProvisionError({ code: "x", message: "m", hint: "h", retryable: false, fields: {} });
		assert.equal(error.name, "GitProvisionError");
	});

	it("renders a network download failure without an HTTP status", () => {
		const error = new GitUnavailableError({ ...HOST, code: "download-failed", asset: "a.tar.gz", url: "u" });
		assert.equal(
			error.message,
			"Git is unavailable: a.tar.gz could not be downloaded (download-failed). Check that github.com is reachable from this machine and try again, or install git 2.30.0 or newer with your system package manager (https://git-scm.com/downloads).",
		);
	});

	it("stops walking a cause chain at null", () => {
		assert.equal(findGitProvisionError(null), undefined);
		assert.equal(findGitProvisionError(new Error("x", { cause: null })), undefined);
		assert.equal(isRetryableGitProvisionError(null), false);
		assert.equal(isRetryableGitProvisionError(new Error("x", { cause: null })), false);
	});

	it("serializes causes by kind: primitives are dropped, codes kept only when string or number", () => {
		const unavailable = (cause: object | string) =>
			new GitUnavailableError({ ...HOST, code: "not-installed", installDir: "/d" }, { cause }).toJSON();
		assert.equal("cause" in unavailable("text"), false);
		assert.equal(
			"cause" in
				new GitUnavailableError({ ...HOST, code: "not-installed", installDir: "/d" }, { cause: null }).toJSON(),
			false,
		);
		assert.deepEqual(unavailable(Object.assign(new Error("errno"), { code: 42 })).cause, {
			name: "Error",
			message: "errno",
			code: 42,
		});
		assert.deepEqual(unavailable(Object.assign(new Error("odd"), { code: { nested: true } })).cause, {
			name: "Error",
			message: "odd",
		});
	});

	it("restores plain causes as plain errors with only the properties they had", () => {
		const coded = Object.assign(new Error("connect ECONNRESET"), { code: "ECONNRESET" });
		const wire = JSON.parse(
			JSON.stringify(
				new GitUnavailableError(
					{ ...HOST, code: "download-failed", asset: "a", url: "u" },
					{ cause: new TypeError("fetch failed", { cause: coded }) },
				),
			),
		);
		const restored = rehydrateGitProvisionError(wire);
		const fetchFailure = restored.cause as Error;
		const reset = fetchFailure.cause as Error & { code?: string };
		assert.ok(!(fetchFailure instanceof GitProvisionError));
		assert.ok(!(reset instanceof GitProvisionError));
		assert.equal("code" in fetchFailure, false);
		assert.equal(reset.code, "ECONNRESET");
		assert.ok(Object.keys(reset).includes("code"));
		assert.equal("cause" in reset, false);
		const config = rehydrateGitProvisionError(
			JSON.parse(JSON.stringify(new GitProvisionConfigError({ source: "sdk", field: "f", expected: "e" }))),
		);
		assert.equal("cause" in config, false);
	});

	it.each([
		["GitFutureError", "offline"],
		["GitProvisionTimeoutError", "offline"],
		["GitFutureError", "provision-timeout"],
		["GitProvisionConfigError", "offline"],
		["GitFutureError", "invalid-option"],
	])("rehydrates name %s with code %s into the family base", (name, code) => {
		const restored = rehydrateGitProvisionError({
			name,
			code,
			message: "m",
			hint: "h",
			retryable: false,
			fields: {},
		});
		assert.equal(restored.constructor, GitProvisionError);
		assert.equal(restored.name, name);
		assert.equal(restored.code, code);
		assert.equal("cause" in restored, false);
	});
});

describe("git install command in errors (#4322)", () => {
	const APT = "apt-get install git";
	const withCommand: GitUnavailableFields[] = [
		{ ...HOST, installCommand: APT, code: "offline", offlineVariable: "ATOMIC_OFFLINE" },
		{ ...HOST, installCommand: APT, code: "not-installed", installDir: "/d" },
		{ ...HOST, installCommand: APT, code: "unsupported-platform", reason: "architecture" },
		{ ...CHECKSUM_FIELDS, installCommand: APT },
		{ ...HOST, installCommand: APT, code: "download-failed", asset: "a", url: "u", httpStatus: 503 },
		{ ...HOST, installCommand: APT, code: "install-failed", phase: "extract", asset: "a", installDir: "/d" },
		{ ...HOST, installCommand: APT, code: "install-failed", phase: "verify", asset: "a", installDir: "/d" },
	];

	it.each(withCommand)("ends the $code hint with the install command", (fields) => {
		const error = new GitUnavailableError(fields);
		assert.ok(
			error.hint.toLowerCase().endsWith("install git 2.30.0 or newer with `apt-get install git`."),
			error.hint,
		);
		assert.ok(error.message.endsWith(error.hint));
		assert.equal(error.fields.installCommand, APT);
	});

	it("puts the install command in a timeout's hint", () => {
		const error = new GitProvisionTimeoutError({ phase: "lock", timeoutMs: 1, elapsedMs: 2, installCommand: APT });
		assert.ok(error.hint.endsWith("or install git 2.30.0 or newer with `apt-get install git`."));
		assert.equal(error.fields.installCommand, APT);
	});

	it("keeps the originating machine's command when rehydrated elsewhere", () => {
		const original = new GitUnavailableError({
			...HOST,
			installCommand: "dnf install git",
			code: "offline",
			offlineVariable: "V",
		});
		const restored = rehydrateGitProvisionError(JSON.parse(JSON.stringify(original)));
		assert.ok(restored instanceof GitUnavailableError);
		assert.equal(restored.hint, original.hint);
		assert.equal(restored.fields.installCommand, "dnf install git");
		assert.ok(restored.hint.includes("`dnf install git`"));
	});

	it("renders the Ubuntu 20.04 case as one full message", () => {
		const ppa = "add-apt-repository ppa:git-core/ppa && apt update && apt install git";
		const error = new GitUnavailableError({
			...HOST,
			installCommand: ppa,
			code: "unsupported-platform",
			reason: "glibc-too-old",
			libc: "glibc 2.31",
		});
		assert.equal(
			error.message,
			`Git is unavailable: automatic provisioning does not support linux/x64 with glibc 2.31 (unsupported-platform). Install git 2.30.0 or newer with \`${ppa}\`.`,
		);
	});
});
