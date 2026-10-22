import { describe, expect, it } from "vitest";
import { describeClap, summarizeClap } from "../video/clap.js";
import { buildDigest, segmentBounds } from "../video/digest.js";
import { chooseFrameTimes } from "../video/frames.js";
import { analyzeMotion, cameraFromWindow, findCuts, type MotionPair, type MotionPoint } from "../video/motion.js";
import { parseProbe } from "../video/probe.js";
import { buildSoundEvents, type LoudnessPoint } from "../video/sounds.js";
import { parseWhisper } from "../video/transcribe.js";
import { fmtTime, parseMetadataPrint } from "../video/util.js";
import { describePeople } from "../video/vision.js";

const still = (n: number) => Array.from({ length: n }, () => ({ dt: 0.25, dx: 0, dy: 0, zoom: 0 }));

describe("util", () => {
	it("formats times and parses ffmpeg metadata prints", () => {
		expect(fmtTime(0)).toBe("0:00.0");
		expect(fmtTime(83.27)).toBe("1:23.3");
		expect(fmtTime(3725)).toBe("1:02:05.0");
		const text =
			"frame:0    pts:0       pts_time:0\nlavfi.r128.M=-inf\nframe:1    pts:4800    pts_time:0.1\nlavfi.r128.M=-16.5\n";
		expect(parseMetadataPrint(text, "lavfi.r128.M")).toEqual([
			{ t: 0, value: Number.NEGATIVE_INFINITY },
			{ t: 0.1, value: -16.5 },
		]);
	});
});

describe("parseProbe", () => {
	it("swaps width and height for portrait phone video", () => {
		const info = parseProbe(
			JSON.stringify({
				streams: [
					{
						codec_type: "video",
						width: 3840,
						height: 2160,
						avg_frame_rate: "30/1",
						side_data_list: [{ rotation: 90 }],
					},
					{ codec_type: "audio" },
				],
				format: { duration: "26.49" },
			}),
		);
		expect(info).toMatchObject({ width: 2160, height: 3840, rotation: 90, fps: 30, hasAudio: true, duration: 26.49 });
	});

	it("fails clearly without a duration", () => {
		expect(() => parseProbe(JSON.stringify({ streams: [], format: {} }))).toThrow(/duration/);
	});
});

describe("parseWhisper", () => {
	it("keeps timed speech and drops bracketed non-speech tags", () => {
		const t = parseWhisper(
			JSON.stringify({
				result: { language: "en" },
				transcription: [
					{ offsets: { from: 990, to: 3130 }, text: " The roadmap has three priorities." },
					{ offsets: { from: 4000, to: 5000 }, text: " [BLANK_AUDIO]" },
					{ offsets: { from: 5000, to: 6000 }, text: " (music)" },
				],
			}),
		);
		expect(t).toEqual({
			language: "en",
			segments: [{ start: 0.99, end: 3.13, text: "The roadmap has three priorities." }],
		});
	});
});

describe("buildSoundEvents", () => {
	const loud = (from: number, to: number, lufs: number): LoudnessPoint[] =>
		Array.from({ length: Math.round((to - from) * 10) }, (_, i) => ({ t: from + i / 10, lufs }));

	it("merges label windows, drops silence-music and speech under the transcript, finds a bang", () => {
		const loudness = [
			...loud(0, 5, -20),
			...loud(5, 9, Number.NEGATIVE_INFINITY),
			{ t: 9, lufs: -11 },
			...loud(9.1, 10, -60),
		];
		const windows = [
			{ start: 0, end: 1, labels: [{ label: "speech", confidence: 0.97 }] },
			{ start: 2, end: 3, labels: [{ label: "dog_bark", confidence: 0.8 }] },
			{ start: 2.5, end: 3.5, labels: [{ label: "dog_bark", confidence: 0.9 }] },
			{ start: 3.5, end: 4.5, labels: [{ label: "dog_bark", confidence: 0.4 }] },
			{ start: 6, end: 7, labels: [{ label: "music", confidence: 0.6 }] },
		];
		const events = buildSoundEvents(windows, loudness, [{ start: 0, end: 1.5, text: "hi" }]);
		expect(events.filter((e) => e.kind === "label")).toEqual([
			{ kind: "label", label: "dog_bark", start: 2, end: 3.5, confidence: 0.9 },
		]);
		expect(events.find((e) => e.kind === "onset")).toMatchObject({ start: 9, jump: -1 });
		expect(events.find((e) => e.kind === "silence")).toMatchObject({ start: 5 });
	});

	it("ignores loudness jumps inside speech", () => {
		const loudness = [...loud(0, 1, -60), ...loud(1, 3, -18)];
		const events = buildSoundEvents([], loudness, [{ start: 0.6, end: 3, text: "hello there" }]);
		expect(events.filter((e) => e.kind === "onset")).toEqual([]);
	});
});

describe("CLAP summary", () => {
	it("skips silent windows, merges matches, and bands scores", () => {
		const scores = {
			windows: [
				[0, 2],
				[1, 3],
				[2, 4],
				[3, 5],
			] as [number, number][],
			scores: { "a horse galloping": [0.31, 0.27, 0.05, 0.9], "a dog barking": [-0.1, -0.1, -0.12, 0.5] },
		};
		const loudness = [
			...Array.from({ length: 40 }, (_, i) => ({ t: i / 10, lufs: -20 })),
			...Array.from({ length: 10 }, (_, i) => ({ t: 4 + i / 10, lufs: Number.NEGATIVE_INFINITY })),
		];
		const loudness2 = loudness.map((p) => (p.t >= 3 ? { ...p, lufs: Number.NEGATIVE_INFINITY } : p));
		const [horse, dog] = summarizeClap(scores, loudness2);
		expect(horse.ranges).toEqual([{ start: 0, end: 3, score: 0.31 }]);
		expect(describeClap(horse)).toContain("likely (0.31)");
		expect(dog.ranges).toEqual([]);
		expect(describeClap(dog)).toMatch(/no clear match/);
	});
});

describe("motion", () => {
	it("finds cuts at local peaks above the threshold", () => {
		expect(findCuts([0, 0.25, 0.5, 0.75, 1], [0, 0.05, 0.9, 0.4, 0])).toEqual([0.5]);
	});

	it("labels steady pans, handheld drift, and stillness", () => {
		expect(cameraFromWindow(still(7))).toBe("camera still");
		const pan = Array.from({ length: 7 }, () => ({ dt: 0.25, dx: -0.02, dy: 0, zoom: 0 }));
		expect(cameraFromWindow(pan)).toBe("camera pans right");
		const shake = Array.from({ length: 7 }, (_, i) => ({ dt: 0.25, dx: 0, dy: i % 2 ? 0.03 : -0.03, zoom: 0 }));
		expect(cameraFromWindow(shake)).toBe("camera handheld, drifting slightly");
		const zoom = Array.from({ length: 7 }, () => ({ dt: 0.25, dx: 0, dy: 0, zoom: 0.03 }));
		expect(cameraFromWindow(zoom)).toBe("camera zooms in or moves closer");
	});

	it("describes a subject crossing the frame and splits spans at cuts", () => {
		const times = Array.from({ length: 41 }, (_, i) => i * 0.25);
		const scores = times.map((t) => (t === 5 ? 0.8 : 0));
		const pairs: MotionPair[] = times.slice(1).map((t, i) => {
			const moving = t > 5;
			return {
				from: i,
				to: i + 1,
				content_dx: 0,
				content_dy: 0,
				content_zoom: 0,
				moving_fraction: moving ? 0.02 : 0,
				...(moving
					? {
							subject_x: 0.1 + ((t - 5) / 5) * 0.8,
							subject_y: 0.5,
							subject_dx: 0.02,
							subject_dy: 0,
							subject_speed: 0.02,
						}
					: {}),
			};
		});
		const m = analyzeMotion(times, scores, pairs, 4);
		expect(m.cuts).toEqual([5]);
		expect(m.spans).toHaveLength(2);
		expect(m.spans[0].text).toContain("Camera still. Nothing else moves.");
		expect(m.spans[1].text).toMatch(/moving right \(moderate\) from the left side to the right side/);
	});
});

describe("chooseFrameTimes", () => {
	it("gives every shot a frame and puts the rest where motion is", () => {
		const points: MotionPoint[] = Array.from({ length: 80 }, (_, i) => ({
			start: i * 0.25,
			end: (i + 1) * 0.25,
			camera: "camera still",
			subject: i >= 40 ? "moving right" : "",
			energy: i >= 40 ? 1 : 0,
			subjectSpeed: 0,
			movingFraction: 0,
		}));
		const frames = chooseFrameTimes(20, [10], points, 20);
		expect(frames.length).toBeLessThanOrEqual(20);
		expect(frames.some((f) => f.reason === "scene" && f.t < 10)).toBe(true);
		expect(frames.some((f) => f.reason === "scene" && f.t >= 10)).toBe(true);
		const busy = frames.filter((f) => f.t >= 10).length;
		expect(busy).toBeGreaterThan(frames.length - busy + 4);
		for (let i = 1; i < frames.length; i++) expect(frames[i].t - frames[i - 1].t).toBeGreaterThanOrEqual(0.25);
	});
});

describe("digest", () => {
	it("splits long shots and pairs speech, sounds, and motion by time", () => {
		expect(segmentBounds(70, [10])).toEqual([
			[0, 10],
			[10, 40],
			[40, 70],
		]);
		const text = buildDigest({
			source: "/v/clip.mp4",
			info: { duration: 20, width: 1280, height: 720, rotation: 0, fps: 30, hasVideo: true, hasAudio: true },
			transcript: { language: "en", segments: [{ start: 12, end: 14, text: "Look at this." }] },
			sounds: [{ kind: "onset", start: 3, end: 3, lufs: -12, jump: 30 }],
			cuts: [10],
			spans: [
				{
					start: 10,
					end: 20,
					camera: "camera pans left",
					subject: "",
					energy: 0.1,
					text: "0:10.0-0:20.0 Camera pans left. Nothing else moves.",
				},
			],
			motionFps: 4,
			keyframes: [{ t: 1, reason: "scene", id: "f01", path: "/out/watch/f01.jpg" }],
			ocr: [{ path: "/out/watch/f01.jpg", lines: [{ text: "EXIT", confidence: 1 }] }],
			poses: [],
			clap: [],
			storyboards: ["/out/watch/storyboard-1.jpg"],
			motionImages: [],
		});
		const [first, second] = text.split("## 0:10.0-0:20.0 (shot 2)");
		expect(first).toContain('f01: "EXIT"');
		expect(first).toContain("0:03.0 sudden sound");
		expect(second).toContain("[0:12.0] Look at this.");
		expect(second).toContain("Camera pans left");
		expect(text).toContain("You cannot hear this audio");
	});
});

describe("describePeople", () => {
	it("reports position and raised arms from the person's own side", () => {
		const d = describePeople({
			path: "x",
			people: [
				{
					confidence: 0.9,
					joints: {
						left_shoulder: [0.45, 0.4],
						left_wrist: [0.4, 0.2],
						right_shoulder: [0.55, 0.4],
						right_wrist: [0.6, 0.6],
					},
				},
			],
		});
		expect(d).toBe("1 person (center, their left arm raised, upper body only)");
	});
});
