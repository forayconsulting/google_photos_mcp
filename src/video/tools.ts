import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { errorResult, progressFor, text } from "../configs/common.js";
import { log } from "../log.js";
import type { PickedSet } from "../manifest.js";
import type { PickDeps } from "../pick.js";
import { inspectVideo, toolResult, watchVideo } from "./index.js";

const target = {
	session_id: z.string().optional().describe("A picked set's session id. Defaults to the most recent pick."),
	index: z.number().int().min(1).optional().describe("The video's index in the picked set's manifest"),
	path: z.string().optional().describe("Any local video file, instead of a picked one"),
};

const listenFor = z
	.array(z.string())
	.max(12)
	.optional()
	.describe("Plain descriptions of specific sounds to search for, such as the sound the user asked about");

/** Finds the video file and the folder its analysis lives in. */
export function resolveVideo(deps: PickDeps, args: { session_id?: string; index?: number; path?: string }) {
	if (args.path) {
		const source = resolve(args.path);
		const st = statSync(source, { throwIfNoEntry: false });
		if (!st?.isFile()) throw new Error(`No file at ${source}`);
		// Keyed by path, size, and time, so an edited file gets a fresh analysis.
		const key = createHash("sha1").update(`${source}:${st.size}:${st.mtimeMs}`).digest("hex").slice(0, 12);
		return { source, outDir: deps.tmp.sessionDir(`video-${key}`) };
	}
	if (args.index === undefined) throw new Error("Give either index (a picked video) or path (a local file).");
	const set = deps.sets.get(args.session_id);
	if (!set) throw new Error("Nothing has been picked yet. Pick the video first, or pass a path.");
	const entry = set.entries.find((e) => e.index === args.index);
	if (!entry) throw new Error(`The picked set has no item ${args.index}.`);
	if (entry.type !== "VIDEO") throw new Error(`Item ${args.index} is a ${entry.type.toLowerCase()}, not a video.`);
	return { source: entry.path, outDir: join(set.dir, ".video", String(entry.index)) };
}

/**
 * Picked videos are watched in the background right after the pick, one at a time, so the work is mostly done
 * when Claude calls watch_video. A queued video that Claude asks for first is taken out of the queue and run
 * directly. Only the first few videos of a pick are prefetched.
 */
const PREFETCH_MAX = 3;
const running = new Map<string, Promise<unknown>>();
const queued = new Map<string, () => void>();
let chain: Promise<unknown> = Promise.resolve();
let prefetchAbort = new AbortController();

/** Stops running and queued prefetches. cleanup_photos and server shutdown call this before deleting folders. */
export async function cancelPrefetch(): Promise<void> {
	prefetchAbort.abort(new Error("prefetch cancelled"));
	prefetchAbort = new AbortController();
	for (const cancel of queued.values()) cancel();
	queued.clear();
	await Promise.all([...running.values()]);
}

export function prefetchVideos(set: PickedSet): void {
	const videos = set.entries.filter((e) => e.type === "VIDEO").slice(0, PREFETCH_MAX);
	for (const e of videos) {
		const outDir = join(set.dir, ".video", String(e.index));
		if (running.has(outDir) || queued.has(outDir)) continue;
		let cancelled = false;
		queued.set(outDir, () => {
			cancelled = true;
		});
		const { signal } = prefetchAbort;
		chain = chain.then(async () => {
			if (cancelled || signal.aborted) return;
			queued.delete(outDir);
			const job = watchVideo(e.path, outDir, { signal }).catch((err) => {
				if (!signal.aborted) log(`prefetch of ${e.path} failed:`, String(err));
			});
			running.set(outDir, job);
			await job;
			running.delete(outDir);
		});
	}
}

/** Waits for a prefetch already working on this folder, or drops it from the queue so the caller runs it now. */
async function settlePrefetch(outDir: string): Promise<void> {
	const cancel = queued.get(outDir);
	if (cancel) {
		cancel();
		queued.delete(outDir);
	}
	await running.get(outDir);
}

export function registerVideoTools(server: McpServer, deps: PickDeps): void {
	server.registerTool(
		"watch_video",
		{
			description:
				"Understand a video without reading it frame by frame. Returns one timeline with the full speech transcript, labeled sounds and sudden sounds, camera and subject motion, on-screen text, and people, plus storyboards and a spectrogram as images. Runs on this Mac. The first run downloads speech models once.",
			inputSchema: { ...target, listen_for: listenFor },
		},
		async ({ session_id, index, path, listen_for }, extra) => {
			try {
				const v = resolveVideo(deps, { session_id, index, path });
				await settlePrefetch(v.outDir);
				const r = await watchVideo(v.source, v.outDir, {
					listenFor: listen_for,
					onProgress: progressFor(extra),
					signal: extra.signal,
				});
				return toolResult(r.digest, r.inline);
			} catch (err) {
				return errorResult(err);
			}
		},
	);

	server.registerTool(
		"inspect_video",
		{
			description:
				"Look closely at one stretch of a video after watch_video. Returns dense frames as strips, a motion trail, frame-by-frame motion, a spectrogram, and the speech and sounds in that window. Use listen_for to check for specific sounds there.",
			inputSchema: {
				...target,
				start: z.number().min(0).describe("Window start in seconds"),
				end: z.number().positive().describe("Window end in seconds"),
				fps: z
					.number()
					.positive()
					.max(30)
					.optional()
					.describe("Frames per second to extract. Defaults to about 12 frames over the window."),
				listen_for: listenFor,
			},
		},
		async ({ session_id, index, path, start, end, fps, listen_for }, extra) => {
			try {
				if (end <= start) return text("Error: end must be after start.");
				const v = resolveVideo(deps, { session_id, index, path });
				await settlePrefetch(v.outDir);
				const r = await inspectVideo(
					v.source,
					v.outDir,
					{ start, end, fps },
					{
						listenFor: listen_for,
						onProgress: progressFor(extra),
						signal: extra.signal,
					},
				);
				return toolResult(r.text, r.inline);
			} catch (err) {
				return errorResult(err);
			}
		},
	);
}
