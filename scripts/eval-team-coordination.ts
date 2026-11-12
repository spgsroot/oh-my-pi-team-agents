#!/usr/bin/env bun
/**
 * Live eval: a lead agent and a plan-gated team member finish a small code
 * change together, then the transcripts are scored by
 * `team-coordination-overhead.ts`. Needs model credentials, so it is not part
 * of the unit suites; run it when changing team prompts, notices or protocol.
 *
 * Usage: bun scripts/eval-team-coordination.ts --model <provider/id> [--max-discovery-share 0.1] [--timeout-ms 900000] [--keep]
 * Exits 0 when the change landed and the discovery share stays within bounds.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { discoveryShare, measureEntries, type OverheadCounts } from "./team-coordination-overhead";

const repoRoot = path.join(import.meta.dir, "..");
const cli = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");

interface Frame {
	type?: string;
	id?: string;
	data?: { sessionFile?: string; isSettled?: boolean; agentInvoked?: boolean };
	success?: boolean;
}

const TEAM_FILE = `---
name: calc
description: Calculator maintenance crew
planApproval: true
members:
  - agent: task
    handle: Builder
    role: Implement the change
---
Builder: add \`export function sub(a: number, b: number) { return a - b; }\` to src/app.ts, below \`add\`.
Submit your plan first, then make the change once it is approved, then finish.
`;

function parseArgs(argv: string[]) {
	const options = { model: Bun.env.OMP_EVAL_MODEL ?? "", maxShare: 0.1, timeoutMs: 900_000, keep: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--model") options.model = argv[++i] ?? "";
		else if (arg === "--max-discovery-share") options.maxShare = Number(argv[++i]);
		else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++i]);
		else if (arg === "--keep") options.keep = true;
	}
	if (!options.model) throw new Error("--model <provider/id> (or OMP_EVAL_MODEL) is required");
	return options;
}

async function main(): Promise<number> {
	const options = parseArgs(process.argv.slice(2));
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "omp-team-eval-"));
	await Bun.write(
		path.join(project, "src", "app.ts"),
		"export function add(a: number, b: number) { return a + b; }\n",
	);
	await Bun.write(path.join(project, ".omp", "teams", "calc.md"), TEAM_FILE);
	const overlay = path.join(project, "eval-config.yml");
	await Bun.write(overlay, "team:\n  enabled: true\na2a:\n  enabled: false\n");

	const child = Bun.spawn(
		[process.execPath, cli, "--cwd", project, "--mode", "rpc", "--model", options.model, "--config", overlay],
		{ cwd: repoRoot, stdin: "pipe", stdout: "pipe", stderr: "ignore" },
	);
	const frames: Frame[] = [];
	const listeners = new Set<() => void>();
	void (async () => {
		let buffer = "";
		for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
			buffer += new TextDecoder().decode(chunk);
			for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (!line) continue;
				try {
					frames.push(JSON.parse(line) as Frame);
				} catch {
					continue;
				}
				for (const listener of listeners) listener();
			}
		}
	})();
	const next = (predicate: (frame: Frame) => boolean, timeoutMs: number): Promise<Frame | undefined> => {
		const found = frames.find(predicate);
		if (found) return Promise.resolve(found);
		const { promise, resolve } = Promise.withResolvers<Frame | undefined>();
		const listener = () => {
			const hit = frames.find(predicate);
			if (hit) done(hit);
		};
		const timer = setTimeout(() => done(undefined), timeoutMs);
		const done = (frame: Frame | undefined) => {
			clearTimeout(timer);
			listeners.delete(listener);
			resolve(frame);
		};
		listeners.add(listener);
		return promise;
	};
	let seq = 0;
	const send = (command: Record<string, unknown>): string => {
		const id = `eval-${++seq}`;
		const sink = child.stdin as import("bun").FileSink;
		sink.write(`${JSON.stringify({ ...command, id })}\n`);
		sink.flush();
		return id;
	};
	const request = async (command: Record<string, unknown>) => {
		const id = send(command);
		return next(frame => frame.type === "response" && frame.id === id, 60_000);
	};

	const deadline = Date.now() + options.timeoutMs;
	let landed = false;
	try {
		await next(frame => frame.type === "ready", 120_000);
		await request({ type: "prompt", message: "/team start calc" });
		const kickoff = send({
			type: "prompt",
			message:
				"You lead team calc. Get the assignment in the team file done through your member, deciding its plan, then tell me when src/app.ts has `sub`.",
		});
		await next(frame => frame.type === "prompt_result" && frame.id === kickoff, options.timeoutMs);
		while (Date.now() < deadline) {
			landed = (await Bun.file(path.join(project, "src", "app.ts")).text()).includes("function sub");
			const state = await request({ type: "get_state" });
			if (landed && state?.data?.isSettled) break;
			await Bun.sleep(3000);
		}
		const sessionFile = (await request({ type: "get_state" }))?.data?.sessionFile;
		(child.stdin as import("bun").FileSink).end();
		await Promise.race([child.exited, Bun.sleep(30_000)]);
		child.kill();

		const total: OverheadCounts = { discovery: 0, coordination: 0, work: 0, reminders: 0 };
		const files = sessionFile ? [sessionFile, ...(await memberTranscripts(sessionFile))] : [];
		for (const file of files) {
			const counts = measureEntries(Bun.JSONL.parse(await Bun.file(file).text()));
			process.stdout.write(`${path.basename(file)}: ${JSON.stringify(counts)}\n`);
			for (const key of Object.keys(total) as Array<keyof OverheadCounts>) total[key] += counts[key];
		}
		const share = discoveryShare(total);
		process.stdout.write(
			`landed=${landed} discovery-share=${(share * 100).toFixed(1)}% (max ${(options.maxShare * 100).toFixed(1)}%) total=${JSON.stringify(total)}\n`,
		);
		return landed && share <= options.maxShare ? 0 : 1;
	} finally {
		child.kill();
		if (!options.keep) await fs.rm(project, { recursive: true, force: true });
		else process.stdout.write(`project kept at ${project}\n`);
	}
}

/** Member transcripts live in the directory named after the lead's session file. */
async function memberTranscripts(sessionFile: string): Promise<string[]> {
	const dir = sessionFile.replace(/\.jsonl$/, "");
	try {
		return (await fs.readdir(dir)).filter(name => name.endsWith(".jsonl")).map(name => path.join(dir, name));
	} catch {
		return [];
	}
}

if (import.meta.main) process.exit(await main());
