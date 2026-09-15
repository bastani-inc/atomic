import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VERSION, VERSION_ADOPTION_ENDPOINT } from "../src/config.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getPiUserAgent } from "../src/utils/pi-user-agent.ts";

const VERSION_ADOPTION_ORIGIN = "https://atomic-version-adoption.norin.workers.dev/v1/version-adoption";

const changelogFixture = vi.hoisted(() => ({ path: "" }));

vi.mock("../src/modes/interactive/interactive-mode-deps.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/modes/interactive/interactive-mode-deps.ts")>();
	return {
		...actual,
		getChangelogPath: () => changelogFixture.path || actual.getChangelogPath(),
	};
});

type ChangelogHost = {
	session: { state: { messages: unknown[] } };
	settingsManager: SettingsManager;
	reportInstallTelemetry: ReturnType<typeof vi.fn<(version: string) => void>>;
};

function getChangelogForDisplay(host: ChangelogHost): string | undefined {
	const fn = Reflect.get(InteractiveMode.prototype, "getChangelogForDisplay") as (
		this: ChangelogHost,
	) => string | undefined;
	return fn.call(host);
}

function reportInstallTelemetry(host: { settingsManager: SettingsManager }, version: string): void {
	const fn = Reflect.get(InteractiveMode.prototype, "reportInstallTelemetry") as (
		this: { settingsManager: SettingsManager },
		version: string,
	) => void;
	fn.call(host, version);
}

function freshHost(settings: SettingsManager = SettingsManager.inMemory()): ChangelogHost {
	return {
		session: { state: { messages: [] } },
		settingsManager: settings,
		reportInstallTelemetry: vi.fn(),
	};
}

function fetchUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	return input.url;
}

function installFakeTimerAbortTimeout(): void {
	vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
		const controller = new AbortController();
		setTimeout(() => {
			controller.abort();
		}, ms);
		return controller.signal;
	});
}

function writeChangelog(content: string): void {
	writeFileSync(changelogFixture.path, content);
}

let tempDir: string | undefined;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "version-adoption-"));
	changelogFixture.path = join(tempDir, "CHANGELOG.md");
	writeChangelog("# Changelog\n\n## [Unreleased]\n");
	delete process.env.ATOMIC_TELEMETRY;
	delete process.env.PI_TELEMETRY;
	delete process.env.ATOMIC_OFFLINE;
	delete process.env.PI_OFFLINE;
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	changelogFixture.path = "";
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
	delete process.env.ATOMIC_TELEMETRY;
	delete process.env.PI_TELEMETRY;
	delete process.env.ATOMIC_OFFLINE;
	delete process.env.PI_OFFLINE;
});

describe("version-adoption telemetry", () => {
	// #2498
	it("exports VERSION_ADOPTION_ENDPOINT as the approved workers.dev origin", () => {
		expect(VERSION_ADOPTION_ENDPOINT).toBe(VERSION_ADOPTION_ORIGIN);
	});

	it("ignores hostile endpoint environment variables after a fresh module load", async () => {
		const override = "https://override.invalid/x";
		vi.stubEnv("ATOMIC_VERSION_ADOPTION_ENDPOINT", override);
		vi.stubEnv("PI_VERSION_ADOPTION_ENDPOINT", override);
		vi.stubEnv("ATOMIC_TELEMETRY_ENDPOINT", override);
		vi.stubEnv("PI_TELEMETRY_ENDPOINT", override);
		vi.stubEnv("ATOMIC_TELEMETRY_URL", override);
		vi.stubEnv("PI_TELEMETRY_URL", override);

		vi.doUnmock("../src/modes/interactive/interactive-mode-deps.ts");
		vi.resetModules();

		const { VERSION_ADOPTION_ENDPOINT: reloadedEndpoint } = await import("../src/config.ts");
		const { InteractiveMode: ReloadedInteractiveMode } = await import("../src/modes/interactive/interactive-mode.ts");
		const { SettingsManager: ReloadedSettingsManager } = await import("../src/core/settings-manager.ts");

		expect(reloadedEndpoint).toBe("https://atomic-version-adoption.norin.workers.dev/v1/version-adoption");

		const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

		const version = "1.2.3+abc";
		const fn = Reflect.get(ReloadedInteractiveMode.prototype, "reportInstallTelemetry") as (
			this: { settingsManager: ReturnType<typeof ReloadedSettingsManager.inMemory> },
			version: string,
		) => void;
		fn.call({ settingsManager: ReloadedSettingsManager.inMemory() }, version);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchUrl(fetchMock.mock.calls[0]![0])).toBe(
			`${VERSION_ADOPTION_ORIGIN}?version=${encodeURIComponent(version)}`,
		);
	});

	it("pings once on the first interactive launch with fresh settings", () => {
		const host = freshHost();
		expect(host.settingsManager.getLastChangelogVersion()).toBeUndefined();
		expect(getChangelogForDisplay(host)).toBeUndefined();
		expect(host.settingsManager.getLastChangelogVersion()).toBe(VERSION);
		expect(host.reportInstallTelemetry).toHaveBeenCalledTimes(1);
		expect(host.reportInstallTelemetry).toHaveBeenCalledWith(VERSION);
	});

	it("does not ping when the same version is already recorded, including a reinstall that kept settings", () => {
		const settings = SettingsManager.inMemory();
		settings.setLastChangelogVersion(VERSION);
		const host = freshHost(settings);
		expect(getChangelogForDisplay(host)).toBeUndefined();
		expect(host.reportInstallTelemetry).not.toHaveBeenCalled();
		expect(host.settingsManager.getLastChangelogVersion()).toBe(VERSION);
	});

	it("does not ping or record a version for a resumed session", () => {
		const host = freshHost();
		host.session.state.messages.push({ role: "user" });
		expect(getChangelogForDisplay(host)).toBeUndefined();
		expect(host.reportInstallTelemetry).not.toHaveBeenCalled();
		expect(host.settingsManager.getLastChangelogVersion()).toBeUndefined();
	});

	it("pings once on the first interactive launch after an update with changelog entries", () => {
		writeChangelog("## [0.0.0]\n\n- current\n\n## [0.0.0-alpha.1]\n\n- previous\n");
		const settings = SettingsManager.inMemory();
		settings.setLastChangelogVersion("0.0.0-alpha.1");
		const host = freshHost(settings);
		expect(getChangelogForDisplay(host)).toBeTruthy();
		expect(host.settingsManager.getLastChangelogVersion()).toBe(VERSION);
		expect(host.reportInstallTelemetry).toHaveBeenCalledTimes(1);
		expect(host.reportInstallTelemetry).toHaveBeenCalledWith(VERSION);
	});

	it("does not ping after an update whose version has no changelog section", () => {
		writeChangelog("## [0.0.0-alpha.1]\n\n- previous\n");
		const settings = SettingsManager.inMemory();
		settings.setLastChangelogVersion("0.0.0-alpha.1");
		const host = freshHost(settings);
		expect(getChangelogForDisplay(host)).toBeUndefined();
		expect(host.reportInstallTelemetry).not.toHaveBeenCalled();
		expect(host.settingsManager.getLastChangelogVersion()).toBe("0.0.0-alpha.1");
	});
});

describe("version-adoption request shape", () => {
	// #2498
	it("sends one GET with encoded version, User-Agent only, AbortSignal, and no body or identifiers", async () => {
		vi.useFakeTimers();
		installFakeTimerAbortTimeout();
		const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

		const version = "1.2.3+abc";
		reportInstallTelemetry({ settingsManager: SettingsManager.inMemory() }, version);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [input, init] = fetchMock.mock.calls[0]!;
		const url = fetchUrl(input);
		expect(url).toBe(`${VERSION_ADOPTION_ORIGIN}?version=${encodeURIComponent(version)}`);
		expect(url).toBe("https://atomic-version-adoption.norin.workers.dev/v1/version-adoption?version=1.2.3%2Babc");

		expect(init).toBeDefined();
		expect(init?.headers).toEqual({ "User-Agent": getPiUserAgent(version) });
		expect(init?.headers instanceof Headers).toBe(false);
		expect(init).not.toHaveProperty("method");
		expect(init).not.toHaveProperty("body");
		expect(init).not.toHaveProperty("credentials");
		expect(init?.signal).toBeInstanceOf(AbortSignal);
		expect(AbortSignal.timeout).toHaveBeenCalledWith(5000);
		expect(init?.signal?.aborted).toBe(false);

		await vi.advanceTimersByTimeAsync(4999);
		expect(init?.signal?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(init?.signal?.aborted).toBe(true);
	});
});

describe("version-adoption opt-outs", () => {
	// #2498
	it("skips when enableInstallTelemetry is false", () => {
		const fetchMock = vi.fn();
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
		reportInstallTelemetry({ settingsManager: SettingsManager.inMemory({ enableInstallTelemetry: false }) }, VERSION);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each(["0", "false", "no"] as const)("skips when ATOMIC_TELEMETRY=%s even if the setting is true", (value) => {
		vi.stubEnv("ATOMIC_TELEMETRY", value);
		const fetchMock = vi.fn();
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
		reportInstallTelemetry({ settingsManager: SettingsManager.inMemory() }, VERSION);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each(["1", "true", "yes"] as const)("sends when ATOMIC_TELEMETRY=%s even if the setting is false", (value) => {
		vi.stubEnv("ATOMIC_TELEMETRY", value);
		const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
		reportInstallTelemetry({ settingsManager: SettingsManager.inMemory({ enableInstallTelemetry: false }) }, VERSION);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("honors PI_TELEMETRY as a legacy alias", () => {
		vi.stubEnv("PI_TELEMETRY", "0");
		const fetchMock = vi.fn();
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
		reportInstallTelemetry({ settingsManager: SettingsManager.inMemory() }, VERSION);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("lets ATOMIC_TELEMETRY win when both telemetry env vars are set", () => {
		const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

		vi.stubEnv("ATOMIC_TELEMETRY", "0");
		vi.stubEnv("PI_TELEMETRY", "1");
		reportInstallTelemetry({ settingsManager: SettingsManager.inMemory() }, VERSION);
		expect(fetchMock).not.toHaveBeenCalled();

		vi.stubEnv("ATOMIC_TELEMETRY", "1");
		vi.stubEnv("PI_TELEMETRY", "0");
		reportInstallTelemetry({ settingsManager: SettingsManager.inMemory({ enableInstallTelemetry: false }) }, VERSION);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it.each(["ATOMIC_OFFLINE", "PI_OFFLINE"] as const)("skips when %s=1 regardless of telemetry", (name) => {
		vi.stubEnv(name, "1");
		vi.stubEnv("ATOMIC_TELEMETRY", "1");
		const fetchMock = vi.fn();
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
		reportInstallTelemetry({ settingsManager: SettingsManager.inMemory() }, VERSION);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("maps --offline onto ENV_OFFLINE=1 in main.ts", () => {
		const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
		expect(main).toMatch(/args\.includes\("--offline"\)/);
		expect(main).toMatch(/setEnvValue\(ENV_OFFLINE,\s*"1"\)/);
	});
});

describe("version-adoption nonblocking failure", () => {
	// #2498
	it("returns before fetch settles and never talks to other hosts", () => {
		let settled = false;
		const fetchMock = vi.fn(
			() =>
				new Promise<Response>((resolve) => {
					queueMicrotask(() => {
						settled = true;
						resolve(new Response(null, { status: 204 }));
					});
				}),
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
		expect(() => reportInstallTelemetry({ settingsManager: SettingsManager.inMemory() }, VERSION)).not.toThrow();
		expect(settled).toBe(false);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchUrl(fetchMock.mock.calls[0]![0])).toMatch(
			/^https:\/\/atomic-version-adoption\.norin\.workers\.dev\//,
		);
		expect(fetchUrl(fetchMock.mock.calls[0]![0])).not.toContain("registry.npmjs.org");
		expect(fetchUrl(fetchMock.mock.calls[0]![0])).not.toContain("pi.dev");
	});

	it("swallows a rejected fetch without throwing, retrying, or leaking unhandled rejection", async () => {
		const reasons: unknown[] = [];
		const onUnhandled = (reason: unknown) => {
			reasons.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const fetchMock = vi.fn(() => Promise.reject(new Error("network down")));
			vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
			expect(() => reportInstallTelemetry({ settingsManager: SettingsManager.inMemory() }, VERSION)).not.toThrow();
			await Promise.resolve();
			await Promise.resolve();
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(reasons).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("swallows an abort without throwing, retrying, or leaking unhandled rejection", async () => {
		const reasons: unknown[] = [];
		const onUnhandled = (reason: unknown) => {
			reasons.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
				return new Promise<Response>((_resolve, reject) => {
					const signal = init?.signal;
					if (!signal) {
						reject(new Error("missing signal"));
						return;
					}
					if (signal.aborted) {
						reject(signal.reason);
						return;
					}
					signal.addEventListener("abort", () => {
						reject(signal.reason);
					});
				});
			});
			vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
			vi.useFakeTimers();
			installFakeTimerAbortTimeout();
			expect(() => reportInstallTelemetry({ settingsManager: SettingsManager.inMemory() }, VERSION)).not.toThrow();
			await vi.advanceTimersByTimeAsync(5000);
			await Promise.resolve();
			await Promise.resolve();
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(reasons).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it.each([400, 429, 503])(
		"swallows a %s response without retrying or leaking unhandled rejection",
		async (status) => {
			const reasons: unknown[] = [];
			const onUnhandled = (reason: unknown) => {
				reasons.push(reason);
			};
			process.on("unhandledRejection", onUnhandled);
			try {
				const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status })));
				vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
				expect(() =>
					reportInstallTelemetry({ settingsManager: SettingsManager.inMemory() }, VERSION),
				).not.toThrow();
				await Promise.resolve();
				await Promise.resolve();
				expect(fetchMock).toHaveBeenCalledTimes(1);
				expect(fetchUrl(fetchMock.mock.calls[0]![0])).toBe(
					`${VERSION_ADOPTION_ORIGIN}?version=${encodeURIComponent(VERSION)}`,
				);
				expect(reasons).toEqual([]);
			} finally {
				process.off("unhandledRejection", onUnhandled);
			}
		},
	);
});
