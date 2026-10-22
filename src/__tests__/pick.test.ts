import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PickedMediaItem, PickingSession } from "../google/picker.js";
import { filterEntries, PickedSets } from "../manifest.js";
import { fileNameFor, pickPhotos, startPick } from "../pick.js";
import type { PhotoSource } from "../source/types.js";
import { TmpStore } from "../tmp.js";

function item(id: string, createTime: string, filename = `${id}.jpg`, type: PickedMediaItem["type"] = "PHOTO"): PickedMediaItem {
	return { id, createTime, type, mediaFile: { baseUrl: `b/${id}`, mimeType: "image/jpeg", filename, mediaFileMetadata: { cameraMake: "Google", cameraModel: "Pixel" } } };
}

function fakeSource(items: PickedMediaItem[], pollsUntilSet = 2, failDownload = false) {
	let polls = 0;
	const calls: string[] = [];
	const src: PhotoSource = {
		kind: "replay",
		async createSession(): Promise<PickingSession> {
			calls.push("create");
			return { id: "sess-1", pickerUri: "https://picker/sess-1", pollingConfig: { pollInterval: "0.01s", timeoutIn: "5s" } };
		},
		async getSession(id) {
			calls.push("get");
			polls++;
			return polls >= pollsUntilSet ? { id, pickerUri: "", mediaItemsSet: true } : { id, pickerUri: "", pollingConfig: { pollInterval: "0.01s" } };
		},
		async listMediaItems() {
			calls.push("list");
			return items;
		},
		async download(_it, dest) {
			if (failDownload) throw new Error("boom");
			writeFileSync(dest, "x");
			return 1;
		},
		async deleteSession() {
			calls.push("delete");
		},
		openPicker: vi.fn(() => {
			calls.push("open");
		}),
	};
	return { src, calls };
}

const deps = (src: PhotoSource) => ({ source: src, sets: new PickedSets(), tmp: new TmpStore(mkdtempSync(join(tmpdir(), "pick-test-"))) });

describe("pickPhotos", () => {
	it("opens the picker, polls until Done, downloads sorted by time, then deletes the session", async () => {
		const { src, calls } = fakeSource([item("b", "2026-10-22T10:00:00Z"), item("a", "2026-10-22T09:00:00Z")]);
		const d = deps(src);
		const set = await pickPhotos(d, {});
		expect(calls).toEqual(["create", "open", "get", "get", "list", "delete"]);
		expect(set.entries.map((e) => e.filename)).toEqual(["a.jpg", "b.jpg"]);
		expect(set.entries.every((e) => existsSync(e.path))).toBe(true);
		expect(d.sets.get()?.sessionId).toBe("sess-1");
	});

	it("deletes the session even when a download fails", async () => {
		const { src, calls } = fakeSource([item("a", "2026-10-22T09:00:00Z")], 1, true);
		await expect(pickPhotos(deps(src), {})).rejects.toThrow("boom");
		expect(calls.at(-1)).toBe("delete");
	});

	it("stops polling and deletes the session when cancelled", async () => {
		const { src, calls } = fakeSource([], 1_000_000);
		const ac = new AbortController();
		const p = pickPhotos(deps(src), { signal: ac.signal });
		setTimeout(() => ac.abort(), 30);
		await expect(p).rejects.toThrow("cancelled");
		expect(calls.at(-1)).toBe("delete");
	});

	it("startPick returns before the user finishes", async () => {
		const { src } = fakeSource([item("a", "2026-10-22T09:00:00Z")], 3);
		const started = await startPick(deps(src), {});
		expect(started.sessionId).toBe("sess-1");
		const set = await started.done;
		expect(set.entries).toHaveLength(1);
	});
});

describe("fileNameFor", () => {
	it("prefixes capture time and keeps names unique", () => {
		const used = new Set<string>();
		const a = fileNameFor(item("1", "2026-10-22T09:00:00Z", "IMG.jpg"), used);
		const b = fileNameFor(item("2", "2026-10-22T09:00:00Z", "IMG.jpg"), used);
		expect(a).toBe("2026-10-22T09-00-00Z_IMG.jpg");
		expect(b).toBe("2026-10-22T09-00-00Z_IMG-2.jpg");
	});
});

describe("filterEntries", () => {
	const entries = [
		{ index: 1, path: "", filename: "", createTime: "2026-10-22T09:00:00Z", type: "PHOTO", mimeType: "", cameraModel: "Pixel 10" },
		{ index: 2, path: "", filename: "", createTime: "2026-10-22T10:00:00Z", type: "VIDEO", mimeType: "", cameraModel: "Pixel 10" },
		{ index: 3, path: "", filename: "", createTime: "2026-10-22T11:00:00Z", type: "PHOTO", mimeType: "", cameraModel: "Other" },
	];
	it("filters by half-open time window, type, and camera", () => {
		expect(filterEntries(entries, { after: "2026-10-22T10:00:00Z" }).map((e) => e.index)).toEqual([2, 3]);
		expect(filterEntries(entries, { before: "2026-10-22T10:00:00Z" }).map((e) => e.index)).toEqual([1]);
		expect(filterEntries(entries, { type: "PHOTO", camera: "pixel" }).map((e) => e.index)).toEqual([1]);
	});
	it("rejects bad timestamps", () => {
		expect(() => filterEntries(entries, { after: "yesterday" })).toThrow(/ISO 8601/);
	});
});
