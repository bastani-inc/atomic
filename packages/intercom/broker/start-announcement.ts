import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

/**
 * A spawned broker announces its real pid, so a parent that cannot watch the process it spawned can tell a broker that
 * crashed during start-up from one that is still loading.
 *
 * On Windows the broker starts behind `wscript -> cmd -> node`: `wscript` returns at once and hides the pid, so without
 * this the parent waits the whole start-up budget for a broker that died in its first second. The broker is the one
 * process that knows its own pid, so it writes it (with the spawn's token) before it loads the rest of its modules, and
 * the parent polls `process.kill(pid, 0)` on it. That is the whole mechanism, and deliberately nothing else: no process
 * of the launcher chain writes anything once the broker has ended, because tests, `atomic intercom restart` and users
 * remove the intercom directory as soon as the broker is gone, and a file created there at that moment fails the
 * removal on Windows.
 *
 * The parent hands the broker the file and token through the environment, so a broker started any other way (a test,
 * an older parent) announces nothing. The token ties a file to the spawn that asked for it: a broker that is retiring
 * and a replacement that is starting never read each other's announcement as their own.
 *
 * #6133: a parent that asks for it (`BROKER_ANNOUNCE_START_ENV`) also gets when the broker process was created, as
 * Windows records it, so that it can tell the broker apart from a later process Windows gives the same pid to. Without
 * the request the file holds exactly what earlier versions wrote, so an older parent still reads it.
 */
export const BROKER_ANNOUNCE_PATH_ENV = "ATOMIC_INTERCOM_BROKER_ANNOUNCE_PATH";
export const BROKER_ANNOUNCE_TOKEN_ENV = "ATOMIC_INTERCOM_BROKER_ANNOUNCE_TOKEN";
export const BROKER_ANNOUNCE_START_ENV = "ATOMIC_INTERCOM_BROKER_ANNOUNCE_START";

/** The file and token one spawn asks its broker to announce itself with. */
export interface BrokerStartAnnouncement {
	readonly path: string;
	readonly token: string;
}

/** What a broker announced: its pid, and when it was created where it could read that and was asked to. */
export interface AnnouncedBroker {
	readonly pid: number;
	/** The process's creation time, as the decimal count of 100-nanosecond intervals since 1601-01-01 UTC. */
	readonly started?: string;
}

/** Tokens go in the file and the environment unquoted, so only plain characters are accepted. */
const TOKEN_PATTERN = /^[A-Za-z0-9-]+$/u;
const CREATION_TIME_PATTERN = /^[1-9]\d*$/u;

/** The announcement the environment asks this process for, or undefined when it asks for none. */
function requested(env: NodeJS.ProcessEnv): BrokerStartAnnouncement | undefined {
	const path = env[BROKER_ANNOUNCE_PATH_ENV];
	const token = env[BROKER_ANNOUNCE_TOKEN_ENV];
	if (!path || !token || !TOKEN_PATTERN.test(token)) return undefined;
	return { path, token };
}

/**
 * When this process was created, as Windows records it, read by Atomic's native module; undefined elsewhere, or where
 * that module cannot be loaded. Read synchronously: the broker announces itself before it loads anything else.
 */
function ownCreationTime(): string | undefined {
	if (process.platform !== "win32") return undefined;
	try {
		const native = createRequire(import.meta.url)("@bastani/atomic-natives") as {
			processCreationTime?: (pid: number) => string | null;
		};
		const created = native.processCreationTime?.(process.pid);
		return typeof created === "string" && CREATION_TIME_PATTERN.test(created) ? created : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Broker side: write `<token> <pid>` where the parent asked, followed by ` <creation time>` when the parent asked for it
 * too and it can be read. A failure to write must never keep the broker from starting.
 */
export function announceBrokerStart(
	env: NodeJS.ProcessEnv = process.env,
	pid: number = process.pid,
	readStart: () => string | undefined = ownCreationTime,
): void {
	const announcement = requested(env);
	if (announcement === undefined) return;
	const started = env[BROKER_ANNOUNCE_START_ENV] === "1" ? readStart() : undefined;
	const witness = started !== undefined && CREATION_TIME_PATTERN.test(started) ? ` ${started}` : "";
	try {
		writeFileSync(announcement.path, `${announcement.token} ${pid}${witness}\n`, { mode: 0o600 });
	} catch {
		// The parent then waits out its start-up budget, as it did before broker announcements existed.
	}
}

/** Broker side: take the announcement back once the broker listens, so none outlives the broker's start-up. */
export function retractBrokerStartAnnouncement(env: NodeJS.ProcessEnv = process.env, pid: number = process.pid): void {
	const announcement = requested(env);
	if (announcement === undefined) return;
	// Only the broker's own announcement: a stale file from another broker is the parent's to replace.
	if (readBrokerStartAnnouncement(announcement)?.pid !== pid) return;
	try {
		unlinkSync(announcement.path);
	} catch {
		// Already gone, or held open by the parent's read; the next spawn replaces it.
	}
}

function parseBrokerStartAnnouncement(
	text: string,
	announcement: BrokerStartAnnouncement,
): AnnouncedBroker | undefined {
	// A complete line only: a write still in progress is read as nothing yet.
	if (!text.endsWith("\n")) return undefined;
	const [token, pid, started, ...rest] = text.trim().split(/\s+/u);
	if (token !== announcement.token || rest.length > 0) return undefined;
	if (started !== undefined && !CREATION_TIME_PATTERN.test(started)) return undefined;
	const parsed = Number(pid);
	if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
	return started === undefined ? { pid: parsed } : { pid: parsed, started };
}

/** Parent side: what this spawn's broker announced, or undefined until it has, or when the file is another spawn's. */
export function readBrokerStartAnnouncement(announcement: BrokerStartAnnouncement): AnnouncedBroker | undefined {
	let text: string;
	try {
		text = readFileSync(announcement.path, "utf-8");
	} catch {
		return undefined;
	}
	return parseBrokerStartAnnouncement(text, announcement);
}

export async function readBrokerStartAnnouncementAsync(
	announcement: BrokerStartAnnouncement,
): Promise<AnnouncedBroker | undefined> {
	let text: string;
	try {
		text = await readFile(announcement.path, "utf-8");
	} catch {
		return undefined;
	}
	return parseBrokerStartAnnouncement(text, announcement);
}
