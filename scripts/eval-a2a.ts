#!/usr/bin/env bun
/**
 * Live eval: two real omp terminals (separate processes) exchange an A2A task.
 * The lead spawns the peer through the task tool (`a2a:<name>`) and the
 * peer's answer must come back as the reply of that job, not through a
 * human turn. Needs model credentials, so it is not part of the unit suites;
 * run it when changing the A2A bridge, reply relay or incoming-request ledger.
 *
 * Usage: bun scripts/eval-a2a.ts --model <provider/id> [--timeout-ms 600000] [--keep]
 * Exits 0 when the peer's answer reached the lead through the reply job, 1 when it did not, and 2 when the
 * model call itself failed (a provider error proves nothing about A2A).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Process } from "@oh-my-pi/pi-natives";

const repoRoot = path.join(import.meta.dir, "..");
const cli = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");

/** 23 * 19: the lead cannot guess it without the peer's reply to be sure, and the token never appears in the prompt. */
const EXPECTED = "LIVE_A2A_437";

interface Frame {
	type?: string;
	id?: string;
	toolName?: string;
	success?: boolean;
	data?: { isSettled?: boolean };
	status?: string;
	error?: { message?: string };
}

interface Terminal {
	name: string;
	frames: Frame[];
	send(command: Record<string, unknown>): string;
	request(command: Record<string, unknown>): Promise<Frame | undefined>;
	next(predicate: (frame: Frame) => boolean, timeoutMs: number): Promise<Frame | undefined>;
	stop(): Promise<void>;
}

function parseArgs(argv: string[]) {
	const options = { model: Bun.env.OMP_EVAL_MODEL ?? "", timeoutMs: 600_000, keep: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--model") options.model = argv[++i] ?? "";
		else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++i]);
		else if (arg === "--keep") options.keep = true;
	}
	if (!options.model) throw new Error("--model <provider/id> (or OMP_EVAL_MODEL) is required");
	return options;
}

function launch(name: string, project: string, config: string, model: string): Terminal {
	const child = Bun.spawn(
		[
			process.execPath,
			cli,
			"--cwd",
			project,
			"--mode",
			"rpc",
			"--model",
			model,
			"--a2a-name",
			name,
			"--config",
			config,
		],
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
		const id = `${name}-${++seq}`;
		const sink = child.stdin as import("bun").FileSink;
		sink.write(`${JSON.stringify({ ...command, id })}\n`);
		sink.flush();
		return id;
	};
	return {
		name,
		frames,
		send,
		next,
		request: command => {
			const id = send(command);
			return next(frame => frame.type === "response" && frame.id === id, 60_000);
		},
		stop: async () => {
			// omp's persistent shell/session children keep the project directory as cwd; kill the whole tree.
			Process.fromPid(child.pid)?.killTree(9);
			child.kill();
			await child.exited;
		},
	};
}

async function main(): Promise<number> {
	const options = parseArgs(process.argv.slice(2));
	const project = await fs.mkdtemp(path.join(os.tmpdir(), "omp-a2a-eval-"));
	const config = path.join(project, "eval-config.yml");
	await Bun.write(config, "a2a:\n  enabled: true\n  port: 0\n  autoRegister: true\nteam:\n  enabled: false\n");

	// Per-run names keep concurrent runs and stale bridge files from answering for each other.
	const suffix = process.pid.toString(36);
	const peer = launch(`eval-peer-${suffix}`, project, config, options.model);
	const lead = launch(`eval-lead-${suffix}`, project, config, options.model);
	let passed = false;
	try {
		await Promise.all([peer, lead].map(terminal => terminal.next(frame => frame.type === "ready", 120_000)));
		const kickoff = lead.send({
			type: "prompt",
			message: `Use the task tool to spawn the agent a2a:${peer.name} with the prompt "Compute 23 * 19. Reply with LIVE_A2A_ followed by the product, nothing else." Then wait for its reply with the wait tool and tell me the reply verbatim. Do not compute the product yourself.`,
		});
		const result = await lead.next(
			frame => frame.type === "prompt_result" && frame.id === kickoff,
			options.timeoutMs,
		);
		if (result?.status === "error") {
			process.stdout.write(
				`a2a-eval: inconclusive, model call failed: ${result.error?.message ?? "unknown error"}\n`,
			);
			return 2;
		}
		const deadline = Date.now() + options.timeoutMs;
		while (Date.now() < deadline) {
			const state = await lead.request({ type: "get_state" });
			if (state?.data?.isSettled) break;
			await Bun.sleep(3000);
		}
		const spawned = lead.frames.some(frame => frame.type === "tool_execution_start" && frame.toolName === "task");
		const answered = lead.frames.some(
			frame => frame.type === "tool_execution_end" && JSON.stringify(frame).includes(EXPECTED),
		);
		passed = spawned && answered;
		process.stdout.write(
			`a2a-eval: ${passed ? "pass" : "fail"} spawnedViaTask=${spawned} replyReachedLead=${answered}\n`,
		);
		if (!passed) {
			const dump = path.join(project, "frames.json");
			await Bun.write(dump, JSON.stringify({ lead: lead.frames, peer: peer.frames }, null, 1));
			options.keep = true;
			process.stdout.write(`frames written to ${dump}\n`);
		}
	} finally {
		await Promise.all([peer.stop(), lead.stop()]);
		if (!options.keep) {
			// A helper process may still hold the directory on Windows; a leftover temp dir must not change the verdict.
			await fs
				.rm(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
				.catch(error => process.stderr.write(`could not remove ${project}: ${String(error)}\n`));
		} else process.stdout.write(`project kept at ${project}\n`);
	}
	return passed ? 0 : 1;
}

process.exit(await main());
