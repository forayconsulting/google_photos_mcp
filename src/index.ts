#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerConfigA } from "./configs/a.js";
import { registerHighLevel } from "./configs/high.js";
import { log } from "./log.js";
import { PickedSets } from "./manifest.js";
import { registerPrompts, serverInstructions } from "./prompts.js";
import { sourceFromEnv } from "./source/index.js";
import { TmpStore } from "./tmp.js";

// GPHOTOS_CONFIG selects the tool surface under evaluation. C is the baseline and the default.
type ConfigId = "a" | "b" | "c" | "d" | "e";
const config = (process.env.GPHOTOS_CONFIG ?? "c").toLowerCase() as ConfigId;
if (!["a", "b", "c", "d", "e"].includes(config)) {
	log(`GPHOTOS_CONFIG must be one of a, b, c, d, e (got ${JSON.stringify(config)})`);
	process.exit(1);
}

const source = sourceFromEnv();
const tmp = new TmpStore();
tmp.sweep();
const deps = { source, tmp, sets: new PickedSets() };

const withSteering = config === "c" || config === "d" || config === "e";
const pickTool = config === "e" ? "start_pick and then wait_for_pick" : "pick_photos";

const server = new McpServer(
	{ name: "gphotos-mcp", version: "0.1.0" },
	withSteering ? { instructions: serverInstructions(pickTool) } : {},
);

if (config === "a") registerConfigA(server, deps);
else registerHighLevel(server, deps, { thumbnails: config === "d", twoStep: config === "e" });
if (withSteering) registerPrompts(server, pickTool);

let cleaned = false;
function cleanup(): void {
	if (cleaned) return;
	cleaned = true;
	tmp.removeOwned();
}
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
	process.on(sig, () => {
		cleanup();
		process.exit(0);
	});
}
process.stdin.on("end", () => {
	cleanup();
	process.exit(0);
});

await server.connect(new StdioServerTransport());
log(`ready (config ${config}, source ${source.kind}, tmp ${tmp.root})`);
