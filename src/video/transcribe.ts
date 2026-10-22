import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { ensureModel, type Progress, run } from "./deps.js";

export interface TranscriptSegment {
	start: number;
	end: number;
	text: string;
}

export interface Transcript {
	language?: string;
	segments: TranscriptSegment[];
}

/** 16 kHz mono PCM, the input whisper.cpp and SoundAnalysis both read. */
export async function extractAudio(video: string, wav: string, signal?: AbortSignal): Promise<void> {
	await run("ffmpeg", ["-v", "error", "-y", "-i", video, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav], {
		signal,
	});
}

interface WhisperJson {
	result?: { language?: string };
	transcription?: { offsets?: { from: number; to: number }; text?: string }[];
}

/** Whisper marks stretches without speech with bracketed tags such as [BLANK_AUDIO]. Those are dropped. */
export function parseWhisper(json: string): Transcript {
	const data = JSON.parse(json) as WhisperJson;
	const segments: TranscriptSegment[] = [];
	for (const s of data.transcription ?? []) {
		const text = (s.text ?? "").trim();
		if (!text || /^[[(][^\])]*[\])]$/.test(text) || !s.offsets) continue;
		segments.push({ start: s.offsets.from / 1000, end: s.offsets.to / 1000, text });
	}
	return { language: data.result?.language, segments };
}

export async function transcribe(
	wav: string,
	outPrefix: string,
	opts: { onProgress?: Progress; signal?: AbortSignal } = {},
): Promise<Transcript> {
	const [model, vad] = await Promise.all([
		ensureModel("whisper", opts.onProgress),
		ensureModel("vad", opts.onProgress),
	]);
	const threads = String(Math.min(8, availableParallelism()));
	await run(
		"whisper-cli",
		["-m", model, "--vad", "-vm", vad, "-l", "auto", "-t", threads, "-oj", "-of", outPrefix, "-np", "-f", wav],
		{ signal: opts.signal },
	);
	return parseWhisper(readFileSync(`${outPrefix}.json`, "utf8"));
}
