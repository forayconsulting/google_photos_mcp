import { avHelperPath, run } from "./deps.js";

export interface OcrResult {
	path: string;
	lines: { text: string; confidence: number }[];
}

type Point = [number, number];

interface Detection {
	confidence: number;
	/** [x, y, width, height] as fractions of the image, y measured from the top. */
	box: [number, number, number, number];
}

export interface PoseResult {
	path: string;
	/** Body skeletons. Used for posture only, because their own confidence is always 1. */
	people: { confidence: number; joints: Record<string, Point> }[];
	humans?: Detection[];
	faces?: Detection[];
}

/** Helper processes the keyframes are split across. Vision reads text one image at a time per process, so threads
 * inside the helper saved about 5%, while 4 processes cut OCR wall time by 35 to 47% on the eval keyframes.
 * 6 and 8 were no faster. Each process peaks near 140 MB. */
const OCR_PROCESSES = 4;

export async function recognizeText(paths: string[], signal?: AbortSignal): Promise<OcrResult[]> {
	if (!paths.length) return [];
	// Contiguous chunks, so the flattened results keep the input order.
	const size = Math.ceil(paths.length / OCR_PROCESSES);
	const chunks: string[][] = [];
	for (let i = 0; i < paths.length; i += size) chunks.push(paths.slice(i, i + size));
	const parts = await Promise.all(
		chunks.map(async (c) => JSON.parse(await run(avHelperPath(), ["ocr", ...c], { signal })) as OcrResult[]),
	);
	return parts.flat();
}

export async function detectPoses(paths: string[], signal?: AbortSignal): Promise<PoseResult[]> {
	if (!paths.length) return [];
	return JSON.parse(await run(avHelperPath(), ["pose", ...paths], { signal })) as PoseResult[];
}

function where(x: number): string {
	return x < 0.33 ? "left" : x > 0.67 ? "right" : "center";
}

const inside = (p: Point, b: Detection["box"]) =>
	p[0] >= b[0] && p[0] <= b[0] + b[2] && p[1] >= b[1] && p[1] <= b[1] + b[3];

/**
 * People come from human rectangles, or faces when no body box fits (close selfies). In the video eval, body
 * skeletons alone reported people on an empty street and missed a face filling the frame. A skeleton adds
 * posture only when it lies inside a detected person. y is 0 at the top of the image.
 */
export function describePeople(pose: PoseResult): string {
	const boxes = (pose.humans ?? []).length ? (pose.humans ?? []) : (pose.faces ?? []);
	if (!boxes.length) return "";
	const parts = boxes.map((d) => {
		const facts: string[] = [where(d.box[0] + d.box[2] / 2)];
		const skeleton = pose.people.find((p) => {
			const pts = Object.values(p.joints);
			return pts.length >= 5 && pts.filter((j) => inside(j, d.box)).length >= pts.length / 2;
		});
		if (skeleton) {
			const raised = (["left", "right"] as const).filter((side) => {
				const wrist = skeleton.joints[`${side}_wrist`];
				const shoulder = skeleton.joints[`${side}_shoulder`];
				return wrist && shoulder && wrist[1] < shoulder[1];
			});
			if (raised.length === 2) facts.push("both arms raised");
			else if (raised.length === 1) facts.push(`their ${raised[0]} arm raised`);
		}
		if (!(pose.humans ?? []).length) facts.push("face only");
		return facts.join(", ");
	});
	return `${boxes.length} ${boxes.length === 1 ? "person" : "people"} (${parts.join("; ")})`;
}
