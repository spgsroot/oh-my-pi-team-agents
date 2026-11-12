#!/usr/bin/env bun
/**
 * Coordination overhead of agent teams, measured from session transcripts.
 *
 * Every assistant tool call is classified:
 * - `discovery` — the agent hunting for how the harness itself works instead
 *   of using it: reading `omp://` docs, grepping the harness source, asking
 *   `omp --help`, listing `agent://`/`local://`, or writing a `team://` path
 *   the protocol does not have;
 * - `coordination` — using the channels: `write agent://…`, `team://…`,
 *   `wait`, `yield`/`handback`, `task` to an `a2a:` peer;
 * - `work` — everything else.
 * A "turn ended without a tool call" reminder is counted separately: it is a
 * member stalled in a coordination loop.
 *
 * Usage: bun scripts/team-coordination-overhead.ts <session.jsonl | dir>... [--max-discovery-share 0.1] [--json]
 * A directory is searched recursively for `*.jsonl`. Exits 1 when the
 * discovery share of all tool calls exceeds the threshold.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

export type ToolCallKind = "discovery" | "coordination" | "work";

export interface OverheadCounts {
	discovery: number;
	coordination: number;
	work: number;
	/** Reminders that a turn ended without a tool call. */
	reminders: number;
}

const DISCOVERY_PATTERNS: readonly RegExp[] = [
	/omp:\/\//,
	/packages[\\/]+coding-agent[\\/]+src/,
	/\bomp(?:\.exe)?\s+(?:--help|team\b|help\b)/,
	/\bls\s+(?:agent|local):\/\//,
	/team-protocol|builtin-teams|team-runtime/,
];

const COORDINATION_TOOLS = new Set(["wait", "yield", "handback"]);

/** The `team://` paths the protocol serves; anything else is a guess. */
const TEAM_PATH =
	/^team:\/\/[^/?#]+\/(?:tasks(?:\/[1-9][0-9]*\/(?:claim|release|done))?|plan(?:\/[A-Za-z0-9_-]+)?|stop\/[A-Za-z0-9_-]+)$/;

/** Classify one assistant tool call by its name and arguments. */
export function classifyToolCall(name: string, args: unknown): ToolCallKind {
	const text = JSON.stringify(args ?? {});
	const target = typeof args === "object" && args !== null ? (args as { path?: unknown }).path : undefined;
	if (typeof target === "string" && target.startsWith("team://")) {
		return TEAM_PATH.test(target) ? "coordination" : "discovery";
	}
	if (DISCOVERY_PATTERNS.some(pattern => pattern.test(text))) return "discovery";
	if (COORDINATION_TOOLS.has(name)) return "coordination";
	if (typeof target === "string" && target.startsWith("agent://")) return "coordination";
	if (name === "task" && /"agent"\s*:\s*"a2a:/.test(text)) return "coordination";
	return "work";
}

/** Count one transcript's tool calls by kind (entries are parsed JSONL session rows). */
export function measureEntries(entries: Iterable<unknown>): OverheadCounts {
	const counts: OverheadCounts = { discovery: 0, coordination: 0, work: 0, reminders: 0 };
	for (const entry of entries) {
		const message = (entry as { message?: { role?: string; content?: unknown } }).message;
		if (!message) continue;
		const content = Array.isArray(message.content) ? message.content : [];
		if (message.role === "assistant") {
			for (const part of content as Array<{ type?: string; name?: string; arguments?: unknown }>) {
				if (part.type === "toolCall" && typeof part.name === "string") {
					counts[classifyToolCall(part.name, part.arguments)]++;
				}
			}
		} else if (JSON.stringify(content).includes("Last turn had no tool call")) {
			counts.reminders++;
		}
	}
	return counts;
}

/** Share of tool calls spent on discovery; 0 for a transcript without tool calls. */
export function discoveryShare(counts: OverheadCounts): number {
	const total = counts.discovery + counts.coordination + counts.work;
	return total === 0 ? 0 : counts.discovery / total;
}

async function collectFiles(target: string): Promise<string[]> {
	const stat = await fs.stat(target);
	if (!stat.isDirectory()) return [target];
	const files: string[] = [];
	for (const entry of await fs.readdir(target, { recursive: true, withFileTypes: true })) {
		if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path.join(entry.parentPath, entry.name));
	}
	return files.sort();
}

async function main(argv: string[]): Promise<number> {
	let threshold = 0.1;
	let json = false;
	const targets: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--max-discovery-share") threshold = Number(argv[++i]);
		else if (arg === "--json") json = true;
		else targets.push(arg);
	}
	if (targets.length === 0 || !Number.isFinite(threshold)) {
		process.stderr.write(
			"usage: team-coordination-overhead <session.jsonl|dir>... [--max-discovery-share N] [--json]\n",
		);
		return 2;
	}
	const total: OverheadCounts = { discovery: 0, coordination: 0, work: 0, reminders: 0 };
	const rows: Array<{ file: string } & OverheadCounts> = [];
	for (const target of targets) {
		for (const file of await collectFiles(target)) {
			const counts = measureEntries(Bun.JSONL.parse(await Bun.file(file).text()));
			rows.push({ file, ...counts });
			for (const key of Object.keys(total) as Array<keyof OverheadCounts>) total[key] += counts[key];
		}
	}
	const share = discoveryShare(total);
	if (json) {
		process.stdout.write(`${JSON.stringify({ total, discoveryShare: share, threshold, files: rows }, null, 2)}\n`);
	} else {
		for (const row of rows.filter(row => row.discovery + row.coordination + row.work > 0)) {
			process.stdout.write(
				`${row.file}: discovery=${row.discovery} coordination=${row.coordination} work=${row.work} reminders=${row.reminders}\n`,
			);
		}
		process.stdout.write(
			`TOTAL discovery=${total.discovery} coordination=${total.coordination} work=${total.work} reminders=${total.reminders} discovery-share=${(share * 100).toFixed(1)}% (max ${(threshold * 100).toFixed(1)}%)\n`,
		);
	}
	return share > threshold ? 1 : 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
