/** One DACL entry with its trustee resolved to a literal SID. */
export interface WindowsAccessRule {
	allow: boolean;
	sid: string;
}

/** Current token, owner and resolved rules; SDDL cross-checks the rules describe the entire DACL. */
export interface WindowsDirectorySecurity {
	currentSid: string;
	ownerSid: string;
	dacl: string;
	accessRules: readonly WindowsAccessRule[];
}

const TRUSTED_STATIC_SIDS = new Set<string>([
	"S-1-5-18", // Local System
	"S-1-5-32-544", // Builtin Administrators
	"S-1-3-0", // Creator Owner
	"S-1-3-4", // Owner Rights
]);

/** Return a refusal reason unless only trusted principals own or can access this directory. */
export function evaluateWindowsDirectorySecurity(security: WindowsDirectorySecurity): string | undefined {
	const trusted = (sid: string): boolean => sid === security.currentSid || TRUSTED_STATIC_SIDS.has(sid);
	if (!security.ownerSid.startsWith("S-1-")) return "its owner could not be verified";
	if (!trusted(security.ownerSid)) return "it is owned by another account";
	// An absent D: is a null DACL (full control for everyone); an empty DACL grants nobody access.
	const dacl = security.dacl.trim();
	if (!dacl.startsWith("D:")) return "it has no access control list";
	let rest = dacl.slice(2);
	const flagsEnd = rest.indexOf("(");
	const flags = flagsEnd === -1 ? rest : rest.slice(0, flagsEnd);
	if (!/^[A-Z]*$/.test(flags)) return "its access control list could not be parsed";
	rest = flagsEnd === -1 ? "" : rest.slice(flagsEnd);
	const aces = rest.match(/\([^()]*\)/g) ?? [];
	if (aces.join("") !== rest) return "its access control list could not be parsed";
	for (const ace of aces) {
		const type = ace.slice(1, -1).split(";")[0];
		// Conditional, object and callback ACEs cannot be verified from these simple allow/deny rules.
		if (type !== "A" && type !== "D") return "its access control list could not be verified";
	}
	if (security.accessRules.length !== aces.length) return "its access control list could not be verified";
	for (const rule of security.accessRules) {
		if (!rule.allow) continue;
		if (!rule.sid.startsWith("S-1-")) return "its access control list could not be verified";
		if (!trusted(rule.sid)) return "it grants access to another account";
	}
	return undefined;
}
