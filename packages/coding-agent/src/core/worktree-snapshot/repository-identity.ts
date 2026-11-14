import { sha256Hex } from "./env-hash.ts";

/**
 * The identity of a repository on this machine (#4748): `sha24` of its remotes, each in its normalized form, which
 * names its shared object store under `repositories/`, its pooled worktrees and its seeds. Earlier versions named them
 * after the remotes as spelled; {@link legacyRepositoryIdOf} keeps those readable.
 */
export type RepositoryId = string & { readonly __brand: "RepositoryId" };

/** Schemes whose remotes name a host and a repository path, which SSH and HTTPS spellings of one repository share. */
const NETWORK_SCHEMES: ReadonlySet<string> = new Set(["ssh", "git+ssh", "ssh+git", "git", "http", "https"]);
const DEFAULT_PORTS: Readonly<Record<string, string>> = {
	ssh: "22",
	"git+ssh": "22",
	"ssh+git": "22",
	git: "9418",
	http: "80",
	https: "443",
};
/** `[user@]host:path`, Git's scp-like syntax; a one-letter host is a Windows drive, not a host. */
const SCP_LIKE = /^(?:[^@/\\]+@)?([^@:/\\[\]]{2,}|\[[^\]]+\]):(?!\/\/|:)(.+)$/;
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//;

/**
 * `remote` as the identity compares it: an SSH, Git or HTTP(S) remote becomes `https://<host>[:port]/<path>`, with
 * the host lower-cased, the user, any credentials and a default port dropped, and slashes and a trailing `.git` trimmed
 * from the path, so `git@github.com:o/r.git`, `ssh://git@GitHub.com/o/r` and `https://github.com/o/r.git` are one
 * repository. Local paths, `file://` and other remotes are kept as written.
 */
export function normalizeRemoteUrl(remote: string): string {
	const trimmed = remote.trim();
	const scheme = SCHEME.exec(trimmed)?.[1]?.toLowerCase();
	let host: string;
	let port = "";
	let path: string;
	if (scheme !== undefined) {
		if (!NETWORK_SCHEMES.has(scheme)) return remote;
		let url: URL;
		try {
			url = new URL(`https${trimmed.slice(scheme.length)}`);
		} catch {
			return remote;
		}
		host = url.hostname;
		// Parsed as HTTPS, a URL drops port 443 itself; each scheme's own default is dropped here.
		port = url.port === "" || url.port === DEFAULT_PORTS[scheme] ? "" : `:${url.port}`;
		path = url.pathname;
	} else {
		const scp = SCP_LIKE.exec(trimmed);
		if (scp === null) return remote;
		host = scp[1]!;
		path = scp[2]!;
	}
	const repository = path
		.replace(/^\/+/, "")
		.replace(/\/+$/, "")
		.replace(/\.git$/i, "")
		.replace(/\/+$/, "");
	if (host === "" || repository === "") return remote;
	return `https://${host.toLowerCase()}${port}/${repository}`;
}

/** The identity of the repository `remotes` name, in their normalized form. */
export function repositoryIdOf(remotes: readonly string[]): RepositoryId {
	return sha256Hex(remotes.map(normalizeRemoteUrl).join("\n")).slice(0, 24) as RepositoryId;
}

/** The identity earlier versions gave the repository `remotes` name: the remotes as spelled. */
export function legacyRepositoryIdOf(remotes: readonly string[]): RepositoryId {
	return sha256Hex(remotes.join("\n")).slice(0, 24) as RepositoryId;
}

/** Every identity records of the repository `remotes` name may carry, the current one first. */
export function repositoryIdsOf(remotes: readonly string[]): RepositoryId[] {
	return [...new Set([repositoryIdOf(remotes), legacyRepositoryIdOf(remotes)])];
}
