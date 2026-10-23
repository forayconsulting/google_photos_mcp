import { readFileSync } from "node:fs";
import { avHelperPath, run } from "./deps.js";
import type { TranscriptSegment } from "./transcribe.js";
import { parseMetadataPrint } from "./util.js";

export interface SoundWindow {
	start: number;
	end: number;
	labels: { label: string; confidence: number }[];
}

export interface LoudnessPoint {
	t: number;
	/** EBU R128 momentary loudness (400 ms window) in LUFS. -Infinity for digital silence. */
	lufs: number;
}

export type SoundEvent =
	| { kind: "label"; start: number; end: number; label: string; confidence: number }
	| { kind: "onset"; start: number; end: number; lufs: number; jump: number }
	| { kind: "silence"; start: number; end: number };

/** SoundAnalysis reads digital silence as "music" at about 0.34, so labels below this floor are dropped. */
export const LABEL_FLOOR = 0.5;
const SILENT_LUFS = -50;
const ONSET_JUMP_LU = 12;
const ONSET_MIN_LUFS = -45;
const MIN_SILENCE_S = 2;

export async function classifySounds(wav: string, signal?: AbortSignal): Promise<SoundWindow[]> {
	return JSON.parse(await run(avHelperPath(), ["sounds", wav], { signal })) as SoundWindow[];
}

export async function measureLoudness(wav: string, outFile: string, signal?: AbortSignal): Promise<LoudnessPoint[]> {
	await run(
		"ffmpeg",
		[
			"-v",
			"error",
			"-nostats",
			"-i",
			wav,
			"-af",
			`ebur128=metadata=1,ametadata=print:key=lavfi.r128.M:file=${outFile.replace(/[\\:']/g, "\\$&")}`,
			"-f",
			"null",
			"-",
		],
		{ signal },
	);
	return parseMetadataPrint(readFileSync(outFile, "utf8"), "lavfi.r128.M").map((p) => ({ t: p.t, lufs: p.value }));
}

/** Mean loudness over [start, end), in LUFS. -Infinity when every point is silent or none fall inside. */
export function meanLoudness(points: LoudnessPoint[], start: number, end: number): number {
	const inside = points.filter((p) => p.t >= start && p.t < end && Number.isFinite(p.lufs));
	if (!inside.length) return Number.NEGATIVE_INFINITY;
	return inside.reduce((s, p) => s + p.lufs, 0) / inside.length;
}

const overlaps = (a0: number, a1: number, b0: number, b1: number) => a0 < b1 && b0 < a1;

/**
 * Turns raw signals into events:
 * - label ranges: consecutive SoundAnalysis windows with the same label, above the floor, in non-silent audio.
 *   "speech" is kept only where whisper found no words (for example distant chatter).
 * - onsets: a jump of 12 LU or more over the quietest point in the previous second. These catch short sounds
 *   such as a bang that no label window covers. Jumps at the start of a transcript segment are speech, not events.
 * - silences of 2 s or more.
 */
export function buildSoundEvents(
	windows: SoundWindow[],
	loudness: LoudnessPoint[],
	transcript: TranscriptSegment[],
): SoundEvent[] {
	const events: SoundEvent[] = [];

	const open = new Map<string, { start: number; end: number; confidence: number }>();
	const flush = (label: string) => {
		const r = open.get(label);
		if (r) events.push({ kind: "label", label, ...r });
		open.delete(label);
	};
	for (const w of windows) {
		if (meanLoudness(loudness, w.start, w.end) < SILENT_LUFS && loudness.length) continue;
		const here = new Set<string>();
		for (const { label, confidence } of w.labels) {
			if (confidence < LABEL_FLOOR) continue;
			if (label === "speech" && transcript.some((s) => overlaps(s.start, s.end, w.start, w.end))) continue;
			here.add(label);
			const r = open.get(label);
			if (r && w.start <= r.end) {
				r.end = w.end;
				r.confidence = Math.max(r.confidence, confidence);
			} else {
				flush(label);
				open.set(label, { start: w.start, end: w.end, confidence });
			}
		}
		for (const label of [...open.keys()]) if (!here.has(label) && w.start > (open.get(label)?.end ?? 0)) flush(label);
	}
	for (const label of [...open.keys()]) flush(label);

	let lastOnset = Number.NEGATIVE_INFINITY;
	for (let i = 0; i < loudness.length; i++) {
		const p = loudness[i];
		if (!Number.isFinite(p.lufs) || p.lufs < ONSET_MIN_LUFS) continue;
		let floor = Number.POSITIVE_INFINITY;
		for (let j = i - 1; j >= 0 && loudness[j].t >= p.t - 1; j--) floor = Math.min(floor, loudness[j].lufs);
		if (floor === Number.POSITIVE_INFINITY) continue;
		// From near or total digital silence the jump means little. -1 marks "rose from silence".
		const jump = Number.isFinite(floor) && floor > -70 ? p.lufs - floor : -1;
		if (jump !== -1 && jump < ONSET_JUMP_LU) continue;
		// The spike measured the meter crossing the jump within 0.1 s of the true start, so p.t is used as is.
		const at = p.t;
		// Loudness jumps during speech are syllables and words, not events.
		if (transcript.some((s) => at >= s.start - 0.6 && at <= s.end + 0.2)) continue;
		if (at - lastOnset < 1) continue;
		lastOnset = at;
		events.push({
			kind: "onset",
			start: at,
			end: at,
			lufs: Math.round(p.lufs),
			jump: jump === -1 ? -1 : Math.round(jump),
		});
	}

	let silentFrom: number | undefined;
	for (const p of [...loudness, { t: Number.POSITIVE_INFINITY, lufs: 0 }]) {
		const silent = p.lufs < SILENT_LUFS;
		if (silent && silentFrom === undefined) silentFrom = p.t;
		if (!silent && silentFrom !== undefined) {
			const end = Number.isFinite(p.t) ? p.t : loudness[loudness.length - 1].t;
			if (end - silentFrom >= MIN_SILENCE_S) events.push({ kind: "silence", start: silentFrom, end });
			silentFrom = undefined;
		}
	}

	return events.sort((a, b) => a.start - b.start);
}

export function describeSound(e: SoundEvent): string {
	if (e.kind === "label") return `${e.label.replace(/_/g, " ")} (${e.confidence.toFixed(2)})`;
	if (e.kind === "onset")
		return `sudden sound, unlabeled (${e.lufs} LUFS, ${e.jump === -1 ? "out of silence" : `${e.jump} LU above the second before`})`;
	return "silence";
}
