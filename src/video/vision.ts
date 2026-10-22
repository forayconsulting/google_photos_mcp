import { avHelperPath, run } from "./deps.js";

export interface OcrResult {
	path: string;
	lines: { text: string; confidence: number }[];
}

type Point = [number, number];

export interface PoseResult {
	path: string;
	people: { confidence: number; joints: Record<string, Point> }[];
}

export async function recognizeText(paths: string[], signal?: AbortSignal): Promise<OcrResult[]> {
	if (!paths.length) return [];
	return JSON.parse(await run(avHelperPath(), ["ocr", ...paths], { signal })) as OcrResult[];
}

export async function detectPoses(paths: string[], signal?: AbortSignal): Promise<PoseResult[]> {
	if (!paths.length) return [];
	return JSON.parse(await run(avHelperPath(), ["pose", ...paths], { signal })) as PoseResult[];
}

function where(x: number): string {
	return x < 0.33 ? "left" : x > 0.67 ? "right" : "center";
}

/** Short posture facts Vision supports well. y is 0 at the top of the image. */
export function describePeople(pose: PoseResult): string {
	if (!pose.people.length) return "";
	const parts = pose.people.map((p) => {
		const xs = Object.values(p.joints).map((j) => j[0]);
		const facts: string[] = [where(xs.reduce((a, b) => a + b, 0) / xs.length)];
		const raised = (["left", "right"] as const).filter((side) => {
			const wrist = p.joints[`${side}_wrist`];
			const shoulder = p.joints[`${side}_shoulder`];
			return wrist && shoulder && wrist[1] < shoulder[1];
		});
		if (raised.length === 2) facts.push("both arms raised");
		else if (raised.length === 1) facts.push(`their ${raised[0]} arm raised`);
		const hasLegs = ["left_knee", "right_knee", "left_ankle", "right_ankle"].some((j) => p.joints[j]);
		if (!hasLegs) facts.push("upper body only");
		return facts.join(", ");
	});
	return `${pose.people.length} ${pose.people.length === 1 ? "person" : "people"} (${parts.join("; ")})`;
}
