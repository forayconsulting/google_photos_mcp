import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { GoogleAuth } from "../google/auth.js";
import { durationMs, PickerClient } from "../google/picker.js";

const fakeAuth = () => {
	let n = 0;
	return { accessToken: vi.fn(async () => `t${++n}`), clearAccessToken: vi.fn() } as unknown as GoogleAuth & {
		clearAccessToken: ReturnType<typeof vi.fn>;
	};
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe("durationMs", () => {
	it("parses Google durations and falls back on junk", () => {
		expect(durationMs("3.5s", 1)).toBe(3500);
		expect(durationMs("1799.97s", 1)).toBeCloseTo(1799970);
		expect(durationMs(undefined, 42)).toBe(42);
		expect(durationMs("abc", 42)).toBe(42);
	});
});

describe("PickerClient", () => {
	it("pages through mediaItems", async () => {
		const fetchMock = vi.fn(async (url: string | URL | Request) => {
			const u = new URL(String(url));
			const token = u.searchParams.get("pageToken");
			if (!token) return json(200, { mediaItems: [{ id: "1" }, { id: "2" }], nextPageToken: "p2" });
			return json(200, { mediaItems: [{ id: "3" }] });
		});
		const c = new PickerClient(fakeAuth(), fetchMock as typeof fetch);
		const items = await c.listMediaItems("s1");
		expect(items.map((i) => i.id)).toEqual(["1", "2", "3"]);
		expect(String(fetchMock.mock.calls[0][0])).toContain("sessionId=s1");
	});

	it("retries once after a 401 with a fresh token", async () => {
		const auth = fakeAuth();
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(json(401, {}))
			.mockResolvedValueOnce(json(200, { id: "s", pickerUri: "u" }));
		const c = new PickerClient(auth, fetchMock as typeof fetch);
		await c.getSession("s");
		expect(auth.clearAccessToken).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer t2");
	});

	it("surfaces the Google status without the raw body", async () => {
		const fetchMock = vi.fn(async () =>
			json(400, { error: { status: "FAILED_PRECONDITION", message: "detail that should not leak" } }),
		);
		const c = new PickerClient(fakeAuth(), fetchMock as typeof fetch);
		const err = await c.listMediaItems("s").catch((e) => e);
		expect(err.message).toContain("FAILED_PRECONDITION");
		expect(err.message).not.toContain("should not leak");
	});

	it("sends maxItemCount as a string and downloads with =d or =dv", async () => {
		const seen: string[] = [];
		const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			seen.push(`${init?.method ?? "GET"} ${url} ${init?.body ?? ""}`);
			return new Response("bytes", { status: 200 });
		});
		const c = new PickerClient(fakeAuth(), fetchMock as typeof fetch);
		await c.createSession(50).catch(() => {});
		expect(seen[0]).toContain('{"pickingConfig":{"maxItemCount":"50"}}');
		const dir = mkdtempSync(join(tmpdir(), "picker-test-"));
		const base = { id: "i", createTime: "t", mediaFile: { baseUrl: "https://lh3.example/x", mimeType: "image/jpeg", filename: "a.jpg" } };
		await c.download({ ...base, type: "PHOTO" }, join(dir, "a.jpg"));
		await c.download({ ...base, type: "VIDEO" }, join(dir, "b.mp4"));
		expect(seen[1]).toContain("https://lh3.example/x=d ");
		expect(seen[2]).toContain("https://lh3.example/x=dv ");
		expect(readFileSync(join(dir, "a.jpg"), "utf8")).toBe("bytes");
	});
});
