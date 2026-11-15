import { isAbsolute, resolve } from "node:path";
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
/** `<transport>::<address>`, a remote helper's address. */
const TRANSPORT = /^[A-Za-z][A-Za-z0-9+.-]*::/;
/** Git's scp-like syntax of any user: a colon before the first slash, unless it follows a one-letter Windows drive. */
const ANY_SCP_LIKE = /^(?![A-Za-z]:)[^/]*:/;

/**
 * Whether `remote` is a path Git reads relative to the checkout, such as `../upstream`: neither a URL, a remote helper's
 * address, Git's scp-like `host:path`, nor an absolute path. It names nothing without the checkout's root (#4989).
 */
function isRelativePath(remote: string): boolean {
	const trimmed = remote.trim();
	if (trimmed === "" || SCHEME.test(trimmed) || TRANSPORT.test(trimmed) || ANY_SCP_LIKE.test(trimmed)) return false;
	// A drive or UNC path is absolute on Windows, wherever the record is read.
	return !isAbsolute(trimmed) && !/^(?:[A-Za-z]:)?[\\/]/.test(trimmed);
}

/**
 * `remote` as the identity compares it: an HTTP(S) or Git remote, or an SSH one as the `git` user of hosting services,
 * becomes `https://<host>[:port]/<path>`, with the host lower-cased, any credentials and a default port dropped, and
 * slashes and a trailing `.git` trimmed from the path, so `git@github.com:o/r.git`, `ssh://git@GitHub.com/o/r` and
 * `https://github.com/o/r.git` are one repository. SSH remotes of another user or none, whose paths may be relative to
 * that user's home directory, local paths, `file://` and other remotes are kept as written, except a relative path such
 * as `../upstream`, which names the absolute path it resolves to from `root`, the checkout's root, when given (#4989).
 */
export function normalizeRemoteUrl(remote: string, root?: string): string {
	if (isRelativePath(remote)) return root !== undefined && isAbsolute(root) ? resolve(root, remote.trim()) : remote;
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

/** The identity of the repository `remotes` name, in their normalized form, relative paths resolved against `root`. */
export function repositoryIdOf(remotes: readonly string[], root?: string): RepositoryId {
	return sha256Hex(remotes.map((remote) => normalizeRemoteUrl(remote, root)).join("\n")).slice(0, 24) as RepositoryId;
}

/**
 * The identity pooled worktrees, seeds and an object store are shared under by every checkout of the repository that
 * `remotes` name, relative paths resolved against the checkout's `root` (#4989); undefined when they name no one
 * repository: a checkout without remotes, which only its own history tells apart from every other, or a relative path
 * without the root it is relative to. Those checkouts share nothing with another.
 */
export function sharedRepositoryIdOf(remotes: readonly string[], root?: string): RepositoryId | undefined {
	if (remotes.length === 0) return undefined;
	if (remotes.some(isRelativePath) && (root === undefined || !isAbsolute(root))) return undefined;
	return repositoryIdOf(remotes, root);
}

/**
 * Every identity the pooled worktrees and object store of the repository `remotes` name may be under, the current one
 * first, or none when {@link sharedRepositoryIdOf} gives none. The identity earlier versions gave the remotes as spelled
 * is one only when that spelling named one repository: never for a relative path, which named every checkout's
 * neighbour of that name (#4989).
 */
export function sharedRepositoryIdsOf(remotes: readonly string[], root?: string): RepositoryId[] {
	const current = sharedRepositoryIdOf(remotes, root);
	if (current === undefined) return [];
	if (remotes.some(isRelativePath)) return [current];
	return [...new Set([current, legacyRepositoryIdOf(remotes)])];
}

/**
 * The identity of the object store of the checkout at `root` whose remotes name no one repository (#4989): its own,
 * shared with no other checkout, so a restore never reads or writes another repository's objects. A shared identity
 * hashes absolute paths and URLs, never `checkout` alone on a line, so the two never meet.
 */
export function checkoutStoreIdOf(root: string): RepositoryId {
	return sha256Hex(`checkout\n${resolve(root)}`).slice(0, 24) as RepositoryId;
}

/** The identity earlier versions gave the repository `remotes` name: the remotes as spelled. */
export function legacyRepositoryIdOf(remotes: readonly string[]): RepositoryId {
	return sha256Hex(remotes.join("\n")).slice(0, 24) as RepositoryId;
}

/** Every identity records of the repository `remotes` name may carry, the current one first. */
export function repositoryIdsOf(remotes: readonly string[]): RepositoryId[] {
	return [...new Set([repositoryIdOf(remotes), legacyRepositoryIdOf(remotes)])];
}
