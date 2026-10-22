import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../log.js";
import { keychainStore, type TokenStore } from "./keychain.js";

export const PICKER_SCOPE = "https://www.googleapis.com/auth/photospicker.mediaitems.readonly";
const TOKEN_BUFFER_MS = 60_000;
const CONSENT_TIMEOUT_MS = 5 * 60_000;

export interface ClientConfig {
	client_id: string;
	client_secret: string;
	auth_uri: string;
	token_uri: string;
}

export interface AuthDeps {
	client: ClientConfig;
	store: TokenStore;
	fetch: typeof fetch;
	openUrl: (url: string) => void;
	now: () => number;
}

export class AuthError extends Error {}

export function loadClientConfig(): ClientConfig {
	const path = process.env.GPHOTOS_CLIENT_SECRET ?? join(homedir(), ".config/gphotos-mcp/client_secret.json");
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		throw new AuthError(
			`OAuth client file not found at ${path}. Download the Desktop OAuth client JSON from the Google Cloud console and save it there, or set GPHOTOS_CLIENT_SECRET.`,
		);
	}
	const parsed = JSON.parse(raw) as { installed?: ClientConfig };
	if (!parsed.installed?.client_id) throw new AuthError(`${path} is not a Desktop app OAuth client file.`);
	return parsed.installed;
}

const b64url = (buf: Buffer) => buf.toString("base64url");

export class GoogleAuth {
	private cached: { token: string; expiresAt: number } | null = null;
	private consentInFlight: Promise<void> | null = null;

	constructor(private deps: AuthDeps) {}

	static default(openUrl: (url: string) => void): GoogleAuth {
		return new GoogleAuth({ client: loadClientConfig(), store: keychainStore, fetch, openUrl, now: Date.now });
	}

	/** Returns a valid access token. Runs the browser consent flow on its own when no refresh token exists. */
	async accessToken(): Promise<string> {
		if (this.cached && this.cached.expiresAt > this.deps.now() + TOKEN_BUFFER_MS) return this.cached.token;
		if (!this.deps.store.get()) await this.consent();
		try {
			return await this.refresh();
		} catch (err) {
			if (err instanceof AuthError && err.message.includes("invalid_grant")) {
				log("refresh token rejected; starting consent again");
				this.deps.store.clear();
				await this.consent();
				return this.refresh();
			}
			throw err;
		}
	}

	clearAccessToken(): void {
		this.cached = null;
	}

	private async refresh(): Promise<string> {
		const refreshToken = this.deps.store.get();
		if (!refreshToken) throw new AuthError("No refresh token after consent.");
		const res = await this.deps.fetch(this.deps.client.token_uri, {
			method: "POST",
			body: new URLSearchParams({
				refresh_token: refreshToken,
				client_id: this.deps.client.client_id,
				client_secret: this.deps.client.client_secret,
				grant_type: "refresh_token",
			}),
		});
		const body = (await res.json().catch(() => ({}))) as {
			access_token?: string;
			expires_in?: number;
			refresh_token?: string;
			error?: string;
		};
		if (!res.ok || !body.access_token) {
			// Google error codes only. Raw bodies never reach tool output.
			throw new AuthError(`Token refresh failed: HTTP ${res.status} ${body.error ?? "unknown_error"}`);
		}
		if (body.refresh_token) this.deps.store.set(body.refresh_token);
		this.cached = { token: body.access_token, expiresAt: this.deps.now() + (body.expires_in ?? 3600) * 1000 };
		return body.access_token;
	}

	/** Loopback consent flow with PKCE and a per-request random state. Concurrent callers share one flow. */
	consent(): Promise<void> {
		this.consentInFlight ??= this.runConsent().finally(() => {
			this.consentInFlight = null;
		});
		return this.consentInFlight;
	}

	private async runConsent(): Promise<void> {
		const { client } = this.deps;
		const verifier = b64url(randomBytes(32));
		const challenge = b64url(createHash("sha256").update(verifier).digest());
		const state = b64url(randomBytes(16));
		const server = createServer();
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new AuthError("Could not open a loopback port for sign-in.");
		const redirectUri = `http://127.0.0.1:${address.port}`;

		const url = new URL(client.auth_uri);
		url.search = new URLSearchParams({
			client_id: client.client_id,
			redirect_uri: redirectUri,
			response_type: "code",
			scope: PICKER_SCOPE,
			access_type: "offline",
			prompt: "consent",
			state,
			code_challenge: challenge,
			code_challenge_method: "S256",
		}).toString();

		const code = await new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => {
				server.close();
				reject(new AuthError("Google sign-in was not completed within 5 minutes."));
			}, CONSENT_TIMEOUT_MS);
			server.on("request", (req, res) => {
				const q = new URL(req.url ?? "/", redirectUri).searchParams;
				if (!q.get("code") && !q.get("error")) {
					res.statusCode = 404;
					res.end();
					return;
				}
				res.setHeader("Content-Type", "text/plain; charset=utf-8");
				res.end("gphotos-mcp: sign-in complete. You can close this tab.");
				clearTimeout(timer);
				server.close();
				if (q.get("state") !== state) reject(new AuthError("Sign-in state did not match. Try again."));
				else if (q.get("error")) reject(new AuthError(`Google sign-in was declined: ${q.get("error")}`));
				else resolve(q.get("code") as string);
			});
			log("opening Google sign-in in the browser");
			this.deps.openUrl(url.toString());
		});

		const res = await this.deps.fetch(client.token_uri, {
			method: "POST",
			body: new URLSearchParams({
				code,
				client_id: client.client_id,
				client_secret: client.client_secret,
				redirect_uri: redirectUri,
				grant_type: "authorization_code",
				code_verifier: verifier,
			}),
		});
		const body = (await res.json().catch(() => ({}))) as { refresh_token?: string; error?: string };
		if (!res.ok || !body.refresh_token) {
			throw new AuthError(`Sign-in token exchange failed: HTTP ${res.status} ${body.error ?? "no_refresh_token"}`);
		}
		this.deps.store.set(body.refresh_token);
		this.cached = null;
		log("signed in; refresh token stored in keychain");
	}
}
