import { join } from "node:path";
import { durationMs, type PickedMediaItem } from "./google/picker.js";
import { log } from "./log.js";
import { type PickedSet, type PickedSets, toEntry } from "./manifest.js";
import type { PhotoSource } from "./source/types.js";
import type { TmpStore } from "./tmp.js";

const DOWNLOAD_CONCURRENCY = 6;
const DEFAULT_POLL_MS = 5000;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;

export interface PickDeps {
	source: PhotoSource;
	sets: PickedSets;
	tmp: TmpStore;
}

export type Progress = (done: number, total: number | undefined, message: string) => void;

const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		if (signal?.aborted) return reject(new Error("cancelled"));
		const t = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(t);
				reject(new Error("cancelled"));
			},
			{ once: true },
		);
	});

/** File names sort by capture time and stay unique: <createTime>_<filename>. */
export function fileNameFor(item: PickedMediaItem, used: Set<string>): string {
	const stamp = item.createTime.replace(/[:]/g, "-");
	const base = `${stamp}_${item.mediaFile.filename}`.replace(/[/\\]/g, "_");
	let name = base;
	for (let n = 2; used.has(name); n++) name = base.replace(/(\.[^.]*)?$/, `-${n}$1`);
	used.add(name);
	return name;
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i], i);
		}
	});
	await Promise.all(workers);
	return out;
}

export interface StartedPick {
	sessionId: string;
	pickerUri: string;
	/** Resolves once the user clicks Done and every file is downloaded. */
	done: Promise<PickedSet>;
}

/**
 * Creates a session, opens the picker on this laptop, then (in the background of this promise) polls at
 * Google's interval, downloads every picked item, and deletes the session. The model never polls.
 */
export async function startPick(
	deps: PickDeps,
	opts: { maxItems?: number; onProgress?: Progress; signal?: AbortSignal },
): Promise<StartedPick> {
	const { source, sets, tmp } = deps;
	const session = await source.createSession(opts.maxItems);
	source.openPicker(session.pickerUri);
	opts.onProgress?.(0, undefined, "Picker opened in your browser. Select photos, then click Done.");

	const done = (async () => {
		try {
			const started = Date.now();
			const timeoutMs = durationMs(session.pollingConfig?.timeoutIn, DEFAULT_TIMEOUT_MS);
			let s = session;
			while (!s.mediaItemsSet) {
				if (Date.now() - started > timeoutMs) throw new Error("The picker timed out before Done was clicked.");
				await sleep(durationMs(s.pollingConfig?.pollInterval, DEFAULT_POLL_MS), opts.signal);
				s = await source.getSession(session.id);
			}
			const items = (await source.listMediaItems(session.id)).sort((a, b) => a.createTime.localeCompare(b.createTime));
			const dir = tmp.sessionDir(session.id);
			const used = new Set<string>();
			const names = items.map((it) => fileNameFor(it, used));
			let finished = 0;
			opts.onProgress?.(0, items.length, `Downloading ${items.length} item(s)`);
			const entries = await mapLimit(items, DOWNLOAD_CONCURRENCY, async (it, i) => {
				if (opts.signal?.aborted) throw new Error("cancelled");
				const path = join(dir, names[i]);
				await source.download(it, path);
				finished++;
				opts.onProgress?.(finished, items.length, `Downloaded ${finished}/${items.length}`);
				return toEntry(it, i + 1, path);
			});
			const set: PickedSet = { sessionId: session.id, dir, pickedAt: new Date().toISOString(), entries };
			sets.add(set);
			log(`picked ${entries.length} item(s) into ${dir}`);
			return set;
		} finally {
			await source.deleteSession(session.id).catch((err) => log("session delete failed:", String(err)));
		}
	})();
	// Avoid an unhandled rejection if the caller only awaits later (two-step tools).
	done.catch(() => {});
	return { sessionId: session.id, pickerUri: session.pickerUri, done };
}

export async function pickPhotos(
	deps: PickDeps,
	opts: { maxItems?: number; onProgress?: Progress; signal?: AbortSignal },
): Promise<PickedSet> {
	return (await startPick(deps, opts)).done;
}
