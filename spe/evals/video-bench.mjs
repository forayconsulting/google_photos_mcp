// Times each stage of the video pipeline on its own, then the full watch_video and inspect_video calls.
// Usage: node spe/evals/video-bench.mjs <video> [repeats]
// Prints one JSON line. Stage timings run serially, so they add up to more than the parallel wall time.
// watchVideoCached is a repeat call, which returns the saved result.

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dist = new URL("../../dist/video/", import.meta.url);
const m = (f) => import(new URL(f, dist).href);
const { probe } = await m("probe.js");
const { extractAudio, transcribe } = await m("transcribe.js");
const { classifySounds, measureLoudness } = await m("sounds.js");
const { sampleFrames, measureMotion, analyzeMotion, motionFps, candidateFps } = await m("motion.js");
const { chooseFrameTimes, pickCandidates } = await m("frames.js");
const { recognizeText, detectPoses } = await m("vision.js");
const { spectrogram, storyboards } = await m("visuals.js");
const { watchVideo, inspectVideo } = await m("index.js");

const [video, repeats = "1"] = process.argv.slice(2);
const time = async (label, fn, out) => {
	const t0 = performance.now();
	const r = await fn();
	out[label] = Math.round(performance.now() - t0);
	return r;
};

const runs = [];
for (let k = 0; k < Number(repeats); k++) {
	const d = mkdtempSync(join(tmpdir(), "vbench-"));
	const t = {};
	const info = await time("probe", () => probe(video), t);
	const wav = join(d, "a.wav");
	if (info.hasAudio) {
		await time("extractAudio", () => extractAudio(video, wav), t);
		await time("transcribe", () => transcribe(wav, join(d, "tr")), t);
		await time("classifySounds", () => classifySounds(wav), t);
		await time("loudness", () => measureLoudness(wav, join(d, "loud.txt")), t);
		await time("spectrogram", () => spectrogram(wav, join(d, "spec.png")), t);
	}
	const fd = join(d, "mf");
	const cd = join(d, "cand");
	mkdirSync(fd);
	mkdirSync(cd);
	const fps = motionFps(info.duration);
	const s = await time(
		"sampleFrames",
		() => sampleFrames(video, info.decode, fd, fps, { candidates: { dir: cd, fps: candidateFps(info.duration, fps) } }),
		t,
	);
	const pairs = await time("measureMotion", () => measureMotion(s.paths), t);
	const mo = analyzeMotion(s.times, s.scores, pairs, fps);
	const kd = join(d, "kf");
	mkdirSync(kd);
	const times = chooseFrameTimes(info.duration, mo.cuts, mo.points, undefined, s.candidates.times);
	const kf = await time("pickKeyframes", async () => pickCandidates(times, s.candidates, kd, "f"), t);
	await time("ocr", () => recognizeText(kf.map((x) => x.path)), t);
	await time("pose", () => detectPoses(kf.map((x) => x.path)), t);
	const aspect = info.width ? info.height / info.width : 9 / 16;
	await time("storyboards", () => storyboards(kf, kd, aspect, 4), t);
	t.stageSum = Object.values(t).reduce((a, b) => a + b, 0);
	const wd = mkdtempSync(join(tmpdir(), "vwatch-"));
	await time("watchVideoWall", () => watchVideo(video, wd), t);
	await time("watchVideoCached", () => watchVideo(video, wd), t);
	await time("inspectVideoWall", () => inspectVideo(video, wd, { start: 2, end: 6 }), t);
	runs.push(t);
}
const med = {};
for (const key of Object.keys(runs[0])) {
	const xs = runs.map((r) => r[key]).sort((a, b) => a - b);
	med[key] = xs[Math.floor(xs.length / 2)];
}
console.log(JSON.stringify({ video: video.split("/").pop(), repeats: Number(repeats), ms: med }));
