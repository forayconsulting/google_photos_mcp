import { execFile, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { log } from "../log.js";

/** (done, total, message). Matches pick.ts's Progress so the same MCP progress sender works. */
export type Progress = (done: number, total: number | undefined, message: string) => void;

const INSTALL: Record<string, string> = {
	ffmpeg: "brew install ffmpeg",
	ffprobe: "brew install ffmpeg",
	"whisper-cli": "brew install whisper-cpp",
	magick: "brew install imagemagick",
	uv: "brew install uv",
};

const found = new Map<string, string>();

/** Absolute path of a required binary. Fails with the install line when it is missing. No degraded mode. */
export function requireBin(name: string): string {
	const cached = found.get(name);
	if (cached) return cached;
	// MCP clients may start the server without Homebrew or uv on PATH, so their standard folders are searched too.
	const PATH = [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".local", "bin")]
		.filter(Boolean)
		.join(":");
	const r = spawnSync("/usr/bin/which", [name], { encoding: "utf8", env: { ...process.env, PATH } });
	const path = r.stdout.trim();
	if (r.status !== 0 || !path) {
		throw new Error(`Video tools need ${name}, which is not installed. Install it with: ${INSTALL[name] ?? name}`);
	}
	found.set(name, path);
	return path;
}

/** Runs a binary and resolves with stdout. On failure the error carries the last stderr lines. */
export function run(
	bin: string,
	args: string[],
	opts: { signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
	const path = bin.startsWith("/") ? bin : requireBin(bin);
	return new Promise((resolve, reject) => {
		execFile(
			path,
			args,
			{ maxBuffer: 256 * 1024 * 1024, signal: opts.signal, env: opts.env ?? process.env },
			(err, stdout, stderr) => {
				if (err) {
					const tail = String(stderr).trim().split("\n").slice(-4).join(" | ");
					reject(new Error(`${bin.split("/").pop()} failed: ${tail || err.message}`));
				} else resolve(String(stdout));
			},
		);
	});
}

/** The Swift helper. GPHOTOS_AV_HELPER overrides the path, which tests use. */
export function avHelperPath(): string {
	const path = process.env.GPHOTOS_AV_HELPER ?? fileURLToPath(new URL("./native/av-helper", import.meta.url));
	if (!existsSync(path)) throw new Error(`The av-helper binary is missing at ${path}. Run npm run build.`);
	return path;
}

export function clapScriptPath(): string {
	return fileURLToPath(new URL("./native/clap.py", import.meta.url));
}

export const MODELS_DIR = process.env.GPHOTOS_MODELS_DIR ?? join(homedir(), ".cache", "gphotos-mcp", "models");

export const MODELS = {
	whisper: {
		file: "ggml-large-v3-turbo.bin",
		url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin",
	},
	vad: {
		file: "ggml-silero-v5.1.2.bin",
		url: "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin",
	},
} as const;

const downloads = new Map<string, Promise<string>>();

/** Downloads a model once to MODELS_DIR. Writes to a .part file and renames, so a broken download is never used. */
export function ensureModel(model: keyof typeof MODELS, onProgress?: Progress): Promise<string> {
	const { file, url } = MODELS[model];
	const dest = join(MODELS_DIR, file);
	if (existsSync(dest)) return Promise.resolve(dest);
	const pending = downloads.get(file);
	if (pending) return pending;
	const job = (async () => {
		mkdirSync(MODELS_DIR, { recursive: true });
		const part = `${dest}.part`;
		log(`downloading ${file}`);
		const res = await fetch(url);
		if (!res.ok || !res.body) throw new Error(`Download of ${file} failed: HTTP ${res.status}`);
		const total = Number(res.headers.get("content-length") ?? 0) || undefined;
		let done = 0;
		let lastReport = 0;
		const body = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
		body.on("data", (chunk: Buffer) => {
			done += chunk.length;
			if (done - lastReport > 50_000_000) {
				lastReport = done;
				onProgress?.(done, total, `Downloading ${file} (one time only)`);
			}
		});
		try {
			await pipeline(body, createWriteStream(part));
			renameSync(part, dest);
		} catch (err) {
			rmSync(part, { force: true });
			throw err;
		}
		return dest;
	})();
	downloads.set(file, job);
	job.catch(() => downloads.delete(file));
	return job;
}
