import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ImageContent } from "@modelcontextprotocol/sdk/types.js";
import { run } from "./deps.js";
import { scaleFilter } from "./frames.js";
import { type FrameDecode, frameFilters, runDecode } from "./probe.js";
import { fmtTime } from "./util.js";

export interface LabeledFrame {
	path: string;
	t: number;
	id?: string;
}

/**
 * The model API scales any image past about 1.15 megapixels or 1568 px on a side down to fit, so a bigger image
 * only costs upload time. Claude Code also counts every image as 1600 tokens toward its MCP output limit, so
 * the useful move is fewer images, each filled to this size.
 */
export const MAX_EDGE = 1568;
export const MAX_PIXELS = 1_150_000;
const LABEL_H = 24;
const PAD = 2;

/** Picks the column count that gives the widest tiles for n frames inside one image of MAX_EDGE and MAX_PIXELS. */
export function gridFor(n: number, aspect: number): { cols: number; rows: number; tile: number } {
	let best = { cols: 1, rows: n, tile: 0 };
	for (let cols = 1; cols <= n; cols++) {
		const rows = Math.ceil(n / cols);
		const fits = (tw: number) => {
			const w = cols * (tw + 2 * PAD);
			const h = rows * (tw * aspect + LABEL_H + 2 * PAD);
			return w <= MAX_EDGE && h <= MAX_EDGE && w * h <= MAX_PIXELS;
		};
		let lo = 16;
		let hi = MAX_EDGE;
		while (hi - lo > 1) {
			const mid = Math.floor((lo + hi) / 2);
			if (fits(mid)) lo = mid;
			else hi = mid;
		}
		if (fits(lo) && lo > best.tile) best = { cols, rows, tile: lo };
	}
	return best;
}

/** Tiles frames into one image with a time label under each tile, sized to the API's native limit. */
export async function montage(
	frames: LabeledFrame[],
	out: string,
	opts: { aspect: number; signal?: AbortSignal },
): Promise<string> {
	const { cols, tile } = gridFor(frames.length, opts.aspect);
	const args = ["montage"];
	for (const f of frames) args.push("-label", `${f.id ? `${f.id} ` : ""}${fmtTime(f.t)}`, f.path);
	args.push(
		"-tile",
		`${cols}x`,
		"-geometry",
		`${tile}x${Math.round(tile * opts.aspect)}+${PAD}+${PAD}`,
		"-background",
		"#111111",
		"-fill",
		"white",
		"-pointsize",
		"15",
		"-quality",
		"85",
		out,
	);
	await run("magick", args, { signal: opts.signal });
	// Rounding in montage can overshoot by a few pixels. Never send more than the API would keep.
	await run("magick", [out, "-resize", `${MAX_EDGE}x${MAX_EDGE}>`, "-resize", `${MAX_PIXELS}@>`, out], {
		signal: opts.signal,
	});
	return out;
}

/** Splits frames evenly over `count` storyboards, each filled to the API's native image size. */
export async function storyboards(
	frames: LabeledFrame[],
	dir: string,
	aspect: number,
	count: number,
	signal?: AbortSignal,
	name = "storyboard",
): Promise<string[]> {
	const boards: string[] = [];
	const n = Math.max(1, Math.min(count, frames.length));
	const per = Math.ceil(frames.length / n);
	for (let i = 0; i < frames.length; i += per) {
		boards.push(
			await montage(frames.slice(i, i + per), join(dir, `${name}-${boards.length + 1}.jpg`), { aspect, signal }),
		);
	}
	return boards;
}

/**
 * One image that shows motion over [start, end]: five evenly spaced frames blended, oldest faintest. The spike
 * found a flat average too faint to read. ffmpeg's tmix applies the first weight to the newest frame.
 */
export async function motionTrail(
	video: string,
	decode: FrameDecode,
	start: number,
	end: number,
	out: string,
	signal?: AbortSignal,
): Promise<string> {
	const dur = Math.max(end - start, 0.2);
	await runDecode(
		decode,
		[
			"-v",
			"error",
			"-y",
			"-ss",
			start.toFixed(3),
			"-t",
			dur.toFixed(3),
			...decode.input,
			"-i",
			video,
			"-an",
			"-vf",
			frameFilters(
				decode,
				[`fps=${(5 / dur).toFixed(4)}`],
				[scaleFilter(960), "tmix=frames=5:weights='6 3 2 1 1'", "select='gte(n\\,4)'"],
			),
			"-frames:v",
			"1",
			"-q:v",
			"3",
			out,
		],
		signal,
	);
	return out;
}

/** Spectrogram with a time axis and a dB legend. Log frequency so speech, music, and bangs are all visible. */
export async function spectrogram(
	wav: string,
	out: string,
	opts: { start?: number; end?: number; width?: number; signal?: AbortSignal } = {},
): Promise<string> {
	const args = ["-v", "error", "-y"];
	if (opts.start !== undefined) args.push("-ss", opts.start.toFixed(3));
	if (opts.end !== undefined) args.push("-t", (opts.end - (opts.start ?? 0)).toFixed(3));
	args.push("-i", wav, "-lavfi", `showspectrumpic=s=${opts.width ?? 1400}x220:legend=1:scale=log:fscale=log`, out);
	await run("ffmpeg", args, { signal: opts.signal });
	return out;
}

export function imageBlock(path: string): ImageContent {
	return {
		type: "image",
		data: readFileSync(path).toString("base64"),
		mimeType: path.endsWith(".png") ? "image/png" : "image/jpeg",
	};
}
