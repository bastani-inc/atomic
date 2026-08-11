/**
 * Windows owner-SID and DACL verification for the session temp tree.
 *
 * POSIX proves ownership of an existing temp component with a uid comparison
 * and a mode check. Node exposes neither on Windows — `lstatSync` reports
 * uid/gid 0 — so this module reads the real security descriptor through a
 * PowerShell `Get-Acl` subprocess and decides from SIDs alone: the owner must
 * be a trusted principal and every access-allowed ACE must grant only trusted
 * principals. Names are never compared; two accounts can share a display name,
 * but never a SID.
 *
 * A subprocess per directory creation would sit on the spill hot path, so a
 * successful verification is cached per canonical path per process (see
 * `verifyWindowsDirectorySecurity`). Failures are not cached: a refusal means
 * "no spill file this time", and a transient read failure must not disable
 * persistence for the rest of the process.
 */

import { spawnSync } from "node:child_process";

/** One DACL entry with its trustee resolved to a literal SID. */
export interface WindowsAccessRule {
	/** True for an access-allowed entry, false for access-denied. */
	allow: boolean;
	/** The SID the entry applies to. */
	sid: string;
}

/** What the security read produces: the caller's SID plus the descriptor. */
export interface WindowsDirectorySecurity {
	/** SID of the current process token's user. */
	currentSid: string;
	/** SID owning the directory. */
	ownerSid: string;
	/** The DACL portion of the descriptor in SDDL form (may be empty). */
	dacl: string;
	/**
	 * Every DACL entry with its trustee as a literal SID (`GetAccessRules`
	 * resolves domain-relative SDDL abbreviations such as `LA` that a
	 * name-side parse cannot). The SDDL string above cross-checks that these
	 * rules describe the whole DACL: only plain allow/deny ACE types, one
	 * rule per ACE.
	 */
	accessRules: readonly WindowsAccessRule[];
}

/**
 * Principals allowed to own, or hold access-allowed ACEs on, a temp component.
 *
 * SYSTEM and Administrators hold both on any per-user Windows temp directory
 * by inheritance, and both can reach any file on the volume regardless, so
 * permitting them grants nothing an attacker did not already have. Elevated
 * processes also create directories owned by the Administrators group rather
 * than the user, which is why the owner check shares this set. CREATOR OWNER
 * is inherit-only plumbing: it materializes as the creating account on
 * descendants, and creation inside the tree is already restricted to the
 * SIDs allowed here.
 */
const TRUSTED_STATIC_SIDS = new Set<string>([
	"S-1-5-18", // Local System
	"S-1-5-32-544", // Builtin Administrators
	"S-1-3-0", // Creator Owner
	"S-1-3-4", // Owner Rights
]);

/**
 * Decide whether a directory's descriptor is safe to adopt.
 *
 * Returns a refusal reason, or `undefined` when the directory is owned by a
 * trusted principal and its DACL grants access to trusted principals only.
 * Exported as a pure function so the decision table is testable on any host.
 */
export function evaluateWindowsDirectorySecurity(security: WindowsDirectorySecurity): string | undefined {
	const trusted = (sid: string): boolean => sid === security.currentSid || TRUSTED_STATIC_SIDS.has(sid);
	if (!security.ownerSid.startsWith("S-1-")) {
		return "its owner could not be verified";
	}
	if (!trusted(security.ownerSid)) {
		return "it is owned by another account";
	}
	// `Get-Acl` renders a null DACL (everyone has full control) as an absent
	// `D:` section; an empty DACL (`D:` with no ACEs) grants nobody anything
	// and is fine.
	const dacl = security.dacl.trim();
	if (!dacl.startsWith("D:")) {
		return "it has no access control list";
	}
	let rest = dacl.slice(2);
	const flagsEnd = rest.indexOf("(");
	const flags = flagsEnd === -1 ? rest : rest.slice(0, flagsEnd);
	if (!/^[A-Z]*$/.test(flags)) {
		return "its access control list could not be parsed";
	}
	rest = flagsEnd === -1 ? "" : rest.slice(flagsEnd);
	const aces = rest.match(/\([^()]*\)/g) ?? [];
	if (aces.join("") !== rest) {
		return "its access control list could not be parsed";
	}
	for (const ace of aces) {
		const type = ace.slice(1, -1).split(";")[0];
		if (type !== "A" && type !== "D") {
			// Conditional, object, and callback ACEs are not modeled by the
			// resolved access rules below, so a DACL containing one cannot be
			// proven restrictive.
			return "its access control list could not be verified";
		}
	}
	if (security.accessRules.length !== aces.length) {
		// The resolved rules must describe the whole DACL; a mismatch means
		// part of it was not translated and cannot be checked.
		return "its access control list could not be verified";
	}
	for (const rule of security.accessRules) {
		if (!rule.allow) {
			continue; // A deny entry only ever removes access.
		}
		if (!rule.sid.startsWith("S-1-")) {
			return "its access control list could not be verified";
		}
		if (!trusted(rule.sid)) {
			return "it grants access to another account";
		}
	}
	return undefined;
}

/**
 * One PowerShell round trip: the caller's SID, the owner SID, the DACL in
 * SDDL form, and one `Allow|Deny;SID` line per resolved access rule. The path
 * travels through the environment rather than the command line so no quoting
 * rules apply to it.
 */
const READ_SECURITY_SCRIPT = [
	"$ErrorActionPreference = 'Stop'",
	"$acl = Get-Acl -LiteralPath $env:ATOMIC_SECURITY_QUERY_PATH",
	"$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value",
	"$dacl = $acl.GetSecurityDescriptorSddlForm('Access')",
	"$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
	"$lines = @($user, $owner, $dacl)",
	"foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))" +
		' { $lines += "$($rule.AccessControlType);$($rule.IdentityReference.Value)" }',
	'[Console]::Out.Write(($lines -join "`n"))',
].join("; ");

/** Bounded wait for the security read; a wedged subprocess must not hang a spill. */
const READ_SECURITY_TIMEOUT_MS = 30_000;

/** PowerShell hosts to try, most specific first: an absolute Windows
 * PowerShell path immune to a stripped `PATH`, then whichever of
 * `powershell.exe`/`pwsh.exe` the environment resolves. */
function powershellCandidates(): string[] {
	const candidates: string[] = [];
	const systemRoot = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
	candidates.push(`${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`);
	candidates.push("powershell.exe", "pwsh.exe");
	return candidates;
}

let lastReadFailure: string | undefined;

/** Test seam: why the most recent `readWindowsDirectorySecurity` returned `undefined`. */
export function getLastWindowsSecurityReadFailureForTesting(): string | undefined {
	return lastReadFailure;
}

/**
 * Read the security descriptor of `path`, or `undefined` when it cannot be
 * read (access denied, missing PowerShell, timeout). Callers treat
 * `undefined` as unverifiable and refuse the directory.
 */
export function readWindowsDirectorySecurity(path: string): WindowsDirectorySecurity | undefined {
	lastReadFailure = undefined;
	const failures: string[] = [];
	for (const executable of powershellCandidates()) {
		const result = spawnSync(executable, ["-NoProfile", "-NonInteractive", "-Command", READ_SECURITY_SCRIPT], {
			env: { ...process.env, ATOMIC_SECURITY_QUERY_PATH: path },
			encoding: "utf8",
			timeout: READ_SECURITY_TIMEOUT_MS,
			windowsHide: true,
		});
		if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
			failures.push(
				`${executable}: status=${result.status} signal=${result.signal} error=${result.error?.message} stderr=${
					typeof result.stderr === "string" ? result.stderr.trim().slice(0, 500) : result.stderr
				}`,
			);
			continue;
		}
		const parsed = parseSecurityOutput(result.stdout);
		if (parsed !== undefined) {
			return parsed;
		}
		failures.push(`${executable}: unparseable output ${JSON.stringify(result.stdout.slice(0, 500))}`);
	}
	lastReadFailure = failures.join(" | ");
	return undefined;
}

function parseSecurityOutput(stdout: string): WindowsDirectorySecurity | undefined {
	const [currentSid, ownerSid, dacl, ...ruleLines] = stdout.split("\n").map((line) => line.trim());
	if (!currentSid || !ownerSid || dacl === undefined) {
		return undefined;
	}
	const accessRules: WindowsAccessRule[] = [];
	for (const line of ruleLines) {
		if (line.length === 0) {
			continue;
		}
		const [type, sid] = line.split(";");
		if ((type !== "Allow" && type !== "Deny") || !sid) {
			return undefined;
		}
		accessRules.push({ allow: type === "Allow", sid });
	}
	return { currentSid, ownerSid, dacl, accessRules };
}

type SecurityReader = (path: string) => WindowsDirectorySecurity | undefined;

let securityReader: SecurityReader = readWindowsDirectorySecurity;

const verifiedPaths = new Set<string>();

/**
 * Verify `path` as adoptable, returning the refusal reason when it is not.
 *
 * A successful verification is cached for the life of the process: the read
 * is a subprocess and sits on the spill path, and the symlink/directory
 * checks in `session-temp-dir.ts` still run on every use. A failure is never
 * cached, so a transient read error does not permanently disable spills.
 */
export function verifyWindowsDirectorySecurity(path: string): string | undefined {
	if (verifiedPaths.has(path)) {
		return undefined;
	}
	const security = securityReader(path);
	if (security === undefined) {
		return "its ownership could not be verified";
	}
	const refusal = evaluateWindowsDirectorySecurity(security);
	if (refusal !== undefined) {
		return refusal;
	}
	verifiedPaths.add(path);
	return undefined;
}

/** Test seam: substitute the descriptor reader; pass `undefined` to restore. */
export function setWindowsDirectorySecurityReaderForTesting(reader: SecurityReader | undefined): void {
	securityReader = reader ?? readWindowsDirectorySecurity;
}

/** Test seam: forget verified paths so a suite can re-drive verification. */
export function resetWindowsDirectorySecurityStateForTesting(): void {
	verifiedPaths.clear();
	securityReader = readWindowsDirectorySecurity;
}
