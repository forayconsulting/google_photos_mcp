import { join } from "node:path";
import { clapScriptPath, MODELS_DIR, run } from "./deps.js";
import { type LoudnessPoint, meanLoudness } from "./sounds.js";
import { fmtRange, fmtTime } from "./util.js";

export interface ClapScores {
	windows: [number, number][];
	scores: Record<string, number[]>;
}

export interface ClapMatch {
	phrase: string;
	/** Ranges where the phrase scored at or above POSSIBLE, with the best score in each. */
	ranges: { start: number; end: number; score: number }[];
	best: { start: number; end: number; score: number } | undefined;
}

// Cosine similarity bands, from the spike: a present sound scored 0.27 to 0.33 and an absent one about -0.1.
export const LIKELY = 0.2;
export const POSSIBLE = 0.1;
const SILENT_LUFS = -50;

/** Runs the open CLAP model through uv. The model downloads once into MODELS_DIR/hf. */
export async function scoreSounds(
	wav: string,
	phrases: string[],
	opts: { window?: number; hop?: number; signal?: AbortSignal } = {},
): Promise<ClapScores> {
	const out = await run(
		"uv",
		["run", "--quiet", clapScriptPath(), wav, JSON.stringify(phrases), String(opts.window ?? 2), String(opts.hop ?? 1)],
		{ signal: opts.signal, env: { ...process.env, HF_HOME: join(MODELS_DIR, "hf"), TOKENIZERS_PARALLELISM: "false" } },
	);
	return JSON.parse(out) as ClapScores;
}

/** Skips silent windows (CLAP scores digital silence high), then merges windows at or above POSSIBLE. */
export function summarizeClap(scores: ClapScores, loudness: LoudnessPoint[], offset = 0): ClapMatch[] {
	const audible = scores.windows.map(
		([s, e]) => !loudness.length || meanLoudness(loudness, s + offset, e + offset) >= SILENT_LUFS,
	);
	return Object.entries(scores.scores).map(([phrase, values]) => {
		const ranges: ClapMatch["ranges"] = [];
		let best: ClapMatch["best"];
		values.forEach((score, i) => {
			if (!audible[i]) return;
			const [s, e] = scores.windows[i];
			const start = s + offset;
			const end = e + offset;
			if (!best || score > best.score) best = { start, end, score };
			if (score < POSSIBLE) return;
			const last = ranges[ranges.length - 1];
			if (last && start <= last.end) {
				last.end = end;
				last.score = Math.max(last.score, score);
			} else ranges.push({ start, end, score });
		});
		return { phrase, ranges, best };
	});
}

export function describeClap(m: ClapMatch): string {
	if (!m.ranges.length) {
		return `"${m.phrase}": no clear match${m.best ? ` (best ${m.best.score.toFixed(2)} at ${fmtTime(m.best.start)})` : " (no audible audio)"}`;
	}
	const parts = m.ranges.map(
		(r) => `${fmtRange(r.start, r.end)} ${r.score >= LIKELY ? "likely" : "possible"} (${r.score.toFixed(2)})`,
	);
	return `"${m.phrase}": ${parts.join(", ")}`;
}
