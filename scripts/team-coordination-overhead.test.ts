import { describe, expect, test } from "bun:test";
import { classifyToolCall, discoveryShare, measureEntries } from "./team-coordination-overhead";

// The metric gates regressions in how quickly agents use the team channels;
// a misclassification would hide protocol hunting or flag ordinary work.
describe("classifyToolCall", () => {
	test("flags the protocol hunting seen in live team runs", () => {
		// Each row is a call a real lead made while looking for a way to answer a plan.
		expect(classifyToolCall("read", { path: "omp://agent-teams.md:280-360" })).toBe("discovery");
		expect(
			classifyToolCall("grep", { pattern: "approve", path: "C:\\repo\\packages\\coding-agent\\src\\task" }),
		).toBe("discovery");
		expect(classifyToolCall("bash", { command: "omp team --help 2>&1" })).toBe("discovery");
		expect(classifyToolCall("bash", { command: "ls agent:// 2>/dev/null; ls local://" })).toBe("discovery");
		// A team:// path the protocol does not serve is a guess, not coordination.
		expect(classifyToolCall("write", { path: "team://wake/reject/Planner", content: "x" })).toBe("discovery");
	});

	test("counts the protocol's own channels as coordination", () => {
		expect(classifyToolCall("write", { path: "team://audit/plan/Reviewer", content: "approve --rev 2" })).toBe(
			"coordination",
		);
		expect(classifyToolCall("write", { path: "team://audit/tasks/3/done", content: "ok" })).toBe("coordination");
		expect(classifyToolCall("write", { path: "agent://Scout", content: "next task" })).toBe("coordination");
		expect(classifyToolCall("wait", {})).toBe("coordination");
		expect(classifyToolCall("task", { tasks: [{ agent: "a2a:peer", task: "hi" }] })).toBe("coordination");
	});

	test("leaves project work alone", () => {
		expect(classifyToolCall("read", { path: "src/app.ts" })).toBe("work");
		expect(classifyToolCall("bash", { command: "bun test" })).toBe("work");
	});
});

test("measures a transcript and its discovery share, counting stalled-turn reminders", () => {
	const entries = [
		{ type: "session" },
		{
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", name: "read", arguments: { path: "omp://agent-teams.md" } },
					{ type: "toolCall", name: "read", arguments: { path: "src/app.ts" } },
					{ type: "text", text: "thinking" },
				],
			},
		},
		{ message: { role: "assistant", content: [{ type: "toolCall", name: "wait", arguments: {} }] } },
		{
			message: {
				role: "developer",
				content: [{ type: "text", text: "Last turn had no tool call → session idle. Reminder 1 of 3." }],
			},
		},
		{ message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "b.ts" } }] } },
	];
	const counts = measureEntries(entries);
	expect(counts).toEqual({ discovery: 1, coordination: 1, work: 2, reminders: 1 });
	expect(discoveryShare(counts)).toBe(0.25);
	expect(discoveryShare({ discovery: 0, coordination: 0, work: 0, reminders: 0 })).toBe(0);
});
