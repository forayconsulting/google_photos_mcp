// End-to-end check of the video pipeline on a generated video with known content.
// Runs only when ffmpeg, whisper-cli, magick, uv, the built av-helper, and the downloaded models are all present.
// It never downloads models, so it is skipped on a fresh machine until the first watch_video call.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { MODELS, MODELS_DIR } from "../video/deps.js";
import { inspectVideo, watchVideo } from "../video/index.js";

const helper = resolve("dist/video/native/av-helper");
const have = (bin: string) => spawnSync("/usr/bin/which", [bin]).status === 0;
const ready =
	["ffmpeg", "whisper-cli", "magick", "uv", "say"].every(have) &&
	existsSync(helper) &&
	existsSync(join(MODELS_DIR, MODELS.whisper.file)) &&
	existsSync(join(MODELS_DIR, MODELS.vad.file)) &&
	existsSync(join(MODELS_DIR, "hf"));

function sh(cmd: string, args: string[], cwd: string) {
	const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`${cmd} failed: ${r.stderr}`);
}

/**
 * 30 s, 1280x720. Shot 1 (0-10 s): still color bars, speech from 1 s. Shot 2 (10-20 s): a white box moving right,
 * a 440 Hz tone 12-15 s. Shot 3 (20-30 s): a steady pan right over a still image, a 0.15 s noise burst at 24 s.
 */
function buildTestVideo(dir: string): string {
	const ff = (...args: string[]) => sh("ffmpeg", ["-v", "error", "-y", ...args], dir);
	sh("say", ["-o", "speech.aiff", "The quarterly roadmap has three priorities. First, ship the photo picker."], dir);
	ff("-f", "lavfi", "-i", "smptehdbars=size=1280x720:rate=30", "-t", "10", "-pix_fmt", "yuv420p", "s1.mp4");
	ff(
		"-f",
		"lavfi",
		"-i",
		"color=c=black:size=1280x720:rate=30",
		"-f",
		"lavfi",
		"-i",
		"color=c=white:size=120x120:rate=30",
		"-filter_complex",
		"[0][1]overlay=x='40+t*100':y=300",
		"-t",
		"10",
		"-pix_fmt",
		"yuv420p",
		"s2.mp4",
	);
	ff("-f", "lavfi", "-i", "testsrc=size=2560x720:rate=1", "-frames:v", "1", "wide.png");
	ff(
		"-loop",
		"1",
		"-framerate",
		"30",
		"-i",
		"wide.png",
		"-vf",
		"crop=1280:720:x='t*100':y=0",
		"-t",
		"10",
		"-pix_fmt",
		"yuv420p",
		"s3.mp4",
	);
	ff(
		"-i",
		"s1.mp4",
		"-i",
		"s2.mp4",
		"-i",
		"s3.mp4",
		"-filter_complex",
		"[0][1][2]concat=n=3:v=1:a=0",
		"-pix_fmt",
		"yuv420p",
		"video.mp4",
	);
	ff(
		"-i",
		"speech.aiff",
		"-f",
		"lavfi",
		"-i",
		"sine=f=440:d=3",
		"-f",
		"lavfi",
		"-i",
		"anoisesrc=d=0.15:a=0.9",
		"-f",
		"lavfi",
		"-i",
		"anullsrc=r=48000:cl=mono",
		"-filter_complex",
		"[0]aresample=48000,adelay=1000[a0];[1]aresample=48000,volume=0.5,adelay=12000[a1];[2]aresample=48000,adelay=24000[a2];[3]atrim=0:30[a3];[a3][a0][a1][a2]amix=inputs=4:normalize=0,atrim=0:30[a]",
		"-map",
		"[a]",
		"-ac",
		"1",
		"audio.wav",
	);
	ff("-i", "video.mp4", "-i", "audio.wav", "-c:v", "copy", "-c:a", "aac", "-shortest", "test.mp4");
	return join(dir, "test.mp4");
}

describe.skipIf(!ready)("video pipeline on a known test video", () => {
	let dir: string;
	let video: string;
	let digest: string;

	beforeAll(async () => {
		process.env.GPHOTOS_AV_HELPER = helper;
		dir = mkdtempSync(join(tmpdir(), "video-it-"));
		video = buildTestVideo(dir);
		const r = await watchVideo(video, join(dir, "out"), { listenFor: ["a pure electronic tone", "a dog barking"] });
		digest = r.digest;
	}, 300_000);

	it("transcribes the known sentences", () => {
		expect(digest).toMatch(/\[0:01\.\d\] The quarterly roadmap has three priorities\./);
		expect(digest).toContain("First, ship the photo picker.");
	});

	it("finds both cuts within 0.5 s", () => {
		const starts = [...digest.matchAll(/^## (\d+:\d+\.\d)-\S+ \(shot \d\)/gm)].map((m) => {
			const [mm, ss] = m[1].split(":");
			return Number(mm) * 60 + Number(ss);
		});
		expect(starts).toHaveLength(3);
		expect(Math.abs(starts[1] - 10)).toBeLessThanOrEqual(0.5);
		expect(Math.abs(starts[2] - 20)).toBeLessThanOrEqual(0.5);
	});

	it("reports the box moving right with a still camera, and the pan as camera motion", () => {
		const shot2 = digest.split("(shot 2)")[1].split("(shot 3)")[0];
		const shot3 = digest.split("(shot 3)")[1].split("## Files")[0];
		expect(shot2).toMatch(/Camera still\. Something moving right/);
		expect(shot3).toMatch(/Camera pans right\. Nothing else moves\./);
	});

	it("puts more frames on the moving box than on the still shot", () => {
		const count = (shot: string) =>
			(
				digest
					.split(`(shot ${shot})`)[1]
					.split("\n")
					.find((l) => l.startsWith("Frames:"))
					?.match(/f\d+/g) ?? []
			).length;
		expect(count("2")).toBeGreaterThan(count("1"));
	});

	it("labels the tone and finds the bang as a sudden sound", () => {
		expect(digest).toMatch(/0:12\.\d-0:1\d\.\d (tuning fork|synthesizer|beep|sine wave)/);
		expect(digest).toMatch(/0:2[34]\.\d sudden sound/);
	});

	it("matches the CLAP phrase that is present and not the absent one", () => {
		expect(digest).toMatch(/"a pure electronic tone": 0:1[12]\.\d-0:1[4-6]\.\d (likely|possible)/);
		expect(digest).toMatch(/"a dog barking": no clear match/);
	});

	it("inspects a window with dense frames and window motion", async () => {
		const r = await inspectVideo(video, join(dir, "out"), { start: 12, end: 15 });
		expect(r.text).toMatch(/\d+ frames at/);
		expect(r.text).toMatch(/Something moving right/);
		expect(r.inline.length).toBeGreaterThanOrEqual(3);
	}, 120_000);
});
