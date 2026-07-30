import { writeFileSync, renameSync } from "node:fs";
import type { ExtensionAPI } from "../../../packages/coding-agent/src/index.ts";
import { INTERACTIVE_ENGINE_ENV_VARS } from "../../../packages/coding-agent/src/index.ts";
import { INTERACTIVE_ENGINE_BOOTSTRAP_FLAG } from "../../../packages/coding-agent/src/utils/interactive-engine-bootstrap.ts";

/**
 * Engine-child fixture for the engine-death regressions.
 *
 * `/freeze-inline` and `/freeze-overlay` mount a remote `ctx.ui.custom()`
 * component that never calls `done`, reproducing the host lockup: an inline
 * mount replaces the editor in `editorContainer` and raises the blocking inline
 * custom-UI depth, an overlay mount takes focus and suppresses the global clear
 * route. Killing the engine child while one is mounted is the exact shape of the
 * reported freeze.
 *
 * Extension init also snapshots the engine child's own environment (and a
 * grandchild's) so the env-leak regression can be checked against a real child.
 */
export default function engineDeathFixture(api: ExtensionAPI): void {
	const envProbeFile = process.env.ATOMIC_ENGINE_ENV_PROBE_FILE;
	if (envProbeFile) {
		const names = [...INTERACTIVE_ENGINE_ENV_VARS];
		const own: Record<string, string | undefined> = {};
		for (const name of names) own[name] = process.env[name];
		// Deliberately OMIT `env`: that is the Bun spawn shape any extension or
		// hook can use, and the one that inherits the runtime's launch-time
		// environment regardless of what this process deleted from process.env.
		// It only stays clean because the engine was launched without the values.
		const probeCode =
			`process.stdout.write(JSON.stringify({` +
			`env:${JSON.stringify(names)}.map((n)=>process.env[n]??null),` +
			`bootstrapArg:process.argv.includes(${JSON.stringify(INTERACTIVE_ENGINE_BOOTSTRAP_FLAG)})}))`;
		const probe = Bun.spawnSync([process.execPath, "-e", probeCode], { stdout: "pipe" });
		// Publish atomically: a reader polling for the path must never observe a
		// half-written file (temp sibling + rename is the repository pattern).
		const payload = JSON.stringify({
			pid: process.pid,
			own,
			child: probe.stdout.toString().trim(),
			argv: process.argv.slice(1),
		});
		writeFileSync(`${envProbeFile}.tmp`, payload, "utf8");
		renameSync(`${envProbeFile}.tmp`, envProbeFile);
	}

	const mountFreeze = async (overlay: boolean, ctx: Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1]) => {
		const markerFile = process.env.ATOMIC_FREEZE_MOUNT_FILE;
		await ctx.ui.custom<void>(
			() => {
				if (markerFile) writeFileSync(markerFile, String(process.pid), "utf8");
				return {
					render: (width: number) => [`[stuck ${overlay ? "overlay" : "inline"} custom UI] width=${width}`],
					handleInput: () => {},
					invalidate: () => {},
				};
			},
			{ overlay },
		);
	};

	api.registerCommand("freeze-inline", {
		description: "Mount an inline custom UI that never resolves",
		handler: async (_args, ctx) => mountFreeze(false, ctx),
	});
	api.registerCommand("freeze-overlay", {
		description: "Mount an overlay custom UI that never resolves",
		handler: async (_args, ctx) => mountFreeze(true, ctx),
	});
	api.registerCommand("freeze-nested", {
		description: "Mount an inline custom UI and then an overlay above it; neither resolves",
		handler: async (_args, ctx) => {
			// Deliberately not awaited: the overlay must mount on top of the live
			// inline proxy so teardown has to unwind newest-first.
			void mountFreeze(false, ctx);
			await new Promise((resolve) => setTimeout(resolve, 50));
			await mountFreeze(true, ctx);
		},
	});
}
