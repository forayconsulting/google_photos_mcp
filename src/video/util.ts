/** Formats seconds as m:ss.s, or h:mm:ss.s past an hour. */
export function fmtTime(seconds: number): string {
	const s = Math.max(0, seconds);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = (s % 60).toFixed(1).padStart(4, "0");
	return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export function fmtRange(start: number, end: number): string {
	return `${fmtTime(start)}-${fmtTime(end)}`;
}

/**
 * Parses the file written by ffmpeg's metadata=print / ametadata=print filters: a "frame:N pts:P pts_time:T" line
 * followed by "key=value" lines. Returns one { t, value } per frame for the given key. -inf and nan become -Infinity.
 */
export function parseMetadataPrint(text: string, key: string): { t: number; value: number }[] {
	const out: { t: number; value: number }[] = [];
	let t: number | undefined;
	for (const line of text.split("\n")) {
		const frame = line.match(/pts_time:([-0-9.e]+)/);
		if (frame) {
			t = Number(frame[1]);
			continue;
		}
		const eq = line.indexOf("=");
		if (t === undefined || eq < 0 || line.slice(0, eq).trim() !== key) continue;
		const v = Number(line.slice(eq + 1));
		out.push({ t, value: Number.isFinite(v) ? v : Number.NEGATIVE_INFINITY });
	}
	return out;
}
