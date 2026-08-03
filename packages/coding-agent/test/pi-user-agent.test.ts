import { describe, expect, it } from "vitest";
import { APP_NAME } from "../src/index.ts";
import { getPiUserAgent } from "../src/utils/pi-user-agent.ts";

describe("getPiUserAgent", () => {
	it(`formats the user agent expected by ${APP_NAME}`, () => {
		const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
		const userAgent = getPiUserAgent("1.2.3");

		expect(userAgent).toBe(`${APP_NAME}/1.2.3 (${process.platform}; ${runtime}; ${process.arch})`);
		expect(userAgent).toMatch(new RegExp(`^${APP_NAME}/[^\\s()]+ \\([^;()]+;\\s*[^;()]+;\\s*[^()]+\\)$`));
	});
});
