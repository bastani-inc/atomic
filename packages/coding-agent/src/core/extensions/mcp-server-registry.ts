import type { McpServerContribution } from "../mcp-servers.ts";
import type { WorkflowResourceProvider } from "./loader-resources.ts";

type PackageMcpServerSource = Pick<WorkflowResourceProvider, "getMcpServers">;

/**
 * MCP server contributions shared by every extension of one runtime generation.
 * Package-manifest servers come first; extension registrations replace them by name.
 */
export class McpServerRegistry {
	private readonly packageSources = new Set<PackageMcpServerSource>();
	private readonly registrations = new Map<string, McpServerContribution>();
	private readonly listeners = new Set<() => void>();

	/** Resource providers of the loaders whose extensions share this runtime. */
	addPackageSource(source: PackageMcpServerSource): void {
		if (source.getMcpServers) this.packageSources.add(source);
	}

	/** Returns the registration it replaced so a rolled-back extension load can restore it. */
	register(contribution: McpServerContribution): McpServerContribution | undefined {
		const clash = this.list().find(
			(server) =>
				server.name !== contribution.name &&
				server.name.replace(/-/g, "_") === contribution.name.replace(/-/g, "_"),
		);
		if (clash) throw new Error(`MCP server "${contribution.name}" conflicts with registered server "${clash.name}"`);
		const previous = this.registrations.get(contribution.name);
		this.registrations.set(contribution.name, contribution);
		this.notify();
		return previous;
	}

	restore(name: string, previous: McpServerContribution | undefined): void {
		if (previous) this.registrations.set(name, previous);
		else this.registrations.delete(name);
		this.notify();
	}

	list(): McpServerContribution[] {
		const contributions = new Map<string, McpServerContribution>();
		for (const source of this.packageSources) {
			for (const contribution of source.getMcpServers?.() ?? []) {
				if (!contributions.has(contribution.name)) contributions.set(contribution.name, contribution);
			}
		}
		for (const contribution of this.registrations.values()) contributions.set(contribution.name, contribution);
		return [...contributions.values()];
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private notify(): void {
		for (const listener of [...this.listeners]) listener();
	}
}
