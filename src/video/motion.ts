import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { avHelperPath, run } from "./deps.js";
import { fmtRange, parseMetadataPrint } from "./util.js";

/** One av-helper motion result between consecutive sample frames. Distances are fractions of frame width. */
export interface MotionPair {
	from: number;
	to: number;
	/** How the picture content moved: the opposite of the camera's pan or tilt. */
	content_dx: number;
	content_dy: number;
	/** Positive when content grows (zoom in), negative when it shrinks (zoom out). */
	content_zoom: number;
	/** Rotation of the content per pair, in radians. Positive is clockwise on screen. */
	content_roll?: number;
	/** Share of the frame the camera fit explains. */
	background_fraction?: number;
	moving_fraction: number;
	subject_x?: number;
	subject_y?: number;
	subject_dx?: number;
	subject_dy?: number;
	subject_speed?: number;
}

export interface MotionPoint {
	start: number;
	end: number;
	camera: string;
	/** Direction of subject motion, such as "moving right". Empty when nothing moves apart from the camera. */
	subject: string;
	subjectX?: number;
	subjectY?: number;
	/** Relative activity used to share out frames. 0 for still. */
	energy: number;
	subjectSpeed: number;
	movingFraction: number;
}

export interface MotionSpan {
	start: number;
	end: number;
	camera: string;
	subject: string;
	energy: number;
	text: string;
}

export interface MotionAnalysis {
	fps: number;
	times: number[];
	cuts: number[];
	points: MotionPoint[];
	spans: MotionSpan[];
}

/** Scene cut threshold on ffmpeg's scene score, from the spike: cuts scored 0.66 and 0.88, motion under 0.1. */
const CUT_SCORE = 0.3;
const MIN_SPAN_S = 0.75;

/** Samples frames for motion analysis. 4 per second up to 5 minutes, then fewer, so long videos stay under ~1200. */
export function motionFps(duration: number): number {
	return duration <= 300 ? 4 : Math.max(0.5, Math.round((1200 / duration) * 10) / 10);
}

export async function sampleFrames(
	video: string,
	dir: string,
	fps: number,
	opts: { start?: number; end?: number; signal?: AbortSignal } = {},
): Promise<{ paths: string[]; times: number[]; scores: number[] }> {
	const metaFile = join(dir, "scores.txt");
	const window =
		opts.start === undefined ? [] : ["-ss", opts.start.toFixed(3), "-t", ((opts.end ?? 0) - opts.start).toFixed(3)];
	await run(
		"ffmpeg",
		[
			"-v",
			"error",
			"-y",
			...window,
			"-i",
			video,
			"-an",
			"-vf",
			`fps=${fps},scale=320:-2,select='gte(scene,0)',metadata=print:key=lavfi.scene_score:file=${metaFile.replace(/[\\:']/g, "\\$&")}`,
			"-q:v",
			"4",
			join(dir, "%05d.jpg"),
		],
		{ signal: opts.signal },
	);
	const offset = opts.start ?? 0;
	const meta = parseMetadataPrint(readFileSync(metaFile, "utf8"), "lavfi.scene_score");
	const paths = readdirSync(dir)
		.filter((f) => f.endsWith(".jpg"))
		.sort()
		.map((f) => join(dir, f));
	const n = Math.min(paths.length, meta.length);
	return {
		paths: paths.slice(0, n),
		times: meta.slice(0, n).map((m) => m.t + offset),
		scores: meta.slice(0, n).map((m) => m.value),
	};
}

export async function measureMotion(paths: string[], signal?: AbortSignal): Promise<MotionPair[]> {
	if (paths.length < 2) return [];
	return JSON.parse(await run(avHelperPath(), ["motion", ...paths], { signal })) as MotionPair[];
}

export function findCuts(times: number[], scores: number[]): number[] {
	const cuts: number[] = [];
	for (let i = 1; i < scores.length; i++) {
		const s = scores[i];
		if (s < CUT_SCORE || s < (scores[i - 1] ?? 0) || s < (scores[i + 1] ?? 0)) continue;
		if (cuts.length && times[i] - cuts[cuts.length - 1] < 0.5) continue;
		cuts.push(times[i]);
	}
	return cuts;
}

function region(x: number, y: number): string {
	const col = x < 0.33 ? "left" : x > 0.67 ? "right" : "center";
	const row = y < 0.33 ? "top" : y > 0.67 ? "bottom" : "middle";
	if (row === "middle") return col === "center" ? "center" : `${col} side`;
	return col === "center" ? row : `${row}-${col}`;
}

/** Screen direction of a vector in image coordinates (y grows downward). */
function direction(dx: number, dy: number): string {
	const h = dx > 0 ? "right" : "left";
	const v = dy > 0 ? "down" : "up";
	const ax = Math.abs(dx);
	const ay = Math.abs(dy);
	if (ax > 2 * ay) return h;
	if (ay > 2 * ax) return v;
	return `${v} and ${h}`;
}

interface CameraStep {
	dt: number;
	dx: number;
	dy: number;
	zoom: number;
}

// Calibrated on two Pixel phone clips and the synthetic test video (spe/spike/video-findings.md).
/** Camera speeds below this, in frame widths per second, count as still. Flow noise on still frames is ~0.03. */
const STILL_RATE = 0.04;
/** A pan or tilt must move at least this fast overall, in frame widths per second. */
const STEADY_RATE = 0.04;
/** A zoom must change scale at least this fast overall, as a fraction per second. Handheld wobble reaches ~0.05. */
const STEADY_ZOOM_RATE = 0.08;
/** Above this rate, motion with no steady direction is erratic, not a gentle handheld drift. */
const ERRATIC_RATE = 0.25;

/**
 * Labels the camera from a window of steps. A direction counts only when the net movement along it is at least
 * half the total back-and-forth movement. Handheld shake moves a lot but nets out, so it is labeled as handheld.
 */
export function cameraFromWindow(steps: CameraStep[]): string {
	const T = steps.reduce((a, s) => a + s.dt, 0) || 1;
	const sum = (f: (s: CameraStep) => number) => steps.reduce((a, s) => a + f(s), 0);
	const netX = sum((s) => s.dx);
	const netY = sum((s) => s.dy);
	const netZ = sum((s) => s.zoom);
	const pathXY = sum((s) => Math.hypot(s.dx, s.dy));
	const pathZ = sum((s) => Math.abs(s.zoom));
	if (pathXY / T < STILL_RATE && pathZ / T < STILL_RATE) return "camera still";
	const parts: string[] = [];
	const steady = (net: number, path: number, rate = STEADY_RATE) =>
		Math.abs(net) / T >= rate && Math.abs(net) >= 0.5 * path;
	// Content moving left means the camera turned right. Content moving up means it tilted down.
	if (
		steady(
			netX,
			sum((s) => Math.abs(s.dx)),
		)
	)
		parts.push(`pans ${netX > 0 ? "left" : "right"}`);
	if (
		steady(
			netY,
			sum((s) => Math.abs(s.dy)),
		)
	)
		parts.push(`tilts ${netY > 0 ? "up" : "down"}`);
	if (steady(netZ, pathZ, STEADY_ZOOM_RATE))
		parts.push(netZ > 0 ? "zooms in or moves closer" : "zooms out or moves back");
	if (parts.length) return `camera ${parts.join(" and ")}`;
	return pathXY / T >= ERRATIC_RATE ? "camera moving erratically" : "camera handheld, drifting slightly";
}

function subjectKey(p: MotionPair): string {
	if (p.moving_fraction < 0.005 || !p.subject_speed) return "";
	const net = Math.hypot(p.subject_dx ?? 0, p.subject_dy ?? 0);
	// Little net drift relative to speed means parts move in different directions: legs, hands, water.
	return net < 0.3 * p.subject_speed ? "moving in place" : `moving ${direction(p.subject_dx ?? 0, p.subject_dy ?? 0)}`;
}

function mode(values: string[]): string {
	const counts = new Map<string, number>();
	for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
	return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * Replaces each label with the most common label among its neighbors (two on each side, same scene).
 * Single-pair flickers come from noisy flow, mostly on featureless frames.
 */
export function smoothLabels(points: MotionPoint[]): MotionPoint[] {
	return points.map((p, i) => {
		if (p.camera === "cut") return p;
		const near: MotionPoint[] = [];
		for (let j = i - 1; j >= Math.max(0, i - 2) && points[j].camera !== "cut"; j--) near.push(points[j]);
		near.push(p);
		for (let j = i + 1; j <= Math.min(points.length - 1, i + 2) && points[j].camera !== "cut"; j++)
			near.push(points[j]);
		return { ...p, camera: mode(near.map((n) => n.camera)), subject: mode(near.map((n) => n.subject)) };
	});
}

function size(fraction: number): string {
	return fraction < 0.05 ? "a small area" : fraction < 0.25 ? "part of the frame" : "most of the frame";
}

/** Frame widths per second. Fast crosses the frame in about 5 s or less. Flow reads short, so these are relative. */
function speed(perSecond: number): string {
	return perSecond < 0.05 ? "slow" : perSecond < 0.2 ? "moderate" : "fast";
}

export function analyzeMotion(times: number[], scores: number[], pairs: MotionPair[], fps: number): MotionAnalysis {
	const cuts = findCuts(times, scores);
	const cutSet = new Set(cuts);
	// Camera labels look at about 1.75 s around each pair (three pairs each side at 4 fps), within the scene.
	const steps: (CameraStep | null)[] = pairs.map((p) => {
		const start = times[p.from];
		const end = times[p.to];
		if (start === undefined || end === undefined || cutSet.has(end)) return null;
		return { dt: Math.max(end - start, 1e-3), dx: p.content_dx, dy: p.content_dy, zoom: p.content_zoom };
	});
	const reach = Math.max(1, Math.round(fps * 0.875));
	const cameraAt = (i: number) => {
		const win: CameraStep[] = [];
		for (let j = i; j >= Math.max(0, i - reach) && steps[j]; j--) win.push(steps[j] as CameraStep);
		for (let j = i + 1; j <= Math.min(steps.length - 1, i + reach) && steps[j]; j++) win.push(steps[j] as CameraStep);
		return cameraFromWindow(win);
	};
	const points: MotionPoint[] = [];
	for (const [i, p] of pairs.entries()) {
		const start = times[p.from];
		const end = times[p.to];
		if (start === undefined || end === undefined) continue;
		const dt = Math.max(end - start, 1e-3);
		// Flow across a cut compares two different shots and means nothing.
		if (cutSet.has(end)) {
			points.push({ start, end, camera: "cut", subject: "", energy: 0, subjectSpeed: 0, movingFraction: 0 });
			continue;
		}
		const camSpeed = Math.hypot(p.content_dx, p.content_dy) / dt + Math.abs(p.content_zoom) / dt;
		const subjectSpeed = (p.subject_speed ?? 0) / dt;
		const camera = cameraAt(i);
		// While the camera moves, leftover flow over most of the frame is usually depth (parallax), not a subject.
		const subject = camera !== "camera still" && p.moving_fraction >= 0.5 ? "uneven" : subjectKey(p);
		// A steady pan needs fewer frames than a moving subject, so camera motion counts for less.
		const energy = camSpeed * 0.25 + (subject ? subjectSpeed * Math.min(1, p.moving_fraction * 10) : 0);
		points.push({
			start,
			end,
			camera,
			subject,
			subjectX: p.subject_x,
			subjectY: p.subject_y,
			energy,
			subjectSpeed,
			movingFraction: p.moving_fraction,
		});
	}
	return { fps, times, cuts, points, spans: mergeSpans(smoothLabels(points)) };
}

/** Joins runs of points with the same camera and subject labels. Runs shorter than 0.75 s fold into the run before. */
export function mergeSpans(points: MotionPoint[]): MotionSpan[] {
	type Run = { start: number; end: number; camera: string; subject: string; pts: MotionPoint[] };
	const runs: Run[] = [];
	for (const p of points) {
		if (p.camera === "cut") {
			runs.push({ start: p.end, end: p.end, camera: "cut", subject: "", pts: [] });
			continue;
		}
		const last = runs[runs.length - 1];
		if (last && last.camera === p.camera && last.subject === p.subject) {
			last.end = p.end;
			last.pts.push(p);
		} else runs.push({ start: p.start, end: p.end, camera: p.camera, subject: p.subject, pts: [p] });
	}
	const merged: Run[] = [];
	for (const r of runs) {
		const prev = merged[merged.length - 1];
		if (r.camera !== "cut" && prev && prev.camera !== "cut" && r.end - r.start < MIN_SPAN_S) {
			prev.end = r.end;
			prev.pts.push(...r.pts);
			continue;
		}
		if (r.camera !== "cut" && prev && prev.camera !== "cut" && prev.end - prev.start < MIN_SPAN_S) {
			// A short run at the start of a scene takes the label of the run after it.
			prev.end = r.end;
			prev.camera = r.camera;
			prev.subject = r.subject;
			prev.pts.push(...r.pts);
			continue;
		}
		merged.push({ ...r, pts: [...r.pts] });
	}
	// Joining short runs can leave neighbors with equal labels. Join those too.
	const out: Run[] = [];
	for (const r of merged) {
		if (r.camera === "cut") continue;
		const prev = out[out.length - 1];
		if (prev && prev.end === r.start && prev.camera === r.camera && prev.subject === r.subject) {
			prev.end = r.end;
			prev.pts.push(...r.pts);
		} else out.push(r);
	}
	return out.map((r) => {
		const n = Math.max(r.pts.length, 1);
		const energy = r.pts.reduce((s, p) => s + p.energy, 0) / n;
		const subjectSpeed = r.pts.reduce((s, p) => s + p.subjectSpeed, 0) / n;
		const fraction = r.pts.reduce((s, p) => s + p.movingFraction, 0) / n;
		let subjectText = "Nothing else moves.";
		if (r.subject === "uneven") {
			subjectText =
				"Near and far parts move differently across most of the frame: depth (parallax), a large subject, or many moving things.";
		} else if (r.subject) {
			const placed = r.pts.filter((p) => p.subject && p.subjectX !== undefined);
			// Median of the first and last few positions, so one noisy pair does not set the end points.
			const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0.5;
			const k = Math.max(1, Math.min(3, Math.floor(placed.length / 3)));
			const head = placed.slice(0, k);
			const tail = placed.slice(-k);
			const x0 = med(head.map((p) => p.subjectX ?? 0.5));
			const y0 = med(head.map((p) => p.subjectY ?? 0.5));
			const x1 = med(tail.map((p) => p.subjectX ?? 0.5));
			const y1 = med(tail.map((p) => p.subjectY ?? 0.5));
			const mid = region(med(placed.map((p) => p.subjectX ?? 0.5)), med(placed.map((p) => p.subjectY ?? 0.5)));
			// "From A to B" only when the moving area really traveled, the way the flow says it moved.
			const travel = Math.hypot(x1 - x0, y1 - y0);
			const agrees =
				(r.subject.includes("right") && x1 > x0) ||
				(r.subject.includes("left") && x1 < x0) ||
				(r.subject.includes("down") && y1 > y0) ||
				(r.subject.includes("up") && y1 < y0);
			const from = region(x0, y0);
			const to = region(x1, y1);
			const where =
				placed.length && travel > 0.15 && agrees && from !== to
					? `from the ${from} to the ${to}`
					: `mostly at the ${mid}`;
			subjectText = `Something ${r.subject} (${speed(subjectSpeed)}) ${where}, covering ${size(fraction)}.`;
		}
		const cam = r.camera.charAt(0).toUpperCase() + r.camera.slice(1);
		return {
			start: r.start,
			end: r.end,
			camera: r.camera,
			subject: r.subject,
			energy,
			text: `${fmtRange(r.start, r.end)} ${cam}. ${subjectText}`,
		};
	});
}
