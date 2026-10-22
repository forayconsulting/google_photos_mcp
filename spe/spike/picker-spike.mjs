// Phase 0 spike: OAuth loopback + one Picker session + download. Throwaway.
// Usage: node spe/spike/picker-spike.mjs [auth|pick]
// Logs go to stderr. Secrets are never printed.
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const SCOPE = "https://www.googleapis.com/auth/photospicker.mediaitems.readonly";
const KEYCHAIN_SERVICE = "gphotos-mcp";
const KEYCHAIN_ACCOUNT = "refresh_token";
const PICKER = "https://photospicker.googleapis.com/v1";
const log = (...a) => console.error("[spike]", ...a);

const client = JSON.parse(readFileSync(join(homedir(), ".config/gphotos-mcp/client_secret.json"), "utf8")).installed;

const b64url = (buf) => buf.toString("base64url");

function keychainGet() {
	try {
		return execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return null;
	}
}

function keychainSet(value) {
	execFileSync("security", ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w", value], {
		stdio: "ignore",
	});
}

async function auth() {
	const verifier = b64url(randomBytes(32));
	const challenge = b64url(createHash("sha256").update(verifier).digest());
	const state = b64url(randomBytes(16));
	const server = createServer();
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const redirectUri = `http://127.0.0.1:${server.address().port}`;
	const url = new URL(client.auth_uri);
	url.search = new URLSearchParams({
		client_id: client.client_id,
		redirect_uri: redirectUri,
		response_type: "code",
		scope: SCOPE,
		access_type: "offline",
		prompt: "consent",
		state,
		code_challenge: challenge,
		code_challenge_method: "S256",
	}).toString();
	const code = await new Promise((resolve, reject) => {
		server.on("request", (req, res) => {
			const q = new URL(req.url, redirectUri).searchParams;
			if (!q.get("code") && !q.get("error")) {
				res.end();
				return;
			}
			res.end("gphotos-mcp: sign-in complete. You can close this tab.");
			server.close();
			if (q.get("state") !== state) reject(new Error("state mismatch"));
			else if (q.get("error")) reject(new Error(`consent error: ${q.get("error")}`));
			else resolve(q.get("code"));
		});
		log("consent url opened");
		console.log(`CONSENT_URL ${url}`);
		spawn("open", [url.toString()], { stdio: "ignore", detached: true }).unref();
	});
	const res = await fetch(client.token_uri, {
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
	const tok = await res.json();
	if (!res.ok || !tok.refresh_token) throw new Error(`token exchange failed: HTTP ${res.status} ${tok.error ?? ""}`);
	keychainSet(tok.refresh_token);
	log("refresh token stored in keychain; scope:", tok.scope, "expires_in:", tok.expires_in);
}

async function accessToken() {
	const refresh = keychainGet();
	if (!refresh) throw new Error("no refresh token; run auth");
	const res = await fetch(client.token_uri, {
		method: "POST",
		body: new URLSearchParams({
			refresh_token: refresh,
			client_id: client.client_id,
			client_secret: client.client_secret,
			grant_type: "refresh_token",
		}),
	});
	const tok = await res.json();
	if (!res.ok) throw new Error(`refresh failed: HTTP ${res.status} ${tok.error ?? ""}`);
	return tok.access_token;
}

async function api(token, method, path) {
	const res = await fetch(`${PICKER}${path}`, { method, headers: { Authorization: `Bearer ${token}` } });
	const body = res.status === 204 ? {} : await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${body.error?.status ?? ""}`);
	return body;
}

const secs = (d) => Number.parseFloat(String(d ?? "0").replace("s", ""));

async function pick() {
	const token = await accessToken();
	const session = await api(token, "POST", "/sessions");
	log("session created; expireTime:", session.expireTime, "pollingConfig:", JSON.stringify(session.pollingConfig));
	const pickerUrl = `${session.pickerUri}/autoclose`;
	console.log(`PICKER_URL ${pickerUrl}`);
	spawn("open", [pickerUrl], { stdio: "ignore", detached: true }).unref();
	const started = Date.now();
	let s = session;
	while (!s.mediaItemsSet) {
		const wait = secs(s.pollingConfig?.pollInterval) || 5;
		if (s.pollingConfig && Date.now() - started > secs(s.pollingConfig.timeoutIn) * 1000 + 60000) throw new Error("timed out");
		await new Promise((r) => setTimeout(r, wait * 1000));
		s = await api(token, "GET", `/sessions/${session.id}`);
	}
	log(`items set after ${Math.round((Date.now() - started) / 1000)}s`);
	const items = [];
	let pageToken = "";
	do {
		const page = await api(token, "GET", `/mediaItems?sessionId=${session.id}&pageSize=100${pageToken ? `&pageToken=${pageToken}` : ""}`);
		items.push(...(page.mediaItems ?? []));
		pageToken = page.nextPageToken ?? "";
	} while (pageToken);
	const dir = join(tmpdir(), "gphotos-mcp", session.id);
	mkdirSync(dir, { recursive: true });
	for (const it of items) {
		const f = it.mediaFile;
		const suffix = it.type === "VIDEO" ? "=dv" : "=d";
		const res = await fetch(`${f.baseUrl}${suffix}`, { headers: { Authorization: `Bearer ${token}` } });
		const path = join(dir, `${it.createTime.replace(/[:]/g, "-")}_${f.filename}`);
		writeFileSync(path, Buffer.from(await res.arrayBuffer()));
		const { baseUrl, ...meta } = f;
		console.log(JSON.stringify({ path, status: res.status, type: it.type, createTime: it.createTime, ...meta }));
	}
	await api(token, "DELETE", `/sessions/${session.id}`);
	log("session deleted");
}

const cmd = process.argv[2];
if (cmd === "auth") await auth();
else if (cmd === "pick") await pick();
else log("usage: auth | pick");
