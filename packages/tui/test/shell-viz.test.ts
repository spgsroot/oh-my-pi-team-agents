import { describe, expect, it } from "bun:test";
import { RunTrace, Shell } from "@oh-my-pi/pi-natives";
import { isShellTrace, type ShellTrace, type ShellVizPresentation } from "@oh-my-pi/pi-wire";
import {
	attachShellTrace,
	decodeShellPresentation,
	defaultShellVizPreferences,
	readShellPresentation,
	shellVisualization,
} from "../src/tools/shell-viz";
import { renderShellVisualization } from "../src/tools/shell-viz-render";
import { getThemeByName } from "../src/theme";

function snapshot(trace: RunTrace): ShellTrace {
	const value: unknown = JSON.parse(trace.snapshot());
	if (!isShellTrace(value)) throw new Error("Expected native execution trace");
	return value;
}
function fixture(): ShellVizPresentation {
	return {
		preferences: { ...defaultShellVizPreferences(), selectedNode: "2:0:17", expandedNodes: ["2:0:17"] },
		rows: [
			{
				id: "command",
				depth: 0,
				node: "2:0:17",
				range: [0, 9],
				state: "ok",
				segments: [{ text: "print(1)", node: "2:0:17", state: "ok", executedAtNs: 4, executionSeq: 8 }],
				effects: [],
				annotations: [{ name: "x", value: "1", node: "2:0:17", setterSeq: 7 }],
			},
		],
		original: [],
		output: "1\n",
		executing: false,
		watches: [{ name: "x", value: "1", node: "2:0:17", setterSeq: 7 }],
		timeline: { length: 8, cursor: 8, elapsedNs: 4, durationNs: 4 },
	};
}

describe("native shell presentation boundary", () => {
	it("rejects malformed DTOs and numeric node identities without compatibility coercion", () => {
		for (const value of [
			{ ...fixture(), rows: [{ ...fixture().rows[0], node: 17 }] },
			{ ...fixture(), rows: [{ ...fixture().rows[0], segments: [{ text: "x", node: "17" }] }] },
			{ ...fixture(), rows: [{ ...fixture().rows[0], segments: [{ text: "x", executionNode: 17 }] }] },
			{ ...fixture(), watches: [{ name: "x", value: "1", node: "2:0:-1" }] },
			{ ...fixture(), preferences: { ...fixture().preferences, expandedNodes: [17] } },
			{ ...fixture(), timeline: { length: 8, cursor: "8", elapsedNs: 4, durationNs: 4 } },
		])
			expect(() => decodeShellPresentation(JSON.stringify(value))).toThrow("invalid visualization presentation");
	});

	it("keeps an unexecuted pending trace uncompiled, including invalid future shell text", () => {
		const trace = new RunTrace("printf first\nif then invalid");
		const before = snapshot(trace);
		readShellPresentation(trace, defaultShellVizPreferences());
		expect(snapshot(trace).units).toEqual([]);
		expect(snapshot(trace).seq).toBe(before.seq);
	});

	it("marks a failed command once, not once per source argument", async () => {
		const command = "false first second\n:";
		const trace = new RunTrace(command);
		const result = await new Shell().run({ command, trace });
		expect(result.exitCode).toBe(0);
		const presentation = readShellPresentation(trace, defaultShellVizPreferences(), snapshot(trace));
		const selectedTheme = await getThemeByName("dark");
		if (!selectedTheme) throw new Error("Missing dark theme");
		const output = Bun.stripANSI(renderShellVisualization(presentation, selectedTheme, 100).join("\n"));
		expect(output.match(/×/g)).toHaveLength(1);
		expect(output).toContain("false first second");
	});

	it("uses the sink only live and replays real captured output from live or stored traces", async () => {
		const command = "printf 'native-boundary\\n'";
		const trace = new RunTrace(command);
		const shell = new Shell();
		await shell.run({ command, trace });
		const live = snapshot(trace);
		attachShellTrace(live, trace);
		const preferences = defaultShellVizPreferences();
		expect(readShellPresentation(shellVisualization(live), preferences, live, "sink notice").output).toBe(
			"sink notice",
		);
		const replay = { ...preferences, cursor: live.history?.length ?? 0 };
		expect(readShellPresentation(trace, replay, live, "sink notice").output).toBe("native-boundary\n");
		const stored = snapshot(trace);
		const restored = shellVisualization(stored);
		expect(readShellPresentation(restored, replay, stored).output).toBe("native-boundary\n");
	});
});

describe("native shell trace byte-form boundary", () => {
	it("accepts byte-array values the engine emits when truncated text is not valid UTF-8", async () => {
		// Regression for the fatal "Native shell returned an invalid execution
		// trace": a multi-byte value cut at a non-char boundary makes the
		// serializer emit raw bytes (`number[]`) instead of a string, which the
		// wire guard must accept (ShellTraceText), not reject. Assigning a
		// Russian literal with a large cut exercises the same serializer path
		// end to end: every snapshot the engine produces must validate.
		const command = 'file="значение переменной обрезанное посередине многобайтового символа"; printf "%s\\n" "$file"';
		const trace = new RunTrace(command);
		const shell = new Shell();
		await shell.run({ command, trace });
		const final = snapshot(trace);
		expect(final.history?.some(entry => entry.kind === "Assign")).toBe(true);
	});

	it("accepts an explicit byte-array assign value, mirroring a cut multi-byte script payload", () => {
		const bytes = [...Buffer.from("- verdict: **confirmed** — рус", "utf8")];
		// Cut mid-code-point: invalid UTF-8, the exact producer of the crash.
		bytes.length = bytes.length - 1;
		const value = {
			v: 1,
			seq: 7,
			t_ns: 8190917,
			script: "file=$(sed -n '1p' data)",
			units: [{ line: 1, bytes: 24, nodes: [{ k: "simple", lo: 0, hi: 24, state: "ok" }] }],
			history: [
				{
					seq: 152,
					t_ns: 14050791,
					kind: "Assign",
					u: 0,
					n: 45,
					command: { run: 0, vpid: 1073741826, seq: 30 },
					vpid: 1073741826,
					name: "file",
					value: bytes,
					full_len: bytes.length,
					scope: "shell",
				},
			],
		};
		expect(isShellTrace(value)).toBe(true);
	});

	it("still rejects non-byte-array garbage in a byte-form position", () => {
		const value = {
			v: 1,
			seq: 7,
			t_ns: 0,
			script: "x=1",
			units: [{ line: 1, nodes: [{ k: "simple", lo: 0, hi: 3, state: "ok" }] }],
			history: [{ seq: 1, t_ns: 0, kind: "Assign", name: "x", value: { bad: true }, full_len: 1, scope: "shell" }],
		};
		expect(isShellTrace(value)).toBe(false);
	});
});
