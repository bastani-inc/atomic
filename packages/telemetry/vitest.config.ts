import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		clearMocks: true, // vi.restoreAllMocks() keeps spy records for the rest of the file (#5552)
		environment: "node",
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
	},
	resolve: { conditions: ["source"] },
	ssr: { resolve: { conditions: ["source"] } },
});
