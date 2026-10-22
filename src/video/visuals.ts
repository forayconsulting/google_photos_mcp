import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ImageContent } from "@modelcontextprotocol/sdk/types.js";
import { run } from "./deps.js";
import { scaleFilter } from "./frames.js";
import { fmtTime } from "./util.js";

export interface LabeledFrame {
	path: string;
	t: number;
	id?: string;
}

/** Tiles frames into one image with a time label under each tile. */
export async function montage(
	frames: LabeledFrame[],
	out: string,
	opts: { cols: number; tile: number; aspect: number; signal?: AbortSignal },
): Promise<string> {
	const args = ["montage"];
	for (const f of frames) args.push("-label", `${f.id ? `${f.id}  ` : ""}${fmtTime(f.t)}`, f.path);
	args.push(
		"-tile",
		`${opts.cols}x`,
		"-geometry",
		`${opts.tile}x${Math.round(opts.tile * opts.aspect)}+4+4`,
		"-background",
		"#111111",
		"-fill",
		"white",
		"-pointsize",
		"20",
		"-quality",
		"85",
		out,
	);
	await run("magick", args, { signal: opts.signal });
	return out;
}

/** 3x3 storyboards, 9 frames each, about 1560 px wide. `aspect` is height over width, so tiles match the video. */
export async function storyboards(
	frames: LabeledFrame[],
	dir: string,
	aspect: number,
	signal?: AbortSignal,
): Promise<string[]> {
	const boards: string[] = [];
	for (let i = 0; i < frames.length; i += 9) {
		boards.push(
			await montage(frames.slice(i, i + 9), join(dir, `storyboard-${boards.length + 1}.jpg`), {
				cols: 3,
				tile: 512,
				aspect,
				signal,
			}),
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
	start: number,
	end: number,
	out: string,
	signal?: AbortSignal,
): Promise<string> {
	const dur = Math.max(end - start, 0.2);
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
			video,
			"-an",
			"-vf",
			`fps=${(5 / dur).toFixed(4)},${scaleFilter(960)},tmix=frames=5:weights='6 3 2 1 1',select='gte(n\\,4)'`,
			"-frames:v",
			"1",
			"-q:v",
			"3",
			out,
		],
		{ signal },
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
