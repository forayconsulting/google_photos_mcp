import { appendFileSync } from "node:fs";

/** Optional JSONL event log for eval graders (GPHOTOS_EVENT_LOG). Off in normal use. */
export function emit(event: string, data: Record<string, unknown> = {}): void {
	const path = process.env.GPHOTOS_EVENT_LOG;
	if (!path) return;
	appendFileSync(path, `${JSON.stringify({ t: new Date().toISOString(), event, ...data })}\n`);
}
