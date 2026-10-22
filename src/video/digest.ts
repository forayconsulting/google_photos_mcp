import { basename, dirname } from "node:path";
import { type ClapMatch, describeClap } from "./clap.js";
import type { Keyframe } from "./frames.js";
import type { MotionSpan } from "./motion.js";
import type { VideoInfo } from "./probe.js";
import { describeSound, type SoundEvent } from "./sounds.js";
import type { Transcript, TranscriptSegment } from "./transcribe.js";
import { fmtRange, fmtTime } from "./util.js";
import { describePeople, type OcrResult, type PoseResult } from "./vision.js";

export interface DigestInput {
	source: string;
	info: VideoInfo;
	transcript: Transcript | null;
	sounds: SoundEvent[];
	cuts: number[];
	spans: MotionSpan[];
	motionFps: number;
	keyframes: Keyframe[];
	ocr: OcrResult[];
	poses: PoseResult[];
	clap: ClapMatch[];
	storyboards: string[];
	motionImages: { path: string; start: number; end: number; kind: "strip" | "trail" }[];
	audioStrip?: string;
}

const MAX_SEGMENT_S = 30;

export const READING_NOTES = [
	"How to read this:",
	"- Motion lines come from optical flow on frames sampled several times a second. Speeds are relative, not measured.",
	"- Camera lines describe the camera. Handheld drift is small back-and-forth movement with no steady direction. A new shot starts at a hard cut or a very fast camera move.",
	"- Subject lines describe what moves apart from the camera, by direction, speed, and where in the frame.",
	"- Sound labels come from Apple's on-device sound classifier, with confidence. A sudden sound marks a loudness jump the classifier could not label.",
	"- You cannot hear this audio. Tone of voice, music content, and audio quality are not captured beyond these labels and the spectrogram.",
	"- Fast events between frames can be missed. Call inspect_video with start and end to look closer at any moment.",
];

/** Splits the timeline at scene cuts, then splits long scenes into equal parts of 30 s or less. */
export function segmentBounds(duration: number, cuts: number[]): [number, number][] {
	const edges = [0, ...cuts.filter((c) => c > 0 && c < duration), duration];
	const out: [number, number][] = [];
	for (let i = 0; i + 1 < edges.length; i++) {
		const [a, b] = [edges[i], edges[i + 1]];
		const parts = Math.max(1, Math.ceil((b - a) / MAX_SEGMENT_S));
		for (let k = 0; k < parts; k++) out.push([a + ((b - a) * k) / parts, a + ((b - a) * (k + 1)) / parts]);
	}
	return out;
}

const inside = (t: number, a: number, b: number, last: boolean) => t >= a && (t < b || (last && t <= b));

export function speechLines(segments: TranscriptSegment[]): string[] {
	return segments.map((s) => `  [${fmtTime(s.start)}] ${s.text}`);
}

export function textOnScreen(frames: { id?: string; path: string }[], ocr: OcrResult[]): string[] {
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const f of frames) {
		const r = ocr.find((o) => o.path === f.path);
		const fresh = (r?.lines ?? []).map((l) => l.text).filter((t) => !seen.has(t));
		for (const t of fresh) seen.add(t);
		if (fresh.length) lines.push(`  ${f.id ?? basename(f.path)}: ${fresh.map((t) => JSON.stringify(t)).join(", ")}`);
	}
	return lines;
}

export function peopleLines(frames: { id?: string; path: string }[], poses: PoseResult[]): string[] {
	const lines: string[] = [];
	let last = "";
	for (const f of frames) {
		const pose = poses.find((p) => p.path === f.path);
		const d = pose ? describePeople(pose) : "";
		if (d && d !== last) lines.push(`  ${f.id ?? basename(f.path)}: ${d}`);
		last = d;
	}
	return lines;
}

export function soundLines(events: SoundEvent[]): string[] {
	return events.map((e) =>
		e.kind === "onset"
			? `  ${fmtTime(e.start)} ${describeSound(e)}`
			: `  ${fmtRange(e.start, e.end)} ${describeSound(e)}`,
	);
}

export function buildDigest(d: DigestInput): string {
	const { info } = d;
	const segs = d.transcript?.segments ?? [];
	const out: string[] = [
		`# Video digest: ${basename(d.source)}`,
		`Duration ${fmtTime(info.duration)}, ${info.hasVideo ? `${info.width}x${info.height}, ${info.fps.toFixed(0)} fps${info.rotation ? `, rotated ${info.rotation} degrees` : ""}` : "audio only"}. Audio: ${info.hasAudio ? `yes${d.transcript?.language ? `, speech language ${d.transcript.language}` : ""}` : "none"}.`,
		`${d.cuts.length + 1} shot(s), ${d.keyframes.length} keyframes, ${segs.length} speech segment(s), ${d.sounds.filter((s) => s.kind !== "silence").length} sound event(s).${info.hasVideo ? ` Motion sampled ${d.motionFps} times a second.` : ""}`,
		`Source: ${d.source}`,
		"",
		...READING_NOTES,
	];
	if (d.clap.length)
		out.push("", "## Sounds you asked about (CLAP, cosine score)", ...d.clap.map((m) => `- ${describeClap(m)}`));

	const bounds = segmentBounds(info.duration, d.cuts);
	bounds.forEach(([a, b], i) => {
		const last = i === bounds.length - 1;
		const sceneNo = d.cuts.filter((c) => c <= a + 1e-6).length + 1;
		out.push("", `## ${fmtRange(a, b)} (shot ${sceneNo})`);
		const spans = d.spans.filter((s) => s.start < b && s.end > a);
		if (spans.length) out.push("Motion:", ...spans.map((s) => `  ${s.text}`));
		const frames = d.keyframes.filter((f) => inside(f.t, a, b, last));
		if (frames.length) out.push(`Frames: ${frames.map((f) => `${f.id} ${fmtTime(f.t)}`).join(", ")}`);
		const ocr = textOnScreen(frames, d.ocr);
		if (ocr.length) out.push("On screen:", ...ocr);
		const people = peopleLines(frames, d.poses);
		if (people.length) out.push("People:", ...people);
		const speech = segs.filter((s) => inside(s.start, a, b, last));
		if (speech.length) out.push("Speech:", ...speechLines(speech));
		const sounds = d.sounds.filter((s) => inside(s.start, a, b, last));
		if (sounds.length) out.push("Sounds:", ...soundLines(sounds));
	});

	const folder = d.keyframes[0] ? dirname(d.keyframes[0].path) : d.storyboards[0] ? dirname(d.storyboards[0]) : "";
	out.push("", `## Files in ${folder}/`);
	if (d.keyframes.length)
		out.push(
			`- Keyframes: f01.jpg to ${d.keyframes[d.keyframes.length - 1].id}.jpg, full resolution. Open one for detail.`,
		);
	if (d.storyboards.length) out.push(`- Storyboards: ${d.storyboards.map((p) => basename(p)).join(", ")}`);
	for (const m of d.motionImages)
		out.push(
			`- Motion ${m.kind === "strip" ? "frame strip" : "trail, oldest faintest,"} ${fmtRange(m.start, m.end)}: ${basename(m.path)}`,
		);
	if (d.audioStrip) out.push(`- Spectrogram of the whole audio: ${basename(d.audioStrip)}`);
	return out.join("\n");
}
