import { existsSync } from "node:fs";

export type HostLibc = "glibc" | "musl" | "unknown";

export interface EmbeddedPostgresHost {
	readonly platform: NodeJS.Platform;
	readonly arch: string;
	readonly libc?: HostLibc;
}

export interface EmbeddedPostgresTarget {
	readonly id: string;
	readonly bundledDirectory: string;
	readonly nativeLeafPackageName?: string;
	readonly npmPackageName?: string;
	readonly emulated: boolean;
	readonly reason?: string;
}

export interface LinuxLibcSignals {
	readonly glibcVersionRuntime?: string;
	readonly muslLoaderExists: boolean;
}

/** Resolve libc from Node's runtime report, corroborated by the standard musl loader path. */
export function detectLinuxLibc(signals: LinuxLibcSignals): HostLibc {
	if (signals.glibcVersionRuntime !== undefined && signals.glibcVersionRuntime.length > 0) return "glibc";
	if (signals.muslLoaderExists) return "musl";
	return "unknown";
}

export function detectCurrentHostLibc(platform = process.platform, arch = process.arch): HostLibc | undefined {
	if (platform !== "linux") return undefined;
	const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
	return detectLinuxLibc({
		glibcVersionRuntime: report?.header?.glibcVersionRuntime,
		muslLoaderExists: existsSync(
			`/lib/ld-musl-${arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : arch}.so.1`,
		),
	});
}

export function resolveEmbeddedPostgresTarget(host: EmbeddedPostgresHost): EmbeddedPostgresTarget {
	if (host.platform === "linux" && host.libc === "musl") {
		if (host.arch !== "x64" && host.arch !== "arm64") {
			throw new Error(`Embedded Postgres does not support Linux musl architecture ${host.arch}.`);
		}
		const id = `linux-${host.arch}-musl`;
		return {
			id,
			bundledDirectory: id,
			nativeLeafPackageName: `@bastani/atomic-natives-linux-${host.arch}-musl`,
			emulated: false,
		};
	}

	if (host.platform === "win32" && host.arch === "arm64") {
		return {
			id: "windows-arm64",
			bundledDirectory: "windows-arm64",
			nativeLeafPackageName: "@bastani/atomic-natives-win32-arm64-msvc",
			emulated: true,
			reason: "Windows ARM64 runs the Windows x64 PostgreSQL runtime through Windows 11 x64 emulation.",
		};
	}

	const platform = host.platform === "win32" ? "windows" : host.platform;
	const id = `${platform}-${host.arch}`;
	return {
		id,
		bundledDirectory: id,
		npmPackageName: `@embedded-postgres/${id}`,
		emulated: false,
	};
}
