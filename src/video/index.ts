import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { log } from "../log.js";
import { type ClapMatch, describeClap, scoreSounds, summarizeClap } from "./clap.js";
import { type Progress, run } from "./deps.js";
import { buildDigest, peopleLines, READING_NOTES, soundLines, speechLines, textOnScreen } from "./digest.js";
import { chooseFrameTimes, DEFAULT_MAX_FRAMES, type Keyframe, pickCandidates, scaleFilter } from "./frames.js";
import {
	analyzeMotion,
	type Candidates,
	candidateFps,
	type MotionAnalysis,
	measureMotion,
	motionFps,
	sampleFrames,
} from "./motion.js";
import { frameFilters, type ProbedVideo, probe, runDecode, withDecodeFallback } from "./probe.js";
import { buildSoundEvents, classifySounds, type LoudnessPoint, measureLoudness, type SoundEvent } from "./sounds.js";
import { extractAudio, type Transcript, transcribe } from "./transcribe.js";
import { fmtRange, fmtTime } from "./util.js";
import { detectPoses, type OcrResult, type PoseResult, recognizeText } from "./vision.js";
import { imageBlock, montage, motionTrail, spectrogram, storyboards } from "./visuals.js";

/** 2 added keyframe candidates. 3 added info.decode, which every frame-decoding call reads. */
const ANALYSIS_VERSION = 3;
/**
 * Claude Code warns above 10,000 estimated tokens per MCP result and truncates near 25,000. It counts text at
 * exactly round(characters / 4) and every image as 1600 (Claude Code 2.1.308). The estimate below covers the
 * full result text, so the budget can sit just under the warning.
 */
export const RESULT_TOKEN_BUDGET = 9700;
export const IMAGE_TOKENS = 1600;
const MAX_STORYBOARDS = 4;
/** Past 12 frames, tiles in one 1.15-megapixel board get too small to read. */
const MAX_PER_INLINE_BOARD = 12;
/** Digest text past this many characters goes to the file only, with the top shown inline. */
const MAX_INLINE_CHARS = 24_000;

/** The path goes under the title, so it survives when a long digest is cut at MAX_INLINE_CHARS. */
function withDigestPath(digest: string, path: string): string {
	const nl = digest.indexOf("\n");
	return `${digest.slice(0, nl)}\nDigest file (full text): ${path}${digest.slice(nl)}`;
}

export function estimateTokens(text: string, images: number): number {
	return Math.ceil(Math.min(text.length, MAX_INLINE_CHARS) / 4) + images * IMAGE_TOKENS;
}

/** Signals computed once per video and cached in its folder, so inspect_video does not redo them. */
export interface Analysis {
	version: number;
	source: string;
	size: number;
	mtimeMs: number;
	info: ProbedVideo;
	wav?: string;
	transcript: Transcript | null;
	loudness: LoudnessPoint[];
	sounds: SoundEvent[];
	motion: MotionAnalysis | null;
	/** Full-size frames written by the motion pass. Keyframes are copied from these. */
	candidates: Candidates;
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

export interface VisualAnalysis {
	info: ProbedVideo;
	motion: MotionAnalysis;
	candidates: Candidates;
}

/**
 * `onVisual` fires as soon as the motion pass finishes, before the audio branch may be done, so callers can start
 * keyframe work early. It does not fire on a cache hit, where everything is ready at once.
 */
/** One analysis at a time per folder. A second caller waits for the first instead of writing the same files. */
const analyzing = new Map<string, Promise<Analysis>>();

export async function analyze(
	source: string,
	outDir: string,
	opts: VideoOpts & { onVisual?: (v: VisualAnalysis) => void } = {},
): Promise<Analysis> {
	const pending = analyzing.get(outDir);
	if (pending) {
		await pending.catch(() => {});
		return analyze(source, outDir, opts);
	}
	const job = analyzeOnce(source, outDir, opts);
	analyzing.set(outDir, job);
	try {
		return await job;
	} finally {
		if (analyzing.get(outDir) === job) analyzing.delete(outDir);
	}
}

/** Reads a JSON cache file. A missing, truncated, or corrupt file counts as no cache. */
function readCache<T>(file: string): T | undefined {
	if (!existsSync(file)) return undefined;
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch (err) {
		log(`video: ignoring unreadable cache ${file}: ${(err as Error).message}`);
		return undefined;
	}
}

async function analyzeOnce(
	source: string,
	outDir: string,
	opts: VideoOpts & { onVisual?: (v: VisualAnalysis) => void },
): Promise<Analysis> {
	if (!existsSync(source)) throw new Error(`No video at ${source}`);
	mkdirSync(outDir, { recursive: true });
	const st = statSync(source);
	const cacheFile = join(outDir, "analysis.json");
	const cached = readCache<Analysis>(cacheFile);
	if (cached) {
		if (
			cached.version === ANALYSIS_VERSION &&
			cached.source === source &&
			cached.size === st.size &&
			cached.mtimeMs === st.mtimeMs &&
			// Keyframes are copied from the candidates, so a cache whose frames were deleted is not usable.
			cached.candidates.paths.every((p) => existsSync(p))
		)
			return cached;
	}
	const step = stage(opts, 4);
	step("Reading the video");
	const info = await probe(source, opts.signal);
	if (info.hasVideo) log(`video: decoding frames with ${info.decode.label}`);

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
		const candidates = join(outDir, "candidates");
		step("Measuring motion");
		const sampled = await withDecodeFallback(
			info.decode,
			(decode) => {
				for (const d of [dir, candidates]) {
					rmSync(d, { recursive: true, force: true });
					mkdirSync(d, { recursive: true });
				}
				return sampleFrames(source, decode, dir, fps, {
					signal: opts.signal,
					candidates: { dir: candidates, fps: candidateFps(info.duration, fps) },
				});
			},
			opts.signal,
		);
		const pairs = await measureMotion(sampled.paths, opts.signal);
		const motion = analyzeMotion(sampled.times, sampled.scores, pairs, fps);
		// The small frames are only needed for flow. The full-size candidates stay for keyframes.
		rmSync(dir, { recursive: true, force: true });
		opts.onVisual?.({ info, motion, candidates: sampled.candidates });
		return { motion, candidates: sampled.candidates };
	})();

	const [a, v] = await Promise.all([audio, visual]);
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
		motion: v?.motion ?? null,
		candidates: v?.candidates ?? { times: [], paths: [] },
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

/** Bump when anything that shapes a watch result changes: frame choice, digest text, boards, OCR, or people. */
const WATCH_VERSION = 1;

/** Everything that changes a watch result. A repeat call with the same key returns the saved result. */
function watchKey(source: string, opts: { listenFor?: string[]; maxFrames?: number }): string {
	const st = statSync(source);
	return JSON.stringify([
		WATCH_VERSION,
		ANALYSIS_VERSION,
		source,
		st.size,
		st.mtimeMs,
		opts.maxFrames ?? null,
		cleanPhrases(opts.listenFor),
	]);
}

export async function watchVideo(
	source: string,
	outDir: string,
	opts: VideoOpts & { listenFor?: string[]; maxFrames?: number } = {},
): Promise<WatchResult> {
	const visDir = join(outDir, "watch");
	const cacheFile = join(visDir, "watch.json");
	const key = existsSync(source) ? watchKey(source, opts) : "";
	const cached = key ? readCache<WatchResult & { key: string }>(cacheFile) : undefined;
	if (cached) {
		if (cached.key === key && existsSync(cached.digestPath) && cached.inline.every((p) => existsSync(p))) {
			log("video: returning the saved watch result");
			return { digest: cached.digest, digestPath: cached.digestPath, inline: cached.inline };
		}
	}
	const step = stage(opts, 3);
	rmSync(visDir, { recursive: true, force: true });
	mkdirSync(visDir, { recursive: true });

	// Keyframes, OCR, and pose need only the motion pass, so they start while whisper may still be running.
	const seeFrames = (info: ProbedVideo, motion: MotionAnalysis | null, candidates: Candidates) => {
		let keyframes: Keyframe[] = [];
		if (motion) {
			step("Extracting keyframes and reading on-screen text and poses");
			const times = chooseFrameTimes(
				info.duration,
				motion.cuts,
				motion.points,
				opts.maxFrames ?? DEFAULT_MAX_FRAMES,
				candidates.times,
			);
			keyframes = pickCandidates(times, candidates, visDir, "f");
		}
		const paths = keyframes.map((k) => k.path);
		return { keyframes, ocr: recognizeText(paths, opts.signal), poses: detectPoses(paths, opts.signal) };
	};
	let early: ReturnType<typeof seeFrames> | undefined;
	const a = await analyze(source, outDir, {
		...opts,
		onVisual: (v) => {
			early = seeFrames(v.info, v.motion, v.candidates);
			// A failure here surfaces when watchVideo awaits it, not as an unhandled rejection meanwhile.
			early.ocr.catch(() => {});
			early.poses.catch(() => {});
		},
	});
	const { info } = a;
	const motion = a.motion;
	const seen = early ?? seeFrames(info, motion, a.candidates);
	const { keyframes } = seen;

	const phrases = cleanPhrases(opts.listenFor);
	const clapJob = clapFor(a, phrases, outDir, undefined, opts.signal);
	const audioStripJob = a.wav
		? spectrogram(a.wav, join(visDir, "audio-spectrogram.png"), { signal: opts.signal })
		: Promise.resolve(undefined);
	const aspect = info.width && info.height ? info.height / info.width : 9 / 16;
	const digestPath = join(outDir, "digest.md");
	const digestFor = (
		storyboardPaths: string[],
		parts: { ocr: OcrResult[]; poses: PoseResult[]; clap: ClapMatch[]; audioStrip?: string },
	) =>
		withDigestPath(
			buildDigest({
				source,
				info,
				transcript: a.transcript,
				sounds: a.sounds,
				cuts: motion?.cuts ?? [],
				spans: motion?.spans ?? [],
				motionFps: motion?.fps ?? 0,
				keyframes,
				storyboards: storyboardPaths,
				...parts,
			}),
			digestPath,
		);

	// Storyboards get whatever image budget the text and the spectrogram leave, from 1 to 4. When that budget
	// cannot show every keyframe at 12 or fewer per board, the inline boards show an evenly spaced overview and
	// full 9-frame boards go to disk for Claude to open.
	const fullCount = Math.ceil(keyframes.length / 9);
	const draftNames = Array.from({ length: MAX_STORYBOARDS + fullCount }, (_, i) =>
		join(visDir, `storyboard-${i + 1}.jpg`),
	);
	const boardCount = (parts: Parameters<typeof digestFor>[1]) => {
		const left = RESULT_TOKEN_BUDGET - estimateTokens(digestFor(draftNames, parts), a.wav ? 1 : 0);
		return Math.max(1, Math.min(MAX_STORYBOARDS, Math.floor(left / IMAGE_TOKENS)));
	};
	const buildBoards = async (count: number): Promise<{ boards: string[]; inline: string[] }> => {
		if (!keyframes.length) return { boards: [], inline: [] };
		if (keyframes.length <= count * MAX_PER_INLINE_BOARD) {
			const boards = await storyboards(keyframes, visDir, aspect, count, opts.signal);
			return { boards, inline: boards };
		}
		const n = count * MAX_PER_INLINE_BOARD;
		const pick = Array.from({ length: n }, (_, i) => keyframes[Math.floor(((i + 0.5) * keyframes.length) / n)]);
		const overview = await storyboards(pick, visDir, aspect, count, opts.signal, "overview");
		const full = await storyboards(keyframes, visDir, aspect, fullCount, opts.signal);
		return { boards: [...overview, ...full], inline: overview };
	};
	// The final count depends on OCR and pose text, so boards are built for the count without them while OCR runs,
	// and rebuilt only if the real text changes the count.
	const guess = boardCount({ ocr: [], poses: [], clap: [] });
	const boardsJob = buildBoards(guess);
	// Awaited below. This only keeps a cancel or an OCR failure from leaving it as an unhandled rejection meanwhile.
	boardsJob.catch(() => {});
	const [ocr, poses, clap, audioStrip] = await Promise.all([seen.ocr, seen.poses, clapJob, audioStripJob]);
	const parts = { ocr, poses, clap, audioStrip };
	const count = boardCount(parts);
	let built = await boardsJob;
	if (count !== guess) {
		log(`video: rebuilding storyboards for ${count} board(s) instead of ${guess}`);
		for (const f of built.boards) rmSync(f, { force: true });
		built = await buildBoards(count);
	}
	const digest = digestFor(built.boards, parts);
	writeFileSync(digestPath, digest);
	const result = { digest, digestPath, inline: [...built.inline, ...(audioStrip ? [audioStrip] : [])] };
	writeFileSync(cacheFile, JSON.stringify({ key, ...result }));
	return result;
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
	// Awaited after frame work. This keeps an early failure (no audio, or a cancel) from being unhandled meanwhile.
	clapJob.catch(() => {});

	step("Extracting frames");
	let frames: { path: string; t: number; id: string }[] = [];
	let motionText: string[] = [];
	const images: string[] = [];
	if (a.info.hasVideo) {
		// The decoder that works for the first call is used for the rest of the window.
		let decode = a.info.decode;
		await withDecodeFallback(
			a.info.decode,
			(d) => {
				decode = d;
				return runDecode(
					d,
					[
						"-v",
						"error",
						"-y",
						"-ss",
						start.toFixed(3),
						"-t",
						dur.toFixed(3),
						...d.input,
						"-i",
						source,
						"-an",
						"-vf",
						frameFilters(d, [`fps=${fps.toFixed(4)}`], [scaleFilter(1280)]),
						// Frames are matched to sampleFrames times by position, so none may be padded or dropped.
						"-fps_mode",
						"passthrough",
						"-q:v",
						"3",
						join(framesDir, "%03d.jpg"),
					],
					opts.signal,
				);
			},
			opts.signal,
		);
		const small = await sampleFrames(source, decode, smallDir, fps, { start, end, signal: opts.signal });
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
		// Up to 18 frames per strip keeps a 36-frame window to two images plus the trail and spectrogram.
		for (let i = 0; i < frames.length; i += 18) {
			images.push(
				await montage(frames.slice(i, i + 18), join(dir, `strip-${images.length + 1}.jpg`), {
					aspect: a.info.width ? a.info.height / a.info.width : 9 / 16,
					signal: opts.signal,
				}),
			);
		}
		images.push(await motionTrail(source, decode, start, end, join(dir, "trail.jpg"), opts.signal));
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
