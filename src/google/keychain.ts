import { execFileSync } from "node:child_process";

// The refresh token lives in the macOS login keychain, never on disk in plain text.
const SERVICE = "gphotos-mcp";
const ACCOUNT = "refresh_token";

export interface TokenStore {
	get(): string | null;
	set(value: string): void;
	clear(): void;
}

export const keychainStore: TokenStore = {
	get() {
		try {
			const out = execFileSync("security", ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			});
			return out.trim() || null;
		} catch {
			return null;
		}
	},
	set(value) {
		execFileSync("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", ACCOUNT, "-w", value], {
			stdio: "ignore",
		});
	},
	clear() {
		try {
			execFileSync("security", ["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT], { stdio: "ignore" });
		} catch {
			// Already absent.
		}
	},
};
