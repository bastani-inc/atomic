import { sha256Hex } from "./env-hash.ts";

/**
 * The identity of a repository on this machine (#4748): `sha24` of its remotes, each in its normalized form, which
 * names its shared object store under `repositories/`, its pooled worktrees and its seeds. Earlier versions named them
 * after the remotes as spelled; {@link legacyRepositoryIdOf} keeps those readable.
 */
export type RepositoryId = string & { readonly __brand: "RepositoryId" };

/** Schemes whose remotes name a host and a repository path, which SSH and HTTPS spellings of one repository share. */
const NETWORK_SCHEMES: ReadonlySet<string> = new Set(["ssh", "git+ssh", "ssh+git", "git", "http", "https"]);
/** SSH schemes, whose user decides which account's repositories a path names. */
const SSH_SCHEMES: ReadonlySet<string> = new Set(["ssh", "git+ssh", "ssh+git"]);
/**
 * The account Git hosting services serve every repository over SSH from, so its remotes name a repository as their
 * HTTPS spelling does. Another user's SSH paths are that user's, relative to its home directory.
 */
const HOSTING_USER = "git";
const DEFAULT_PORTS: Readonly<Record<string, string>> = {
	ssh: "22",
	"git+ssh": "22",
	"ssh+git": "22",
	git: "9418",
	http: "80",
	https: "443",
};
/** `[user@]host:path`, Git's scp-like syntax; a one-letter host is a Windows drive, not a host. */
const SCP_LIKE = /^(?:([^@/\\]+)@)?([^@:/\\[\]]{2,}|\[[^\]]+\]):(?!\/\/|:)(.+)$/;
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//;

/**
 * `remote` as the identity compares it: an HTTP(S) or Git remote, or an SSH one as the `git` user of hosting services,
 * becomes `https://<host>[:port]/<path>`, with the host lower-cased, any credentials and a default port dropped, and
 * slashes and a trailing `.git` trimmed from the path, so `git@github.com:o/r.git`, `ssh://git@GitHub.com/o/r` and
 * `https://github.com/o/r.git` are one repository. SSH remotes of another user or none, whose paths may be relative to
 * that user's home directory, local paths, `file://` and other remotes are kept as written.
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
			// A scheme the URL parser does not know keeps an explicit port as written, whichever it is.
			url = new URL(`atomic+${trimmed}`);
		} catch {
			return remote;
		}
		if (SSH_SCHEMES.has(scheme) && url.username !== HOSTING_USER) return remote;
		host = url.hostname;
		port = url.port === "" || url.port === DEFAULT_PORTS[scheme] ? "" : `:${url.port}`;
		path = url.pathname;
	} else {
		const scp = SCP_LIKE.exec(trimmed);
		if (scp === null || scp[1] !== HOSTING_USER) return remote;
		host = scp[2]!;
		path = scp[3]!;
	}
	const repository = path
		.replace(/^\/+/, "")
		.replace(/\/+$/, "")
		.replace(/\.git$/i, "")
		.replace(/\/+$/, "");
	if (host === "" || repository === "") return remote;
	return `https://${host.toLowerCase()}${port}/${repository}`;
}

/** Whether remotes `a` and `b` name one repository, however each is spelled (#4913). */
export function sameRemote(a: string, b: string): boolean {
	return normalizeRemoteUrl(a) === normalizeRemoteUrl(b);
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
