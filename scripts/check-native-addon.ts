#!/usr/bin/env bun
/**
 * Preflight for the TypeScript suite: the loaded `pi_natives` addon must export
 * every symbol the generated `native/index.d.ts` declares.
 *
 * A workspace load skips the loader's release-version check, so an addon built
 * before a Rust change loads fine and then fails deep inside unrelated tests
 * (`undefined is not a constructor`). This turns that into one named failure.
 *
 * Usage: bun scripts/check-native-addon.ts
 * Set OMP_SKIP_NATIVE_CHECK=1 to bypass (CI builds the addon in the same job).
 */
import * as fs from "node:fs";
import * as path from "node:path";

const nativeDir = path.join(import.meta.dir, "..", "packages", "natives", "native");
const DECLARATION = /^export declare (?:class|function|enum) ([A-Za-z_$][\w$]*)/gm;

/** Names the declaration file promises, in file order. */
export function declaredNativeExports(declarations: string): string[] {
	return [...declarations.matchAll(DECLARATION)].map(match => match[1]);
}

/** Declared names the loaded addon does not export. */
export function missingNativeExports(declared: readonly string[], loaded: Record<string, unknown>): string[] {
	return declared.filter(name => loaded[name] === undefined);
}

/** Resolves to the problem description, or undefined when the addon is current. */
export async function nativeAddonProblem(): Promise<string | undefined> {
	if (Bun.env.OMP_SKIP_NATIVE_CHECK === "1") return undefined;
	const declarationPath = path.join(nativeDir, "index.d.ts");
	if (!fs.existsSync(declarationPath)) return undefined;
	let loaded: Record<string, unknown>;
	// Dynamic: a failing load must become a message here, not an import-time crash of the preflight.
	try {
		loaded = (await import(path.join(nativeDir, "index.js"))) as Record<string, unknown>;
	} catch (error) {
		return `the native addon failed to load: ${error instanceof Error ? error.message : String(error)}`;
	}
	const missing = missingNativeExports(declaredNativeExports(fs.readFileSync(declarationPath, "utf8")), loaded);
	if (missing.length === 0) return undefined;
	const shown = missing.slice(0, 8).join(", ");
	return `the loaded native addon predates its declarations (${missing.length} missing: ${shown}${missing.length > 8 ? ", ..." : ""})`;
}

if (import.meta.main) {
	const problem = await nativeAddonProblem();
	if (problem) {
		console.error(`${problem}. Rebuild it with \`bun run build:native\` (or set OMP_SKIP_NATIVE_CHECK=1).`);
		process.exit(1);
	}
	console.log("native addon current");
}
