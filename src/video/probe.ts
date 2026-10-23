import { log } from "../log.js";
import { run } from "./deps.js";

export interface VideoInfo {
	duration: number;
	/** Display size, after rotation. */
	width: number;
	height: number;
	rotation: number;
	fps: number;
	hasVideo: boolean;
	hasAudio: boolean;
}

/**
 * How ffmpeg decodes this video's frames. VideoToolbox decodes on the media engine and keeps frames on the GPU,
 * so fps and seek trimming drop frames before the 4K copy to memory. On an M4 Pro with 4K HEVC that made 4 fps
 * sampling 2 to 6 times faster than software decode, and every JPEG came out byte-identical.
 */
export interface FrameDecode {
	/** ffmpeg input options, placed before -i. */
	input: string[];
	/** Filters that copy a GPU frame to memory and turn it upright. Empty for software decode. */
	download: string[];
	/** Names the decoder in logs and errors. */
	label: string;
}

export interface ProbedVideo extends VideoInfo {
	decode: FrameDecode;
}

interface FfprobeStream {
	codec_type?: string;
	codec_name?: string;
	pix_fmt?: string;
	width?: number;
	height?: number;
	avg_frame_rate?: string;
	r_frame_rate?: string;
	duration?: string;
	tags?: { rotate?: string };
	side_data_list?: { rotation?: number; displaymatrix?: string }[];
}

function rate(r: string | undefined): number {
	if (!r) return 0;
	const [n, d] = r.split("/").map(Number);
	return d ? n / d : n || 0;
}

/** Codecs and pixel formats that were checked byte-identical to software decode, with VideoToolbox's output format. */
// H.264 is left to software decode. On this M4 Pro, VideoToolbox was 1.5x slower than software for H.264 at 1080p and
// 4K, and 14x slower for a 16-minute 1080p screen recording sampled at 1.3 fps. For HEVC it was 2x faster.
const VT_CODECS = new Set(["hevc"]);
const VT_FORMATS: Record<string, string> = { yuv420p: "nv12", yuv420p10le: "p010le" };

/**
 * The filters ffmpeg's autorotate adds (fftools/ffmpeg_filter.c, ffmpeg 7.1). ffmpeg skips autorotate for GPU
 * frames, so the GPU path adds them itself after the download. They matched autorotate byte for byte for every
 * rotation and flip. Returns null when the turn is not a multiple of 90 degrees.
 */
function uprightFilters(video: FfprobeStream): string[] | null {
	const side = video.side_data_list?.find((d) => d.displaymatrix);
	if (!side?.displaymatrix) return Number(video.tags?.rotate ?? 0) ? null : [];
	const m = side.displaymatrix
		.split("\n")
		.filter((l) => l.includes(":"))
		.flatMap((l) => l.split(":")[1].trim().split(/\s+/).map(Number));
	let theta = -Math.round(side.rotation ?? 0);
	theta -= 360 * Math.floor(theta / 360 + 0.9 / 360);
	if (Math.abs(theta - 90) < 1) return [m[3] > 0 ? "transpose=cclock_flip" : "transpose=clock"];
	if (Math.abs(theta - 180) < 1) return [...(m[0] < 0 ? ["hflip"] : []), ...(m[4] < 0 ? ["vflip"] : [])];
	if (Math.abs(theta - 270) < 1) return [m[3] < 0 ? "transpose=clock_flip" : "transpose=cclock"];
	if (Math.abs(theta) < 1) return m[4] < 0 ? ["vflip"] : [];
	return null;
}

/**
 * VideoToolbox for the formats above. Other codecs and pixel formats use software decode, chosen here up front,
 * because VideoToolbox cannot decode some of them (VP8, 4:2:2, 4:4:4) and the rest were not checked.
 */
function chooseDecode(video: FfprobeStream | undefined): FrameDecode {
	const what = `${video?.codec_name ?? "unknown"} ${video?.pix_fmt ?? "unknown"}`;
	const format = VT_FORMATS[video?.pix_fmt ?? ""];
	const upright = video && VT_CODECS.has(video.codec_name ?? "") && format ? uprightFilters(video) : null;
	if (!upright) return { input: [], download: [], label: `software decode (${what})` };
	return {
		input: ["-noautorotate", "-hwaccel", "videotoolbox", "-hwaccel_output_format", "videotoolbox_vld"],
		download: ["hwdownload", `format=${format}`, ...upright],
		label: `VideoToolbox (${what})`,
	};
}

export function parseProbe(json: string): ProbedVideo {
	const data = JSON.parse(json) as { streams?: FfprobeStream[]; format?: { duration?: string } };
	const streams = data.streams ?? [];
	const video = streams.find((s) => s.codec_type === "video");
	const hasAudio = streams.some((s) => s.codec_type === "audio");
	const duration = Number(data.format?.duration ?? video?.duration ?? 0);
	if (!(duration > 0)) throw new Error("Could not read the video's duration.");
	const rotation = Number(
		video?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? video?.tags?.rotate ?? 0,
	);
	const quarter = Math.abs(rotation) % 180 === 90;
	const w = video?.width ?? 0;
	const h = video?.height ?? 0;
	return {
		duration,
		width: quarter ? h : w,
		height: quarter ? w : h,
		rotation,
		fps: rate(video?.avg_frame_rate) || rate(video?.r_frame_rate),
		hasVideo: Boolean(video),
		hasAudio,
		decode: chooseDecode(video),
	};
}

export async function probe(path: string, signal?: AbortSignal): Promise<ProbedVideo> {
	return parseProbe(
		await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", path], { signal }),
	);
}

/**
 * The -vf chain around the decode's download step. `gpu` filters see GPU frames on the VideoToolbox path, so they
 * may only drop frames (fps), never touch pixels. `cpu` filters see upright frames in memory on both paths.
 */
export function frameFilters(decode: FrameDecode, gpu: string[], cpu: string[]): string {
	return [...gpu, ...decode.download, ...cpu].join(",");
}

/** Runs an ffmpeg call that decodes frames. ffmpeg's own error does not say which decoder failed, so this adds it. */
export async function runDecode(decode: FrameDecode, args: string[], signal?: AbortSignal): Promise<void> {
	try {
		await run("ffmpeg", args, { signal });
	} catch (err) {
		if (signal?.aborted) throw err;
		throw new Error(`Decoding frames with ${decode.label} failed. ${(err as Error).message}`);
	}
}

export const SOFTWARE_DECODE: FrameDecode = { input: [], download: [], label: "software decode" };

/**
 * Runs a frame-decoding job with the chosen decoder, and once more with software decode if VideoToolbox fails, for
 * example on a damaged file or when the media engine is busy. Both produce the same frames, so the retry changes
 * only speed, and it is logged.
 */
export async function withDecodeFallback<T>(
	decode: FrameDecode,
	job: (d: FrameDecode) => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	try {
		return await job(decode);
	} catch (err) {
		if (signal?.aborted || !decode.input.length) throw err;
		log(`video: ${decode.label} failed, retrying with software decode. ${(err as Error).message}`);
		return job(SOFTWARE_DECODE);
	}
}
