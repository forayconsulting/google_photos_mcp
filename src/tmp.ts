import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log } from "./log.js";

const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Picked files live under $TMPDIR/gphotos-mcp/<session>. macOS also purges unused $TMPDIR files. */
export class TmpStore {
	readonly root: string;
	private owned = new Set<string>();

	constructor(root = process.env.GPHOTOS_TMP_ROOT ?? join(tmpdir(), "gphotos-mcp")) {
		this.root = root;
		mkdirSync(this.root, { recursive: true });
	}

	sessionDir(sessionId: string): string {
		const dir = join(this.root, sessionId.replace(/[^A-Za-z0-9_-]/g, "_"));
		mkdirSync(dir, { recursive: true });
		this.owned.add(dir);
		return dir;
	}

	remove(dir: string): void {
		rmSync(dir, { recursive: true, force: true });
		this.owned.delete(dir);
	}

	/** Deletes session folders older than 24 hours. Runs at startup. */
	sweep(now = Date.now()): number {
		let removed = 0;
		for (const name of readdirSync(this.root)) {
			const dir = join(this.root, name);
			try {
				if (now - statSync(dir).mtimeMs > MAX_AGE_MS) {
					rmSync(dir, { recursive: true, force: true });
					removed++;
				}
			} catch {
				// Raced with another process. Ignore.
			}
		}
		if (removed) log(`swept ${removed} expired session folder(s)`);
		return removed;
	}

	/** Deletes every folder this process created. Runs on exit. */
	removeOwned(): void {
		for (const dir of this.owned) rmSync(dir, { recursive: true, force: true });
		this.owned.clear();
	}
}
