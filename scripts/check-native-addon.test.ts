import { describe, expect, it } from "bun:test";
import { declaredNativeExports, missingNativeExports } from "./check-native-addon";

const DECLARATIONS = [
	"export declare class RunTrace {",
	"  constructor(script: string)",
	"}",
	"export declare function glob(options: GlobOptions): Promise<GlobResult>",
	"export declare enum Ellipsis {",
	"  Unicode = 0,",
	"}",
	"export interface GlobOptions {}",
	"export declare const nothing: number",
].join("\n");

describe("native addon preflight", () => {
	it("collects classes, functions and enums but not interfaces", () => {
		expect(declaredNativeExports(DECLARATIONS)).toEqual(["RunTrace", "glob", "Ellipsis"]);
	});

	it("names exactly the symbols a stale addon predates", () => {
		const stale = { glob() {}, Ellipsis: {} };
		expect(missingNativeExports(["RunTrace", "glob", "Ellipsis"], stale)).toEqual(["RunTrace"]);
		expect(missingNativeExports(["glob"], stale)).toEqual([]);
	});
});
