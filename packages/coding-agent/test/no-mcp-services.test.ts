import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { getBuiltinPackageLocations } from "../src/core/builtin-packages.ts";
import type { ExtensionContext } from "../src/core/extensions/index.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";

it("keeps --no-mcp disabled through CLI service composition, reload and child inheritance", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-no-mcp-services-"));
	const agentDir = join(cwd, "agent");
	const mcp = getBuiltinPackageLocations(true).find((location) => location.distDirName === "mcp")!;
	const entry = join(mcp.packageDir, "index.ts");
	let context: ExtensionContext | undefined;
	try {
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			resourceLoaderOptions: {
				disabledBuiltinExtensions: ["mcp"],
				additionalExtensionPaths: [entry],
				extensionFactories: [
					{
						name: "replacement",
						factory: (pi) => {
							pi.registerCommand("mcp", { description: "Replacement MCP", handler: async () => {} });
							pi.on("session_start", (_event, ctx) => {
								context = ctx;
							});
						},
					},
				],
			},
		});
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(cwd),
			builtins: { mcp: false },
		});
		try {
			for (let generation = 0; generation < 2; generation++) {
				expect(
					session.resourceLoader.getExtensions().extensions.map((extension) => extension.resolvedPath),
				).not.toContain(entry);
				expect(
					session.resourceLoader.getExtensions().extensions.some((extension) => extension.commands.has("mcp")),
				).toBe(true);
				const childOptions = context!.getChildSessionOptions!({ sessionManager: SessionManager.inMemory(cwd) });
				expect(childOptions.builtins?.mcp).toBe(false);
				const { session: child } = await createAgentSession(childOptions);
				try {
					expect(
						child.resourceLoader.getExtensions().extensions.map((extension) => extension.resolvedPath),
					).not.toContain(entry);
				} finally {
					await child.dispose();
				}
				if (generation === 0) await session.reload();
			}
		} finally {
			await session.dispose();
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
