export interface BashInterceptorRule {
	pattern: string;
	flags?: string;
	tool: string;
	message: string;
	allowSubcommands?: string[];
}

export const DEFAULT_BASH_INTERCEPTOR_RULES: BashInterceptorRule[] = [
	{ pattern: "^\\s*(cat|head|tail|less|more)\\s+", tool: "read", message: "Use the read tool instead of shell commands to inspect file contents." },
	{ pattern: "^\\s*(grep|rg|ripgrep|ag|ack)\\s+", tool: "search", message: "Use the search tool instead of shell grep commands." },
	{ pattern: "^\\s*(find|fd|locate)\\s+.*(-name|-iname|-type|--type|-glob)", tool: "find", message: "Use the find tool instead of shell find/fd/locate commands." },
	{ pattern: "^\\s*sed\\s+(-i|--in-place)", tool: "edit", message: "Use the edit tool instead of in-place sed." },
	{ pattern: "^\\s*perl\\s+.*-[pn]?i", tool: "edit", message: "Use the edit tool instead of in-place perl." },
	{ pattern: "^\\s*awk\\s+.*-i\\s+inplace", tool: "edit", message: "Use the edit tool instead of in-place awk." },
	{ pattern: "^\\s*(echo|printf|cat\\s*<<)\\s+(?:[^\"'>]|\"[^\"]*\"|'[^']*')*(?<!\\|)>{1,2}\\|?\\s*[$\\w./~\"'-]", tool: "write", message: "Use the write tool instead of shell redirection to write files." },
];

export function checkBashInterception(
	command: string,
	availableTools: readonly string[],
	rules: readonly BashInterceptorRule[] = DEFAULT_BASH_INTERCEPTOR_RULES,
): string | undefined {
	for (const rule of rules) {
		if (!availableTools.includes(rule.tool)) continue;
		try {
			if (new RegExp(rule.pattern, rule.flags).test(command.trim())) {
				return `Blocked: ${rule.message}\n\nOriginal command: ${command}`;
			}
		} catch {}
	}
	return undefined;
}
