import { describe, expect, it } from "bun:test";
import {
	buildCursorLoginUrl,
	generatePkcePair,
	pollCursorAuth,
	refreshCursorToken,
} from "../auth.ts";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), {
		status: init?.status ?? 200,
		headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
	});
}

describe("Cursor OAuth helpers", () => {
	it("generates a PKCE verifier/challenge pair usable in Cursor login", async () => {
		const pair = await generatePkcePair();

		expect(pair.verifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
		expect(pair.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(pair.challenge).not.toBe(pair.verifier);
	});

	it("builds the loginDeepControl URL with uuid, challenge, login mode, and cli redirect target", () => {
		const url = new URL(buildCursorLoginUrl({ uuid: "login-uuid", challenge: "pkce-challenge" }));

		expect(url.origin).toBe("https://cursor.com");
		expect(url.pathname).toBe("/loginDeepControl");
		expect(url.searchParams.get("uuid")).toBe("login-uuid");
		expect(url.searchParams.get("challenge")).toBe("pkce-challenge");
		expect(url.searchParams.get("mode")).toBe("login");
		expect(url.searchParams.get("redirectTarget")).toBe("cli");
	});

	it("retries 404 poll responses until Cursor returns credentials", async () => {
		let calls = 0;
		const credentials = await pollCursorAuth({
			uuid: "login-uuid",
			verifier: "verifier",
			intervalMs: 1,
			timeoutMs: 100,
			fetch: async (input) => {
				calls += 1;
				const url = new URL(String(input));
				expect(url.pathname).toBe("/auth/poll");
				expect(url.searchParams.get("uuid")).toBe("login-uuid");
				expect(url.searchParams.get("verifier")).toBe("verifier");
				return calls === 1
					? new Response("not ready", { status: 404 })
					: jsonResponse({ accessToken: "access", refreshToken: "refresh", expiresIn: 3600 });
			},
		});

		expect(calls).toBe(2);
		expect(credentials.access).toBe("access");
		expect(credentials.refresh).toBe("refresh");
		expect(credentials.expires).toBeGreaterThan(Date.now());
	});

	it("refreshes credentials and preserves the old refresh token when Cursor omits a replacement", async () => {
		const credentials = await refreshCursorToken(
			{ access: "old-access", refresh: "old-refresh", expires: 0 },
			{
				fetch: async (_input, init) => {
					expect(init?.method).toBe("POST");
					expect(init?.headers).toMatchObject({ authorization: "Bearer old-refresh" });
					return jsonResponse({ accessToken: "new-access", expiresIn: 1800 });
				},
			},
		);

		expect(credentials.access).toBe("new-access");
		expect(credentials.refresh).toBe("old-refresh");
		expect(credentials.expires).toBeGreaterThan(Date.now());
	});
});
