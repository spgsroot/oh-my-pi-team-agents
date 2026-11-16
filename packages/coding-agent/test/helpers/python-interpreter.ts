import { $whichAll } from "@oh-my-pi/pi-utils";

/** True when `candidate` starts and runs code. The Windows Store `python3.exe` stub exits non-zero. */
function runs(candidate: string): boolean {
	try {
		return Bun.spawnSync([candidate, "-c", "import sys"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
	} catch {
		return false;
	}
}

/**
 * First working Python: `$PYTHON`, then every `python3` and `python` on PATH in order.
 * A PATH entry that cannot run (the Microsoft Store launcher stub) is skipped so a real
 * interpreter behind it is still found. `undefined` means none exists; skip the test.
 */
export function findPythonInterpreter(): string | undefined {
	const explicit = Bun.env.PYTHON;
	if (explicit) return runs(explicit) ? explicit : undefined;
	return [...$whichAll("python3"), ...$whichAll("python")].find(runs);
}
