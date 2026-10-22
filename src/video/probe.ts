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

interface FfprobeStream {
	codec_type?: string;
	width?: number;
	height?: number;
	avg_frame_rate?: string;
	r_frame_rate?: string;
	duration?: string;
	tags?: { rotate?: string };
	side_data_list?: { rotation?: number }[];
}

function rate(r: string | undefined): number {
	if (!r) return 0;
	const [n, d] = r.split("/").map(Number);
	return d ? n / d : n || 0;
}

export function parseProbe(json: string): VideoInfo {
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
	};
}

export async function probe(path: string, signal?: AbortSignal): Promise<VideoInfo> {
	return parseProbe(
		await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", path], { signal }),
	);
}
