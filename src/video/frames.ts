import { constants, copyFileSync } from "node:fs";
import { join } from "node:path";
import { mapLimit } from "../pick.js";
import { run } from "./deps.js";
import type { Candidates, MotionPoint } from "./motion.js";

export type FrameReason = "scene" | "steady" | "motion";

export interface FrameTime {
	t: number;
	reason: FrameReason;
}

export interface Keyframe extends FrameTime {
	id: string;
	path: string;
}

/** Four storyboards of 9 at most. Round 1 of the video eval packed 12 per board and lost small details. */
export const DEFAULT_MAX_FRAMES = 36;
const MIN_GAP_S = 0.25;
const STEADY_EVERY_S = 15;

/**
 * Shares out the frame budget:
 * - one frame early in every scene,
 * - steady frames about every 15 s, so still stretches are still seen,
 * - the rest placed where motion energy is high, at equal steps of cumulative energy.
 * Frames closer than 0.25 s to a frame already kept are dropped, keeping scene and steady frames first.
 * With `grid` (sorted candidate frame times), each time moves to the nearest candidate first, so the frame can
 * come from the candidates the motion pass already decoded.
 */
export function chooseFrameTimes(
	duration: number,
	cuts: number[],
	points: MotionPoint[],
	maxFrames = DEFAULT_MAX_FRAMES,
	grid?: number[],
): FrameTime[] {
	const budget = Math.max(1, Math.min(maxFrames, Math.ceil(duration * 1.5)));
	const bounds = [0, ...cuts.filter((c) => c > 0 && c < duration), duration];
	const scene: FrameTime[] = [];
	for (let i = 0; i + 1 < bounds.length; i++) {
		const len = bounds[i + 1] - bounds[i];
		scene.push({ t: bounds[i] + Math.min(1, len / 2), reason: "scene" });
	}
	const steadyCount = Math.min(Math.floor(budget / 3), Math.ceil(duration / STEADY_EVERY_S));
	const steady: FrameTime[] = Array.from({ length: steadyCount }, (_, k) => ({
		t: ((k + 0.5) * duration) / steadyCount,
		reason: "steady" as const,
	}));
	const motion: FrameTime[] = [];
	const motionCount = budget - scene.length - steady.length;
	const total = points.reduce((s, p) => s + p.energy * (p.end - p.start), 0);
	if (motionCount > 0 && total > 1e-4 * duration) {
		let acc = 0;
		let k = 0;
		for (const p of points) {
			const mass = p.energy * (p.end - p.start);
			while (k < motionCount && acc + mass >= ((k + 0.5) / motionCount) * total) {
				const frac = mass > 0 ? (((k + 0.5) / motionCount) * total - acc) / mass : 0;
				motion.push({ t: p.start + frac * (p.end - p.start), reason: "motion" });
				k++;
			}
			acc += mass;
		}
	}
	const kept: FrameTime[] = [];
	for (const f of [...scene, ...steady, ...motion]) {
		const clamped = Math.min(Math.max(f.t, 0), Math.max(duration - 0.05, 0));
		const t = grid?.length ? grid[nearestIndex(grid, clamped)] : clamped;
		if (kept.some((k) => Math.abs(k.t - t) < MIN_GAP_S)) continue;
		kept.push({ t, reason: f.reason });
		if (kept.length >= budget) break;
	}
	return kept.sort((a, b) => a.t - b.t);
}

/** Index of the value in a sorted, non-empty array closest to t. */
export function nearestIndex(sorted: number[], t: number): number {
	let lo = 0;
	let hi = sorted.length - 1;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (sorted[mid] < t) lo = mid + 1;
		else hi = mid;
	}
	return lo > 0 && t - sorted[lo - 1] <= sorted[lo] - t ? lo - 1 : lo;
}

/**
 * Copies the candidate frame nearest each time into `dir` as <prefix>NN.jpg. The motion pass wrote the candidates
 * at the same size and quality a seek gives, so this replaces one ffmpeg seek per frame.
 */
export function pickCandidates(times: FrameTime[], candidates: Candidates, dir: string, prefix: string): Keyframe[] {
	const { times: grid, paths } = candidates;
	if (!grid.length || grid.length !== paths.length)
		throw new Error(`Have ${paths.length} candidate frames for ${grid.length} candidate times. Rerun the analysis.`);
	return times.map((f, i) => {
		const k = nearestIndex(grid, f.t);
		const id = `${prefix}${String(i + 1).padStart(2, "0")}`;
		const path = join(dir, `${id}.jpg`);
		// On APFS this is a clone, so it costs no extra disk.
		copyFileSync(paths[k], path, constants.COPYFILE_FICLONE);
		return { t: grid[k], reason: f.reason, id, path };
	});
}

/** Long edge at most `maxEdge`, aspect kept. ffmpeg applies the file's rotation before this. */
export function scaleFilter(maxEdge: number): string {
	return `scale=w='if(gt(iw,ih),min(${maxEdge},iw),-2)':h='if(gt(iw,ih),-2,min(${maxEdge},ih))'`;
}

export async function extractFrames(
	video: string,
	times: FrameTime[],
	dir: string,
	prefix: string,
	signal?: AbortSignal,
): Promise<Keyframe[]> {
	return mapLimit(times, 4, async (f, i) => {
		const id = `${prefix}${String(i + 1).padStart(2, "0")}`;
		const path = join(dir, `${id}.jpg`);
		await run(
			"ffmpeg",
			[
				"-v",
				"error",
				"-y",
				"-ss",
				f.t.toFixed(3),
				"-i",
				video,
				"-frames:v",
				"1",
				"-vf",
				scaleFilter(1280),
				"-q:v",
				"3",
				path,
			],
			{ signal },
		);
		return { ...f, id, path };
	});
}
