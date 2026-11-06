/** The lowercase hex SHA-256 of `data`, through Web Crypto, so session stores need no runtime-specific module. */
export async function sha256Hex(data: Uint8Array<ArrayBuffer>): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
