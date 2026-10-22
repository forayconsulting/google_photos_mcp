import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sourceFromEnv } from "../source/index.js";
import { ReplaySource } from "../source/replay.js";
import { TmpStore } from "../tmp.js";

describe("TmpStore", () => {
	it("sweeps folders older than 24 h and removes its own on exit", () => {
		const root = mkdtempSync(join(tmpdir(), "tmpstore-"));
		const old = join(root, "old");
		mkdirSync(old);
		const past = (Date.now() - 25 * 3600 * 1000) / 1000;
		utimesSync(old, past, past);
		const store = new TmpStore(root);
		expect(store.sweep()).toBe(1);
		expect(existsSync(old)).toBe(false);
		const mine = store.sessionDir("s/../1");
		expect(mine.startsWith(root)).toBe(true);
		store.removeOwned();
		expect(existsSync(mine)).toBe(false);
	});
});

describe("sourceFromEnv", () => {
	it("refuses a missing or unknown value instead of defaulting", () => {
		expect(() => sourceFromEnv(undefined)).toThrow(/GPHOTOS_SOURCE/);
		expect(() => sourceFromEnv("live")).toThrow(/GPHOTOS_SOURCE/);
	});
});

describe("ReplaySource", () => {
	function fixture() {
		const dir = mkdtempSync(join(tmpdir(), "replay-"));
		writeFileSync(join(dir, "a.jpg"), "A");
		writeFileSync(
			join(dir, "manifest.json"),
			JSON.stringify({ items: [{ id: "1", createTime: "2026-10-22T09:00:00Z", type: "PHOTO", file: "a.jpg", mediaFile: { baseUrl: "", mimeType: "image/jpeg", filename: "a.jpg" } }] }),
		);
		return dir;
	}

	it("completes the pick only after the picker opens and the delay passes", async () => {
		process.env.GPHOTOS_REPLAY_DELAY_MS = "20";
		const src = new ReplaySource(fixture());
		const s = await src.createSession();
		expect((await src.getSession(s.id)).mediaItemsSet).toBe(false);
		await expect(src.listMediaItems(s.id)).rejects.toThrow(/FAILED_PRECONDITION/);
		src.openPicker(s.pickerUri);
		await new Promise((r) => setTimeout(r, 30));
		expect((await src.getSession(s.id)).mediaItemsSet).toBe(true);
		const items = await src.listMediaItems(s.id);
		const out = join(mkdtempSync(join(tmpdir(), "replay-out-")), "a.jpg");
		await src.download(items[0], out);
		expect(existsSync(out)).toBe(true);
		await src.deleteSession(s.id);
		await expect(src.getSession(s.id)).rejects.toThrow(/not found/);
	});

	it("rejects a fixture whose files are missing", () => {
		const dir = mkdtempSync(join(tmpdir(), "replay-bad-"));
		writeFileSync(join(dir, "manifest.json"), JSON.stringify({ items: [{ id: "1", file: "gone.jpg", mediaFile: {} }] }));
		expect(() => new ReplaySource(dir)).toThrow();
	});
});
