#!/usr/bin/env bun
/**
 * Live eval: a lead agent and a plan-gated team member finish a small code
 * change together, then the transcripts are scored by
 * `team-coordination-overhead.ts`. Needs model credentials, so it is not part
 * of the unit suites; run it when changing team prompts, notices or protocol.
 *
 * Usage: bun scripts/eval-team-coordination.ts --model <provider/id> [--max-discovery-share 0.1] [--timeout-ms 900000] [--keep]
 * Exits 0 when the change landed, the lead woke on its member's final notice and reported after the edit, and the
 * discovery share stays within bounds; 1 when any of that failed, and 2 when the
 * model call itself failed (a provider error proves nothing about the protocol).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Process } from "@oh-my-pi/pi-natives";
import { discoveryShare, measureEntries, type OverheadCounts } from "./team-coordination-overhead";

const repoRoot = path.join(import.meta.dir, "..");
const cli = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");

interface Frame {
	type?: string;
	id?: string;
	data?: { sessionFile?: string; isSettled?: boolean; agentInvoked?: boolean };
	success?: boolean;
	status?: string;
	error?: { message?: string };
	message?: { role?: string; timestamp?: number };
}

/** How long the lead gets, once the change landed, to wake on the member's notice and report. */
const REPORT_GRACE_MS = 120_000;

const TEAM_FILE = `---
name: calc
description: Calculator maintenance crew
planApproval: true
members:
  - agent: coordination-eval
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
	await Bun.write(
		path.join(project, ".omp", "agents", "coordination-eval.md"),
		`---\nname: coordination-eval\ndescription: Coordination evaluation worker\nmodel: ${JSON.stringify(options.model)}\n---\nComplete the assigned team task and follow its plan approval protocol.\n`,
	);
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
	let reported = false;
	try {
		await next(frame => frame.type === "ready", 120_000);
		await request({ type: "prompt", message: "/team start calc" });
		const kickoff = send({
			type: "prompt",
			message:
				"You lead team calc. Get the assignment in the team file done through your member, deciding its plan, then tell me when src/app.ts has `sub`.",
		});
		const kicked = await next(frame => frame.type === "prompt_result" && frame.id === kickoff, options.timeoutMs);
		if (kicked?.status === "error") {
			// A provider failure says nothing about the team protocol: report it apart from a real failure.
			process.stdout.write(`inconclusive, model call failed: ${kicked.error?.message ?? "unknown error"}\n`);
			return 2;
		}
		// Landing is the member's half. The lead's half is waking on the member's
		// final notice and reporting: its last reply must postdate the edit.
		const appFile = path.join(project, "src", "app.ts");
		const lastLeadReplyAt = () =>
			frames.findLast(frame => frame.type === "message_end" && frame.message?.role === "assistant")?.message
				?.timestamp ?? 0;
		let reportDeadline = deadline;
		while (Date.now() < Math.min(deadline, reportDeadline)) {
			landed = (await Bun.file(appFile).text()).includes("function sub");
			const state = await request({ type: "get_state" });
			if (landed) {
				reportDeadline = Math.min(reportDeadline, Date.now() + REPORT_GRACE_MS);
				reported = state?.data?.isSettled === true && lastLeadReplyAt() >= (await fs.stat(appFile)).mtimeMs;
				if (reported) break;
			}
			await Bun.sleep(3000);
		}
		const sessionFile = (await request({ type: "get_state" }))?.data?.sessionFile;
		(child.stdin as import("bun").FileSink).end();
		await Promise.race([child.exited, Bun.sleep(30_000)]);
		Process.fromPid(child.pid)?.killTree(9);
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
			`landed=${landed} reported=${reported} discovery-share=${(share * 100).toFixed(1)}% (max ${(options.maxShare * 100).toFixed(1)}%) total=${JSON.stringify(total)}\n`,
		);
		return landed && reported && share <= options.maxShare ? 0 : 1;
	} finally {
		Process.fromPid(child.pid)?.killTree(9);
		child.kill();
		await child.exited;
		if (!options.keep) {
			// A helper process may still hold the directory on Windows; a leftover temp dir must not change the verdict.
			await fs
				.rm(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
				.catch(error => process.stderr.write(`could not remove ${project}: ${String(error)}\n`));
		} else process.stdout.write(`project kept at ${project}\n`);
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
