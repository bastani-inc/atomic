import { readFileSync } from "node:fs";

/** The fields of os-release(5) that decide which package manager installs git. */
export interface OsRelease {
	readonly id: string;
	readonly idLike: readonly string[];
	readonly versionId?: string;
}

const OS_RELEASE_PATHS = ["/etc/os-release", "/usr/lib/os-release"] as const;

function unquote(value: string): string {
	return value.replace(/^(["'])(.*)\1$/, "$2");
}

/** Parse os-release text; undefined when it has no ID. */
export function parseOsRelease(text: string): OsRelease | undefined {
	const values = new Map<string, string>();
	for (const line of text.split(/\r?\n/)) {
		const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
		if (match !== null) values.set(match[1]!, unquote(match[2]!.trim()));
	}
	const id = values.get("ID")?.toLowerCase();
	if (id === undefined || id === "") return undefined;
	const versionId = values.get("VERSION_ID");
	return {
		id,
		idLike: (values.get("ID_LIKE") ?? "").toLowerCase().split(/\s+/).filter(Boolean),
		...(versionId === undefined ? {} : { versionId }),
	};
}

let cachedOsRelease: { readonly paths: readonly string[]; readonly value: OsRelease | undefined } | undefined;

/**
 * The first os-release file that exists, never merged with the second, as os-release(5) specifies. An unreadable file
 * means an unknown distribution: the error's hint falls back to its generic install text.
 */
export function readOsRelease(paths: readonly string[] = OS_RELEASE_PATHS): OsRelease | undefined {
	if (paths === OS_RELEASE_PATHS && cachedOsRelease !== undefined) return cachedOsRelease.value;
	let value: OsRelease | undefined;
	for (const path of paths) {
		try {
			value = parseOsRelease(readFileSync(path, "utf-8"));
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") break;
		}
	}
	if (paths === OS_RELEASE_PATHS) cachedOsRelease = { paths, value };
	return value;
}

function isOlderThan(versionId: string | undefined, minimum: number): boolean {
	const major = Number.parseFloat(versionId ?? "");
	return Number.isFinite(major) && major < minimum;
}

type LinuxCommandRule = readonly [readonly string[], (osRelease: OsRelease) => string];

function linuxCommandRules(): readonly LinuxCommandRule[] {
	return [
		[["alpine"], () => "apk add git"],
		[["void"], () => "xbps-install git"],
		[["arch", "manjaro"], () => "pacman -S git"],
		[["gentoo"], () => "emerge --ask --verbose dev-vcs/git"],
		[["mageia"], () => "urpmi git"],
		[["nixos"], () => "nix-env -i git"],
		[["opensuse", "opensuse-leap", "opensuse-tumbleweed", "sles", "suse"], () => "zypper install git"],
		[["amzn"], (osRelease) => (osRelease.versionId === "2" ? "yum install git" : "dnf install git")],
		[
			["ubuntu"],
			(osRelease) =>
				isOlderThan(osRelease.versionId, 22)
					? "add-apt-repository ppa:git-core/ppa && apt update && apt install git"
					: "apt-get install git",
		],
		[["debian"], () => "apt-get install git"],
		[["fedora", "rhel", "centos", "rocky", "almalinux", "ol"], () => "dnf install git"],
	];
}

const OTHER_PLATFORM_COMMANDS: Readonly<Record<string, string>> = {
	darwin: "xcode-select --install",
	win32: "winget install --id Git.Git -e --source winget",
	android: "pkg install git",
	freebsd: "pkg install git",
	openbsd: "pkg_add git",
	sunos: "pkg install developer/versioning/git",
};

/**
 * The command that installs git on this system, or undefined when the distribution is unknown. Linux commands are
 * written for a root shell. A derivative's version number is ignored: only the distribution that names itself in `ID`
 * is judged by `VERSION_ID`. A musl host without a recognized distribution is treated as Alpine.
 */
export function gitInstallCommand(
	platform: string,
	osRelease: OsRelease | undefined,
	muslHost = false,
): string | undefined {
	if (platform !== "linux") return OTHER_PLATFORM_COMMANDS[platform];
	if (osRelease !== undefined) {
		const identities = [osRelease.id, ...osRelease.idLike];
		for (const identity of identities) {
			const entry = linuxCommandRules().find(([ids]) => ids.includes(identity));
			if (entry !== undefined)
				return entry[1](identity === osRelease.id ? osRelease : { id: identity, idLike: osRelease.idLike });
		}
	}
	return muslHost ? "apk add git" : undefined;
}
