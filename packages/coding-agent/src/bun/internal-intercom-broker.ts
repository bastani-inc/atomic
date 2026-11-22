import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { INTERCOM_BROKER_BUNDLE_ENTRY } from "../core/builtin-install-layout.ts";
import { type AppHostModuleSpecifier, type AppHostModules, requestAppHostModulesOnly } from "./app-host-modules.js";

export const INTERNAL_INTERCOM_BROKER_ARG = "--atomic-internal-intercom-broker";
export const INTERNAL_INTERCOM_BROKER_RELAY_ARG = "--atomic-internal-intercom-broker-relay";
export const INTERNAL_INTERCOM_BROKER_RELAY_CAPABILITY = Symbol.for("@bastani/atomic/intercom-broker-relay@1");

const BROKER_HOST_MODULE_SPECIFIERS: readonly AppHostModuleSpecifier[] = ["@bastani/atomic", "@bastani/atomic/storage"];

export interface BrokerHostModulePlugin {
	name: string;
	setup(build: {
		module(specifier: string, callback: () => Promise<{ exports: object; loader: "object" }>): void;
	}): void;
}

/**
 * A Bun runtime plugin that resolves `@bastani/atomic` and `@bastani/atomic/storage` to the app bundle's own modules.
 * The bundle loads on the first such import: the broker's first store, as a session first registers or as the broker
 * warms the local store an earlier broker left, or its multi-node routing.
 */
export function createBrokerHostModulePlugin(loadApp: () => Promise<AppHostModules>): BrokerHostModulePlugin {
	let app: Promise<AppHostModules> | undefined;
	return {
		name: "atomic-broker-host-modules",
		setup(build) {
			for (const specifier of BROKER_HOST_MODULE_SPECIFIERS) {
				build.module(specifier, async () => {
					app ??= loadApp();
					return { exports: await (await app).loadHostModule(specifier), loader: "object" };
				});
			}
		},
	};
}

/** Lets the standalone binary's broker import Atomic's host modules from the app bundle at `appPath`. */
export function installBrokerHostModules(appPath: string): void {
	const bun = (globalThis as typeof globalThis & { Bun?: { plugin(plugin: BrokerHostModulePlugin): void } }).Bun;
	bun?.plugin(
		createBrokerHostModulePlugin(async () => {
			requestAppHostModulesOnly();
			const app = (await import(pathToFileURL(appPath).href)) as Partial<AppHostModules> & {
				default?: AppHostModules;
			};
			return typeof app.loadHostModule === "function" ? (app as AppHostModules) : app.default!;
		}),
	);
}

export function getBundledIntercomBrokerPath(executablePath: string = process.execPath): string {
	return join(dirname(executablePath), "builtin", "intercom", "broker", "broker.ts");
}

/** The prebuilt broker the binary ships beside its source; the broker starts from it when it is there. */
export function getPrebuiltIntercomBrokerPath(executablePath: string = process.execPath): string {
	return join(dirname(executablePath), "builtin", "intercom", ...INTERCOM_BROKER_BUNDLE_ENTRY.split("/"));
}

function comparablePath(path: string, platform: NodeJS.Platform): string {
	const resolved = resolve(path);
	return platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isBundledIntercomBrokerPath(
	modulePath: string,
	executablePath: string = process.execPath,
	platform: NodeJS.Platform = process.platform,
): boolean {
	const path = comparablePath(modulePath, platform);
	return (
		path === comparablePath(getBundledIntercomBrokerPath(executablePath), platform) ||
		path === comparablePath(getPrebuiltIntercomBrokerPath(executablePath), platform)
	);
}

export function validateInternalIntercomBrokerPath(
	modulePath: string | undefined,
	executablePath: string = process.execPath,
	platform: NodeJS.Platform = process.platform,
): string {
	if (!modulePath) {
		throw new Error("Atomic internal intercom broker module path is required");
	}
	if (!isBundledIntercomBrokerPath(modulePath, executablePath, platform)) {
		throw new Error("Atomic internal intercom broker path must resolve to the bundled intercom broker module");
	}
	return resolve(modulePath);
}

export async function importInternalIntercomBroker(
	modulePath: string,
	executablePath: string = process.execPath,
	platform: NodeJS.Platform = process.platform,
): Promise<void> {
	const brokerPath = validateInternalIntercomBrokerPath(modulePath, executablePath, platform);
	if (!existsSync(brokerPath)) {
		throw new Error(`Atomic internal intercom broker module not found at ${brokerPath}`);
	}
	await import(pathToFileURL(brokerPath).href);
}

interface BrokerRelayRequest {
	readonly file: string;
	readonly args: string[];
	readonly cwd?: string;
	readonly env: Record<string, string>;
	readonly stderrLogPath: string;
	readonly verbatimArguments?: boolean;
	readonly nativePath?: string;
}

interface RelayNativeBinding {
	readonly startHostProcess?: (
		options: {
			readonly file: string;
			readonly args: string[];
			readonly cwd?: string;
			readonly env: Record<string, string>;
			readonly pipeStdin: false;
			readonly pipeStdout: false;
			readonly pipeStderr: false;
			readonly detached: true;
			readonly stderrLogPath: string;
			readonly verbatimArguments?: boolean;
		},
		onEvent: () => void,
	) => { readonly pid: number; readonly creationTime?: string | null; unref(): void; release(): void };
	readonly processCreationTime?: (pid: number) => string | null;
}

/**
 * Short-lived Windows broker relay for standalone compiled binaries: reads one newline-delimited JSON launch request
 * from stdin, starts the detached broker directly (breaking away from the parent job object when allowed), reports its
 * PID and creation time on stdout, holds the broker handle until stdin closes (so the parent can open a verified watch
 * handle without PID-reuse race), and exits immediately so the broker is orphaned outside the parent's process tree.
 */
export function runInternalIntercomBrokerRelay(): void {
	let buf = "";
	let launched = false;
	let held: { release(): void } | undefined;
	const finish = (code = 0) => {
		try {
			held?.release();
		} catch {}
		process.exit(code);
	};
	const reply = (payload: Record<string, unknown>) => {
		process.stdout.write(`${JSON.stringify(payload)}\n`);
	};
	const loadNative = (nativePath: string | undefined): RelayNativeBinding | null => {
		const req = createRequire(import.meta.url);
		for (const candidate of [
			nativePath,
			join(dirname(process.execPath), "node_modules", "@bastani", "atomic-natives"),
			"@bastani/atomic-natives",
		]) {
			if (!candidate) continue;
			try {
				return req(candidate) as RelayNativeBinding;
			} catch {}
		}
		return null;
	};
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk: string) => {
		if (launched) return;
		buf += chunk;
		const nl = buf.indexOf("\n");
		if (nl === -1) return;
		launched = true;
		try {
			const req = JSON.parse(buf.slice(0, nl)) as BrokerRelayRequest;
			const native = loadNative(req.nativePath);
			if (typeof native?.startHostProcess === "function") {
				try {
					const proc = native.startHostProcess(
						{
							file: req.file,
							args: req.args,
							cwd: req.cwd,
							env: req.env,
							pipeStdin: false,
							pipeStdout: false,
							pipeStderr: false,
							detached: true,
							stderrLogPath: req.stderrLogPath,
							...(req.verbatimArguments ? { verbatimArguments: true } : {}),
						},
						() => {},
					);
					proc.unref();
					held = proc;
					reply({ ok: true, pid: proc.pid, creationTime: proc.creationTime ?? null });
					return;
				} catch (error) {
					const code = (error as NodeJS.ErrnoException).code;
					if (code !== "ENOSYS" && code !== "ENOTSUP") throw error;
				}
			}
			const fd = openSync(req.stderrLogPath, "a");
			try {
				const child = spawn(req.file, req.args, {
					detached: true,
					windowsHide: true,
					cwd: req.cwd,
					env: req.env,
					stdio: ["ignore", "ignore", fd],
					...(req.verbatimArguments ? { windowsVerbatimArguments: true } : {}),
				});
				child.once("spawn", () => {
					child.unref();
					let creationTime: string | null = null;
					if (child.pid !== undefined) {
						try {
							creationTime = native?.processCreationTime?.(child.pid) ?? null;
						} catch {}
					}
					reply({ ok: true, pid: child.pid ?? null, creationTime });
				});
				child.once("error", (error: NodeJS.ErrnoException) => {
					reply({ ok: false, code: error.code ?? "UNKNOWN", message: error.message });
				});
			} finally {
				closeSync(fd);
			}
		} catch (error) {
			const err = error as NodeJS.ErrnoException;
			reply({ ok: false, code: err.code ?? "UNKNOWN", message: err.message ?? String(error) });
		}
	});
	process.stdin.on("end", () => finish(0));
	setTimeout(() => finish(0), 5_000).unref();
}
