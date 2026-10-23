// Snapshot the video pipeline's output, or compare a snapshot against a baseline, with code checks only.
// Usage:
//   node spe/evals/video-compare.mjs snapshot <video> <out.json>
//   node spe/evals/video-compare.mjs compare <baseline.json> <candidate.json>
// The snapshot runs watch_video once on a fresh folder and records the wall time.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [mode, a, b] = process.argv.slice(2);

function parseDigest(digest) {
	const ocr = new Set();
	const people = [];
	const frames = [];
	let section = "";
	for (const line of digest.split("\n")) {
		if (/^On screen:/.test(line)) section = "ocr";
		else if (/^People:/.test(line)) section = "people";
		else if (/^(Speech|Sounds|Motion):/.test(line) || line.startsWith("## ")) section = "";
		if (line.startsWith("Frames: ")) {
			for (const m of line.matchAll(/f\d+ (\d+):(\d+\.\d)/g)) frames.push(Number(m[1]) * 60 + Number(m[2]));
		}
		if (section === "ocr" && /^ {2}f\d+:/.test(line)) {
			for (const m of line.matchAll(/"((?:[^"\\]|\\.)*)"/g)) ocr.add(m[1].toLowerCase());
		}
		if (section === "people" && /^ {2}f\d+:/.test(line)) people.push(line.replace(/^ {2}f\d+: /, ""));
	}
	return { ocr: [...ocr], people, frames };
}

async function snapshot(video, out) {
	const { watchVideo, estimateTokens } = await import(new URL("../../dist/video/index.js", import.meta.url).href);
	const dir = mkdtempSync(join(tmpdir(), "vsnap-"));
	const t0 = performance.now();
	const r = await watchVideo(video, dir);
	const wallMs = Math.round(performance.now() - t0);
	const analysis = JSON.parse(readFileSync(join(dir, "analysis.json"), "utf8"));
	const snap = {
		video,
		wallMs,
		estTokens: estimateTokens(r.digest, r.inline.length),
		inlineImages: r.inline.length,
		transcript: (analysis.transcript?.segments ?? []).map((s) => s.text).join(" "),
		segments: (analysis.transcript?.segments ?? []).map((s) => [s.start, s.end]),
		sounds: analysis.sounds.map((e) => ({ kind: e.kind, label: e.label, start: e.start, end: e.end })),
		cuts: analysis.motion?.cuts ?? [],
		spans: (analysis.motion?.spans ?? []).map((s) => ({
			start: s.start,
			end: s.end,
			camera: s.camera,
			subject: s.subject,
		})),
		duration: analysis.info.duration,
		...parseDigest(r.digest),
		dir,
	};
	writeFileSync(out, JSON.stringify(snap, null, 1));
	console.log(JSON.stringify({ video: video.split("/").pop(), wallMs, estTokens: snap.estTokens }));
}

/** Fraction of 0.5 s bins where the label covering the bin agrees. */
function binAgreement(base, cand, key, duration) {
	const at = (spans, t) => spans.find((s) => t >= s.start && t < s.end)?.[key] ?? "none";
	let same = 0;
	let n = 0;
	for (let t = 0.25; t < duration; t += 0.5) {
		n++;
		if (at(base, t) === at(cand, t)) same++;
	}
	return n ? same / n : 1;
}

function compare(base, cand) {
	const jac = (x, y) => {
		const X = new Set(x);
		const Y = new Set(y);
		const inter = [...X].filter((v) => Y.has(v)).length;
		const uni = new Set([...X, ...Y]).size;
		return uni ? inter / uni : 1;
	};
	const soundKey = (e) => `${e.kind}:${e.label ?? ""}:${Math.round(e.start)}`;
	const near = (xs, ys, tol) => xs.every((x) => ys.some((y) => Math.abs(x - y) <= tol)) && xs.length === ys.length;
	const meanNearest = (xs, ys) =>
		xs.length ? xs.reduce((s, x) => s + Math.min(...ys.map((y) => Math.abs(x - y)), 99), 0) / xs.length : 0;
	const ocrRecall = base.ocr.length ? base.ocr.filter((l) => cand.ocr.includes(l)).length / base.ocr.length : 1;
	// Lines the baseline never read, such as junk from a faster recognizer. Rain has no text, so recall alone
	// cannot fail there.
	const ocrExtra = cand.ocr.filter((l) => !base.ocr.includes(l)).length;
	const r = {
		speedup: Math.round((base.wallMs / cand.wallMs) * 100) / 100,
		wallMs: [base.wallMs, cand.wallMs],
		transcriptSame: base.transcript === cand.transcript,
		soundJaccard: Math.round(jac(base.sounds.map(soundKey), cand.sounds.map(soundKey)) * 100) / 100,
		cutsSame: near(base.cuts, cand.cuts, 0.3),
		cameraAgreement: Math.round(binAgreement(base.spans, cand.spans, "camera", base.duration) * 100) / 100,
		subjectAgreement: Math.round(binAgreement(base.spans, cand.spans, "subject", base.duration) * 100) / 100,
		keyframes: [base.frames.length, cand.frames.length],
		keyframeShiftS: Math.round(meanNearest(base.frames, cand.frames) * 100) / 100,
		ocrRecall: Math.round(ocrRecall * 100) / 100,
		ocrExtra,
		people: [base.people.length, cand.people.length],
		estTokens: [base.estTokens, cand.estTokens],
	};
	// Gates for "no quality loss". Motion labels come from sampled flow, so allow small drift.
	r.pass =
		r.transcriptSame &&
		r.soundJaccard >= 0.9 &&
		r.cutsSame &&
		r.cameraAgreement >= 0.85 &&
		r.subjectAgreement >= 0.8 &&
		Math.abs(r.keyframes[1] - r.keyframes[0]) <= 4 &&
		r.ocrRecall >= 0.8 &&
		r.ocrExtra <= 1 &&
		r.keyframeShiftS <= 0.15 &&
		r.people[0] === r.people[1] &&
		r.estTokens[1] < 10_000;
	return r;
}

if (mode === "snapshot") await snapshot(a, b);
else if (mode === "compare") {
	console.log(JSON.stringify(compare(JSON.parse(readFileSync(a, "utf8")), JSON.parse(readFileSync(b, "utf8")))));
} else throw new Error("usage: snapshot <video> <out.json> | compare <base.json> <cand.json>");
