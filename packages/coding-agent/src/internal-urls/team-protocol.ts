import { getTeamClient } from "../thread/services/team-client";
import type { ToolSession } from "../tools";
import type {
	InternalResource,
	InternalUrl,
	InternalWriteResult,
	ProtocolHandler,
	ResolveContext,
	SchemeSpec,
	WriteContext,
} from "./types";

type TeamTarget =
	| { team: string; kind: "overview" }
	| { team: string; kind: "tasks"; id?: string; action?: "claim" | "release" | "done" }
	| { team: string; kind: "stop"; requestId: string }
	| { team: string; kind: "plan" }
	| { team: string; kind: "decision"; handle: string };

/** A lead's plan decision body: `approve [--rev N]` or `reject [--rev N]: <reason>`. */
type PlanDecision =
	| { verdict: "approve"; revision?: number }
	| { verdict: "reject"; revision?: number; reason: string };

const DECISION_USAGE = "Write `approve [--rev N]` or `reject [--rev N]: <reason>`";

function parseDecision(body: string): PlanDecision {
	const match = /^(approve|reject)(?:\s+--rev\s+([1-9][0-9]*))?\s*(?::\s*([\s\S]*))?$/i.exec(body.trim());
	if (!match) throw new Error(`Invalid plan decision. ${DECISION_USAGE}`);
	const verdict = match[1]!.toLowerCase();
	const revision = match[2] !== undefined ? Number(match[2]) : undefined;
	const reason = match[3]?.trim() ?? "";
	if (verdict === "approve") {
		if (reason) throw new Error(`An approval takes no reason. ${DECISION_USAGE}`);
		return { verdict, ...(revision !== undefined ? { revision } : {}) };
	}
	if (!reason) throw new Error(`A rejection needs a reason after ":". ${DECISION_USAGE}`);
	return { verdict: "reject", reason, ...(revision !== undefined ? { revision } : {}) };
}

/**
 * A refusal that teaches the protocol: an agent that guessed a path gets every
 * valid one back and corrects itself in one step instead of searching docs.
 */
function invalidTarget(team: string | undefined): Error {
	const t = team || "<team>";
	return new Error(
		[
			"Invalid team URL. Valid team:// paths:",
			`- read team://${t} — roster, status and each member's plan`,
			`- read team://${t}/tasks — task list`,
			`- write team://${t}/tasks — add a task (lead; body = title)`,
			`- write team://${t}/tasks/<id>/claim | release | done — body is the completion note for done`,
			`- write team://${t}/plan — submit your plan (member; body = plan)`,
			`- write team://${t}/plan/<member> — decide a plan (lead; body = approve [--rev N] or reject [--rev N]: <reason>)`,
			`- write team://${t}/stop/<requestId> — answer a stop request (body = ack or decline: <reason>)`,
		].join("\n"),
	);
}

function parseTarget(url: InternalUrl): TeamTarget {
	const team = url.rawHost;
	const pathname = url.rawPathname ?? url.pathname;
	if (!team || url.search || url.hash) throw invalidTarget(team);
	if (pathname === "" || pathname === "/") return { team, kind: "overview" };
	if (pathname === "/plan") return { team, kind: "plan" };
	const decision = /^\/plan\/([A-Za-z0-9_-]+)$/.exec(pathname);
	if (decision) return { team, kind: "decision", handle: decision[1]! };
	const stop = /^\/stop\/([a-zA-Z0-9_-]+)$/.exec(pathname);
	if (stop) return { team, kind: "stop", requestId: stop[1] };
	const match = /^\/tasks(?:\/([1-9][0-9]*)\/(claim|release|done))?$/.exec(pathname);
	if (!match) throw invalidTarget(team);
	return { team, kind: "tasks", id: match[1], action: match[2] as "claim" | "release" | "done" | undefined };
}

async function caller(session: ToolSession | undefined, team: string) {
	const key = session?.getSessionInstanceKey?.();
	if (!key) throw new Error("team:// requires a registered caller session");
	const client = getTeamClient();
	const identity = session?.teamIdentity ?? (await client.leadIdentity(key, team));
	if (!identity || identity.team !== team) throw new Error("Caller is not a member of this team");
	return { client, key, identity };
}

export class TeamProtocolHandler implements ProtocolHandler {
	readonly scheme = "team";
	readonly spec: SchemeSpec = {
		backing: "virtual",
		selectors: "lines",
		immutable: true,
		singleSlashAlias: true,
		write: { via: "handler", payload: "verbatim", scope: "coordination", tier: () => "write" },
	};

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const target = parseTarget(url);
		if (target.kind !== "overview" && (target.kind !== "tasks" || target.id)) {
			throw new Error(
				`Only team://${target.team} (roster and plans) and team://${target.team}/tasks can be read; the other paths are write-only`,
			);
		}
		const { client, key, identity } = await caller(context?.session, target.team);
		const data =
			target.kind === "overview" ? await client.overview(key, identity) : await client.readTasks(key, identity);
		return { url: url.href, content: JSON.stringify(data, null, 2), contentType: "application/json" };
	}

	async write(url: InternalUrl, content: string, context?: WriteContext): Promise<InternalWriteResult> {
		const target = parseTarget(url);
		if (target.kind === "overview") throw invalidTarget(target.team);
		if (target.kind === "decision") return this.#decide(context?.session, target, content);
		const { client, key, identity } = await caller(context?.session, target.team);
		let result: unknown;
		if (target.kind === "stop") result = await client.respondStop(key, identity, target.requestId, content);
		else if (target.kind === "plan") {
			await client.submitPlan(key, identity, content);
			result = { submitted: true };
		} else if (!target.id) result = await client.addTask(key, identity, content);
		else if (target.action === "claim") {
			const claim = await client.claim(key, identity, target.id);
			if (claim.kind === "conflict") throw new Error(`Task ${target.id} is owned by ${claim.owner}`);
			result = claim;
		} else if (target.action === "release") result = await client.releaseTask(key, identity, target.id);
		else result = await client.completeTask(key, identity, target.id, content);
		return { content: [{ type: "text", text: JSON.stringify(result) }] };
	}

	/**
	 * The lead's plan decision, the agent-side twin of `/team approve|reject`:
	 * the same runtime calls, authorized by the caller's session as the team's
	 * current lead, and scoped to the member of the URL's team.
	 */
	async #decide(
		session: ToolSession | undefined,
		target: { team: string; handle: string },
		content: string,
	): Promise<InternalWriteResult> {
		const key = session?.getSessionInstanceKey?.();
		if (!key) throw new Error("team:// requires a registered caller session");
		const client = getTeamClient();
		const roster = await client.members(key, target.team);
		if (!roster) throw new Error(`Only the lead of team ${target.team} decides its plans`);
		const member = roster.members.find(([handle, entry]) => handle === target.handle || entry.id === target.handle);
		if (!member) throw new Error(`No member "${target.handle}" in team ${target.team}`);
		const decision = parseDecision(content);
		const handle = member[0];
		if (decision.verdict === "approve") await client.approve(key, handle, decision.revision);
		else await client.reject(key, handle, decision.reason, decision.revision);
		const result = {
			decision: decision.verdict === "approve" ? "approved" : "rejected",
			member: member[1].id,
			...(decision.revision !== undefined ? { revision: decision.revision } : {}),
		};
		return { content: [{ type: "text", text: JSON.stringify(result) }] };
	}
}
