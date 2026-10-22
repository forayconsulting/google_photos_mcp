import { describe, expect, it, vi } from "vitest";
import { AuthError, GoogleAuth } from "../google/auth.js";
import type { TokenStore } from "../google/keychain.js";

const client = { client_id: "cid", client_secret: "csecret", auth_uri: "https://auth.example/o", token_uri: "https://token.example/t" };

function memStore(initial: string | null): TokenStore & { value: string | null } {
	return {
		value: initial,
		get() {
			return this.value;
		},
		set(v) {
			this.value = v;
		},
		clear() {
			this.value = null;
		},
	};
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe("GoogleAuth", () => {
	it("caches the access token until 60 s before expiry", async () => {
		let now = 0;
		const fetchMock = vi.fn(async () => json(200, { access_token: `tok${fetchMock.mock.calls.length}`, expires_in: 3600 }));
		const auth = new GoogleAuth({ client, store: memStore("rt"), fetch: fetchMock as typeof fetch, openUrl: () => {}, now: () => now });
		expect(await auth.accessToken()).toBe("tok1");
		now = 3_500_000;
		expect(await auth.accessToken()).toBe("tok1");
		now = 3_560_000;
		expect(await auth.accessToken()).toBe("tok2");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("saves a rotated refresh token", async () => {
		const store = memStore("old");
		const fetchMock = vi.fn(async () => json(200, { access_token: "a", expires_in: 3600, refresh_token: "new" }));
		const auth = new GoogleAuth({ client, store, fetch: fetchMock as typeof fetch, openUrl: () => {}, now: () => 0 });
		await auth.accessToken();
		expect(store.value).toBe("new");
	});

	it("reports only the Google error code, never the raw body", async () => {
		const fetchMock = vi.fn(async () => json(400, { error: "invalid_client", error_description: "secret detail" }));
		const auth = new GoogleAuth({ client, store: memStore("rt"), fetch: fetchMock as typeof fetch, openUrl: () => {}, now: () => 0 });
		const err = await auth.accessToken().catch((e) => e);
		expect(err).toBeInstanceOf(AuthError);
		expect(err.message).toContain("invalid_client");
		expect(err.message).not.toContain("secret detail");
	});

	it("runs consent on its own when no refresh token exists, with PKCE and random state", async () => {
		const store = memStore(null);
		const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			const body = new URLSearchParams(String(init?.body));
			if (body.get("grant_type") === "authorization_code") {
				expect(body.get("code")).toBe("the-code");
				expect(body.get("code_verifier")?.length).toBeGreaterThan(40);
				return json(200, { refresh_token: "fresh", access_token: "x", expires_in: 3600 });
			}
			return json(200, { access_token: "after-consent", expires_in: 3600 });
		});
		const openUrl = vi.fn(async (u: string) => {
			const url = new URL(u);
			expect(url.searchParams.get("code_challenge_method")).toBe("S256");
			expect(url.searchParams.get("scope")).toContain("photospicker.mediaitems.readonly");
			const redirect = url.searchParams.get("redirect_uri") as string;
			await fetch(`${redirect}/?code=the-code&state=${url.searchParams.get("state")}`);
		});
		const auth = new GoogleAuth({ client, store, fetch: fetchMock as typeof fetch, openUrl: (u) => void openUrl(u), now: () => 0 });
		expect(await auth.accessToken()).toBe("after-consent");
		expect(store.value).toBe("fresh");
	});

	it("rejects a callback with the wrong state", async () => {
		const fetchMock = vi.fn(async () => json(200, {}));
		const auth = new GoogleAuth({
			client,
			store: memStore(null),
			fetch: fetchMock as typeof fetch,
			openUrl: (u) => {
				const redirect = new URL(u).searchParams.get("redirect_uri");
				void fetch(`${redirect}/?code=c&state=forged`);
			},
			now: () => 0,
		});
		await expect(auth.accessToken()).rejects.toThrow(/state did not match/);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("clears a revoked refresh token and signs in again", async () => {
		const store = memStore("revoked");
		const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			const body = new URLSearchParams(String(init?.body));
			if (body.get("grant_type") === "authorization_code") return json(200, { refresh_token: "fresh" });
			if (body.get("refresh_token") === "revoked") return json(400, { error: "invalid_grant" });
			return json(200, { access_token: "ok", expires_in: 3600 });
		});
		const auth = new GoogleAuth({
			client,
			store,
			fetch: fetchMock as typeof fetch,
			openUrl: (u) => {
				const url = new URL(u);
				void fetch(`${url.searchParams.get("redirect_uri")}/?code=c&state=${url.searchParams.get("state")}`);
			},
			now: () => 0,
		});
		expect(await auth.accessToken()).toBe("ok");
		expect(store.value).toBe("fresh");
	});
});
