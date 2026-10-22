import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { log } from "../log.js";
import { type ClapMatch, describeClap, scoreSounds, summarizeClap } from "./clap.js";
import { type Progress, run } from "./deps.js";
import { buildDigest, peopleLines, READING_NOTES, soundLines, speechLines, textOnScreen } from "./digest.js";
import { chooseFrameTimes, DEFAULT_MAX_FRAMES, extractFrames, type Keyframe, scaleFilter } from "./frames.js";
import { analyzeMotion, type MotionAnalysis, measureMotion, motionFps, sampleFrames } from "./motion.js";
import { probe, type VideoInfo } from "./probe.js";
import { buildSoundEvents, classifySounds, type LoudnessPoint, measureLoudness, type SoundEvent } from "./sounds.js";
import { extractAudio, type Transcript, transcribe } from "./transcribe.js";
import { fmtRange, fmtTime } from "./util.js";
import { detectPoses, recognizeText } from "./vision.js";
import { imageBlock, montage, motionTrail, spectrogram, storyboards } from "./visuals.js";

const ANALYSIS_VERSION = 1;
const MAX_INLINE_STORYBOARDS = 6;
const MAX_INLINE_MOTION = 4;
/** Digest text past this many characters goes to the file only, with the top shown inline. */
const MAX_INLINE_CHARS = 60_000;

/** Signals computed once per video and cached in its folder, so inspect_video does not redo them. */
export interface Analysis {
	version: number;
	source: string;
	size: number;
	mtimeMs: number;
	info: VideoInfo;
	wav?: string;
	transcript: Transcript | null;
	loudness: LoudnessPoint[];
	sounds: SoundEvent[];
	motion: MotionAnalysis | null;
}

export interface VideoOpts {
	onProgress?: Progress;
	signal?: AbortSignal;
}

function stage(opts: VideoOpts, total: number) {
	let n = 0;
	return (message: string) => {
		n++;
		log(`video: ${message}`);
		opts.onProgress?.(n, total, message);
	};
}

export async function analyze(source: string, outDir: string, opts: VideoOpts = {}): Promise<Analysis> {
	if (!existsSync(source)) throw new Error(`No video at ${source}`);
	mkdirSync(outDir, { recursive: true });
	const st = statSync(source);
	const cacheFile = join(outDir, "analysis.json");
	if (existsSync(cacheFile)) {
		const cached = JSON.parse(readFileSync(cacheFile, "utf8")) as Analysis;
		if (
			cached.version === ANALYSIS_VERSION &&
			cached.source === source &&
			cached.size === st.size &&
			cached.mtimeMs === st.mtimeMs
		)
			return cached;
	}
	const step = stage(opts, 4);
	step("Reading the video");
	const info = await probe(source, opts.signal);

	const audio = (async () => {
		if (!info.hasAudio) return { transcript: null, loudness: [], sounds: [] as SoundEvent[], wav: undefined };
		const wav = join(outDir, "audio-16k.wav");
		await extractAudio(source, wav, opts.signal);
		step("Transcribing speech and labeling sounds");
		const [transcript, windows, loudness] = await Promise.all([
			transcribe(wav, join(outDir, "transcript"), opts),
			classifySounds(wav, opts.signal),
			measureLoudness(wav, join(outDir, "loudness.txt"), opts.signal),
		]);
		return { transcript, loudness, sounds: buildSoundEvents(windows, loudness, transcript.segments), wav };
	})();

	const visual = (async () => {
		if (!info.hasVideo) return null;
		const fps = motionFps(info.duration);
		const dir = join(outDir, "motion-frames");
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });
		step("Measuring motion");
		const sampled = await sampleFrames(source, dir, fps, { signal: opts.signal });
		const pairs = await measureMotion(sampled.paths, opts.signal);
		const motion = analyzeMotion(sampled.times, sampled.scores, pairs, fps);
		// The small frames are only needed for flow. Keyframes come from the original later.
		rmSync(dir, { recursive: true, force: true });
		return motion;
	})();

	const [a, motion] = await Promise.all([audio, visual]);
	const analysis: Analysis = {
		version: ANALYSIS_VERSION,
		source,
		size: st.size,
		mtimeMs: st.mtimeMs,
		info,
		wav: a.wav,
		transcript: a.transcript,
		loudness: a.loudness,
		sounds: a.sounds,
		motion,
	};
	writeFileSync(cacheFile, JSON.stringify(analysis));
	step("Analysis done");
	return analysis;
}

function cleanPhrases(listenFor?: string[]): string[] {
	return [...new Set((listenFor ?? []).map((p) => p.trim()).filter(Boolean))];
}

async function clapFor(
	a: Analysis,
	phrases: string[],
	outDir: string,
	window: { start: number; end: number } | undefined,
	signal?: AbortSignal,
): Promise<ClapMatch[]> {
	if (!phrases.length) return [];
	if (!a.wav) throw new Error("This video has no audio track, so listen_for cannot run.");
	let wav = a.wav;
	if (window) {
		wav = join(outDir, `clap-${window.start.toFixed(2)}-${window.end.toFixed(2)}.wav`);
		await run(
			"ffmpeg",
			[
				"-v",
				"error",
				"-y",
				"-ss",
				window.start.toFixed(3),
				"-t",
				(window.end - window.start).toFixed(3),
				"-i",
				a.wav,
				wav,
			],
			{ signal },
		);
	}
	const short = window !== undefined && window.end - window.start < 8;
	const scores = await scoreSounds(wav, phrases, { window: short ? 1 : 2, hop: short ? 0.5 : 1, signal });
	return summarizeClap(scores, a.loudness, window?.start ?? 0);
}

export interface WatchResult {
	digest: string;
	digestPath: string;
	inline: string[];
}

export async function watchVideo(
	source: string,
	outDir: string,
	opts: VideoOpts & { listenFor?: string[]; maxFrames?: number } = {},
): Promise<WatchResult> {
	const a = await analyze(source, outDir, opts);
	const step = stage(opts, 3);
	const { info } = a;
	const motion = a.motion;
	let keyframes: Keyframe[] = [];
	let boards: string[] = [];
	const motionImages: { path: string; start: number; end: number; kind: "strip" | "trail" }[] = [];
	const visDir = join(outDir, "watch");
	rmSync(visDir, { recursive: true, force: true });
	mkdirSync(visDir, { recursive: true });

	const phrases = cleanPhrases(opts.listenFor);
	const clapJob = clapFor(a, phrases, outDir, undefined, opts.signal);

	const aspect = info.width && info.height ? info.height / info.width : 9 / 16;
	if (motion) {
		step("Extracting keyframes and building storyboards");
		const times = chooseFrameTimes(info.duration, motion.cuts, motion.points, opts.maxFrames ?? DEFAULT_MAX_FRAMES);
		keyframes = await extractFrames(source, times, visDir, "f", opts.signal);
		boards = await storyboards(keyframes, visDir, aspect, opts.signal);
		// The busiest spans get a frame strip and a trail. Only spans with real activity qualify.
		const busy = [...motion.spans]
			.filter((s) => s.energy > 0.01 && s.end - s.start >= 0.5)
			.sort((x, y) => y.energy * (y.end - y.start) - x.energy * (x.end - x.start))
			.slice(0, MAX_INLINE_MOTION)
			.sort((x, y) => x.start - y.start);
		for (const [i, s] of busy.entries()) {
			const end = Math.min(s.end, s.start + 6);
			const n = 6;
			const stripTimes = Array.from({ length: n }, (_, k) => ({
				t: s.start + ((k + 0.5) * (end - s.start)) / n,
				reason: "motion" as const,
			}));
			const frames = await extractFrames(source, stripTimes, visDir, `m${i + 1}-`, opts.signal);
			const strip = await montage(frames, join(visDir, `motion-${i + 1}-strip.jpg`), {
				cols: 3,
				tile: 480,
				aspect,
				signal: opts.signal,
			});
			motionImages.push({ path: strip, start: s.start, end, kind: "strip" });
			const trail = await motionTrail(source, s.start, end, join(visDir, `motion-${i + 1}-trail.jpg`), opts.signal);
			motionImages.push({ path: trail, start: s.start, end, kind: "trail" });
		}
	}

	step("Reading on-screen text and poses");
	const paths = keyframes.map((k) => k.path);
	const [ocr, poses, clap] = await Promise.all([
		recognizeText(paths, opts.signal),
		detectPoses(paths, opts.signal),
		clapJob,
	]);
	const audioStrip = a.wav
		? await spectrogram(a.wav, join(visDir, "audio-spectrogram.png"), { signal: opts.signal })
		: undefined;

	const digest = buildDigest({
		source,
		info,
		transcript: a.transcript,
		sounds: a.sounds,
		cuts: motion?.cuts ?? [],
		spans: motion?.spans ?? [],
		motionFps: motion?.fps ?? 0,
		keyframes,
		ocr,
		poses,
		clap,
		storyboards: boards,
		motionImages,
		audioStrip,
	});
	const digestPath = join(outDir, "digest.md");
	writeFileSync(digestPath, digest);
	const inline = [
		...boards.slice(0, MAX_INLINE_STORYBOARDS),
		...motionImages
			.filter((m) => m.kind === "strip")
			.map((m) => m.path)
			.slice(0, MAX_INLINE_MOTION),
		...(audioStrip ? [audioStrip] : []),
	];
	return { digest, digestPath, inline };
}

export interface InspectResult {
	text: string;
	inline: string[];
}

export async function inspectVideo(
	source: string,
	outDir: string,
	window: { start: number; end: number; fps?: number },
	opts: VideoOpts & { listenFor?: string[] } = {},
): Promise<InspectResult> {
	const a = await analyze(source, outDir, opts);
	const start = Math.max(0, window.start);
	const end = Math.min(a.info.duration, window.end);
	if (!(end > start))
		throw new Error(
			`The window ${window.start}-${window.end} s is outside the video (0-${a.info.duration.toFixed(1)} s).`,
		);
	const dur = end - start;
	const fps = Math.min(window.fps ?? Math.min(10, Math.max(1, 12 / dur)), 36 / dur, 30);
	const step = stage(opts, 3);
	const dir = join(outDir, `inspect-${start.toFixed(2)}-${end.toFixed(2)}`);
	rmSync(dir, { recursive: true, force: true });
	const framesDir = join(dir, "frames");
	const smallDir = join(dir, "small");
	mkdirSync(framesDir, { recursive: true });
	mkdirSync(smallDir, { recursive: true });

	const phrases = cleanPhrases(opts.listenFor);
	const clapJob = clapFor(a, phrases, dir, { start, end }, opts.signal);

	step("Extracting frames");
	let frames: { path: string; t: number; id: string }[] = [];
	let motionText: string[] = [];
	const images: string[] = [];
	if (a.info.hasVideo) {
		await run(
			"ffmpeg",
			[
				"-v",
				"error",
				"-y",
				"-ss",
				start.toFixed(3),
				"-t",
				dur.toFixed(3),
				"-i",
				source,
				"-an",
				"-vf",
				`fps=${fps.toFixed(4)},${scaleFilter(1280)}`,
				"-q:v",
				"3",
				join(framesDir, "%03d.jpg"),
			],
			{ signal: opts.signal },
		);
		const small = await sampleFrames(source, smallDir, fps, { start, end, signal: opts.signal });
		frames = small.times
			.map((t, i) => ({
				t,
				id: `i${String(i + 1).padStart(2, "0")}`,
				path: join(framesDir, `${String(i + 1).padStart(3, "0")}.jpg`),
			}))
			.filter((f) => existsSync(f.path));
		step("Measuring motion frame by frame");
		const pairs = await measureMotion(small.paths, opts.signal);
		const m = analyzeMotion(small.times, small.scores, pairs, fps);
		motionText = [...m.cuts.map((c) => `  Scene cut at ${fmtTime(c)}`), ...m.spans.map((s) => `  ${s.text}`)];
		for (let i = 0; i < frames.length; i += 12) {
			images.push(
				await montage(frames.slice(i, i + 12), join(dir, `strip-${images.length + 1}.jpg`), {
					cols: 4,
					tile: 384,
					aspect: a.info.width ? a.info.height / a.info.width : 9 / 16,
					signal: opts.signal,
				}),
			);
		}
		images.push(await motionTrail(source, start, end, join(dir, "trail.jpg"), opts.signal));
	}
	step("Reading text, poses, and sounds");
	const paths = frames.map((f) => f.path);
	const [ocr, poses, clap] = await Promise.all([
		recognizeText(paths, opts.signal),
		detectPoses(paths, opts.signal),
		clapJob,
	]);
	const spec = a.wav
		? await spectrogram(a.wav, join(dir, "spectrogram.png"), { start, end, width: 1200, signal: opts.signal })
		: undefined;
	if (spec) images.push(spec);

	const inWin = (s: number, e: number) => s < end && e > start;
	const lines = [
		`# inspect_video ${fmtRange(start, end)} of ${basename(source)}`,
		`${frames.length} frames at ${fps.toFixed(1)} per second. The strip images show them in order, left to right, then top to bottom. The trail image blends five moments, oldest faintest.`,
		"",
		// Every note except the heading and the pointer back to inspect_video.
		...READING_NOTES.slice(1, -1),
	];
	if (motionText.length) lines.push("", "Motion:", ...motionText);
	const ocrLines = textOnScreen(frames, ocr);
	if (ocrLines.length) lines.push("", "On screen:", ...ocrLines);
	const people = peopleLines(frames, poses);
	if (people.length) lines.push("", "People:", ...people);
	const speech = (a.transcript?.segments ?? []).filter((s) => inWin(s.start, s.end));
	lines.push("", speech.length ? "Speech:" : "Speech: none in this window.", ...speechLines(speech));
	const sounds = a.sounds.filter((s) => inWin(s.start, s.end));
	lines.push("", sounds.length ? "Sounds:" : "Sounds: no labeled events in this window.", ...soundLines(sounds));
	if (clap.length)
		lines.push("", "Sounds you asked about (CLAP, cosine score):", ...clap.map((m) => `  ${describeClap(m)}`));
	lines.push(
		"",
		`Frames: ${framesDir}/ (001.jpg is ${frames[0]?.id ?? "i01"}, numbered in order)`,
		`Images: ${dir}/ (${images.map((p) => basename(p)).join(", ")})`,
	);
	return { text: lines.join("\n"), inline: images };
}

export function toolResult(text: string, images: string[]): CallToolResult {
	const content: CallToolResult["content"] = [
		{
			type: "text",
			text:
				text.length > MAX_INLINE_CHARS
					? `${text.slice(0, MAX_INLINE_CHARS)}\n\n[Digest truncated here. Read the rest from the digest file.]`
					: text,
		},
	];
	for (const p of images) content.push(imageBlock(p));
	return { content };
}
