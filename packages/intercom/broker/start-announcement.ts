import { readFileSync, unlinkSync, writeFileSync } from "node:fs";

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
 */
export const BROKER_ANNOUNCE_PATH_ENV = "ATOMIC_INTERCOM_BROKER_ANNOUNCE_PATH";
export const BROKER_ANNOUNCE_TOKEN_ENV = "ATOMIC_INTERCOM_BROKER_ANNOUNCE_TOKEN";

/** The file and token one spawn asks its broker to announce itself with. */
export interface BrokerStartAnnouncement {
	readonly path: string;
	readonly token: string;
}

/** Tokens go in the file and the environment unquoted, so only plain characters are accepted. */
const TOKEN_PATTERN = /^[A-Za-z0-9-]+$/u;

/** The announcement the environment asks this process for, or undefined when it asks for none. */
function requested(env: NodeJS.ProcessEnv): BrokerStartAnnouncement | undefined {
	const path = env[BROKER_ANNOUNCE_PATH_ENV];
	const token = env[BROKER_ANNOUNCE_TOKEN_ENV];
	if (!path || !token || !TOKEN_PATTERN.test(token)) return undefined;
	return { path, token };
}

/** Broker side: write `<token> <pid>` where the parent asked. A failure to write must never keep the broker from starting. */
export function announceBrokerStart(env: NodeJS.ProcessEnv = process.env, pid: number = process.pid): void {
	const announcement = requested(env);
	if (announcement === undefined) return;
	try {
		writeFileSync(announcement.path, `${announcement.token} ${pid}\n`, { mode: 0o600 });
	} catch {
		// The parent then waits out its start-up budget, as it did before broker announcements existed.
	}
}

/** Broker side: take the announcement back once the broker listens, so none outlives the broker's start-up. */
export function retractBrokerStartAnnouncement(env: NodeJS.ProcessEnv = process.env, pid: number = process.pid): void {
	const announcement = requested(env);
	if (announcement === undefined) return;
	// Only the broker's own announcement: a stale file from another broker is the parent's to replace.
	if (readBrokerStartAnnouncement(announcement) !== pid) return;
	try {
		unlinkSync(announcement.path);
	} catch {
		// Already gone, or held open by the parent's read; the next spawn replaces it.
	}
}

/** Parent side: the pid this spawn's broker announced, or undefined until it has, or when the file is another spawn's. */
export function readBrokerStartAnnouncement(announcement: BrokerStartAnnouncement): number | undefined {
	let text: string;
	try {
		text = readFileSync(announcement.path, "utf-8");
	} catch {
		return undefined;
	}
	// A complete line only: a write still in progress is read as nothing yet.
	if (!text.endsWith("\n")) return undefined;
	const [token, pid, ...rest] = text.trim().split(/\s+/u);
	if (token !== announcement.token || rest.length > 0) return undefined;
	const parsed = Number(pid);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
