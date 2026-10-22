// stdout carries only the MCP protocol. Every log line goes to stderr.
export function log(...parts: unknown[]): void {
	console.error("[gphotos-mcp]", ...parts);
}
