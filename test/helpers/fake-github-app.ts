/**
 * A fake GitHub API for the GitHub App auth of the command provisioner (#4768): it answers
 * `POST {prefix}/app/installations/{id}/access_tokens` as GitHub does, after checking the app JWT's RS256 signature
 * with the app's public key, and records each request. Its key pair is the app's; its private key is written to a file
 * of mode 600, as an operator stores it.
 */

import { createPublicKey, generateKeyPairSync, type KeyObject, verify } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const FAKE_APP_ID = "123456";
export const FAKE_INSTALLATION_ID = "4242";

/** One request the fake API received. */
export interface FakeGitHubRequest {
	readonly method: string;
	readonly path: string;
	readonly headers: IncomingMessage["headers"];
	readonly body: string;
	/** The app JWT, when the request carried one. */
	readonly jwt?: string;
}

/** What the fake answers a token request with instead of a token: a status and a JSON body, or no answer at all. */
export type FakeGitHubReply = { readonly status: number; readonly body: object } | "hang";

let keys: { readonly privateKeyPem: string; readonly publicKey: KeyObject } | undefined;
/** One RSA key pair for every fake app: generating one takes a while. */
function appKeys(): { readonly privateKeyPem: string; readonly publicKey: KeyObject } {
	if (keys !== undefined) return keys;
	const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const privateKeyPem = pair.privateKey.export({ type: "pkcs1", format: "pem" }).toString();
	keys = { privateKeyPem, publicKey: createPublicKey(pair.privateKey) };
	return keys;
}

/** The header and claims of `jwt`, if its RS256 signature verifies with `publicKey`. */
export function verifiedJwt(
	jwt: string,
	publicKey: KeyObject,
): { readonly header: Record<string, string>; readonly claims: Record<string, string | number> } | undefined {
	const [header, claims, signature] = jwt.split(".");
	if (header === undefined || claims === undefined || signature === undefined) return undefined;
	const valid = verify("sha256", Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, "base64url"));
	if (!valid) return undefined;
	return {
		header: JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as Record<string, string>,
		claims: JSON.parse(Buffer.from(claims, "base64url").toString("utf8")) as Record<string, string | number>,
	};
}

export class FakeGitHubApp {
	readonly requests: FakeGitHubRequest[] = [];
	/** How long each token it mints is valid. */
	expiresInMs = 60 * 60_000;
	/** Answers the next token requests with these instead, in order. */
	readonly replies: FakeGitHubReply[] = [];
	readonly privateKeyPem: string;
	readonly publicKey: KeyObject;
	readonly privateKeyFile: string;
	private readonly dir: string;
	private minted = 0;

	private constructor(
		private readonly server: Server,
		readonly url: string,
	) {
		({ privateKeyPem: this.privateKeyPem, publicKey: this.publicKey } = appKeys());
		this.dir = mkdtempSync(join(tmpdir(), "atomic-fake-github-"));
		this.privateKeyFile = join(this.dir, "app.pem");
		writeFileSync(this.privateKeyFile, this.privateKeyPem);
		chmodSync(this.privateKeyFile, 0o600);
	}

	/** A fake API on a free port of 127.0.0.1; `prefix` is its path, such as GitHub Enterprise Server's `/api/v3`. */
	static async start(prefix = ""): Promise<FakeGitHubApp> {
		let app: FakeGitHubApp | undefined;
		const server = createServer((request, response) => {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => app!.answer(request, Buffer.concat(chunks).toString("utf8"), prefix, response));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		app = new FakeGitHubApp(server, `http://127.0.0.1:${port}${prefix}`);
		return app;
	}

	/** The `auth.githubApp` options for this app's installation on `acme/flows`, against this fake API. */
	auth(): {
		appId: string;
		installationId: string;
		privateKeyFile: string;
		repository: string;
		apiUrl: string;
	} {
		return {
			appId: FAKE_APP_ID,
			installationId: FAKE_INSTALLATION_ID,
			privateKeyFile: this.privateKeyFile,
			repository: "acme/flows",
			apiUrl: this.url,
		};
	}

	/** The tokens it minted, in order. */
	tokens(): string[] {
		return Array.from({ length: this.minted }, (_, index) => `ghs_fake${index + 1}`);
	}

	private answer(
		request: IncomingMessage,
		body: string,
		prefix: string,
		response: import("node:http").ServerResponse,
	): void {
		const authorization = request.headers.authorization ?? "";
		const jwt = /^bearer (.+)$/i.exec(authorization)?.[1];
		const path = request.url ?? "";
		this.requests.push({
			method: request.method ?? "",
			path,
			headers: request.headers,
			body,
			...(jwt ? { jwt } : {}),
		});
		const send = (status: number, payload: object) => {
			response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
			response.end(JSON.stringify(payload));
		};
		if (request.method !== "POST" || path !== `${prefix}/app/installations/${FAKE_INSTALLATION_ID}/access_tokens`) {
			send(404, { message: "Not Found" });
			return;
		}
		const reply = this.replies.shift();
		if (reply === "hang") return;
		if (reply !== undefined) {
			send(reply.status, reply.body);
			return;
		}
		if (jwt === undefined || verifiedJwt(jwt, this.publicKey) === undefined) {
			send(401, { message: "A JSON web token could not be decoded" });
			return;
		}
		this.minted++;
		send(201, {
			token: `ghs_fake${this.minted}`,
			expires_at: new Date(Date.now() + this.expiresInMs).toISOString().replace(/\.\d{3}Z$/, "Z"),
			permissions: { actions: "write" },
			repository_selection: "selected",
		});
	}

	close(): void {
		this.server.closeAllConnections();
		this.server.close();
		rmSync(this.dir, { recursive: true, force: true });
	}
}
