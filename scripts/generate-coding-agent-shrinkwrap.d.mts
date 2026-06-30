export interface CodingAgentShrinkwrapPackageEntry {
	version?: string;
	resolved?: string;
	integrity?: string;
	optional?: boolean;
	optionalDependencies?: Record<string, string>;
	os?: string[];
	cpu?: string[];
	libc?: string[];
}

export interface CodingAgentShrinkwrap {
	name: string;
	version: string;
	lockfileVersion: 3;
	requires: true;
	packages: Record<string, CodingAgentShrinkwrapPackageEntry>;
}

export function generateShrinkwrap(): Promise<CodingAgentShrinkwrap>;
