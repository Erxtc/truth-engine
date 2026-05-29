/**
 * Self-check: verifies the truth-engine codebase is healthy.
 * Runs faster checks before more expensive ones.
 *
 * Usage:
 *   bun run src/test/self-check.ts          # full check
 *   bun run src/test/self-check.ts --quick  # TypeScript compilation only
 */

import { execSync } from "child_process";

let ok = true;

function check(name: string, fn: () => boolean | string) {
  process.stdout.write(`  ${name}... `);
  try {
    const result = fn();
    if (result === true) {
      console.log("OK");
    } else {
      console.log(`FAIL (${result})`);
      ok = false;
    }
  } catch (err: any) {
    console.log(`ERROR (${err.message?.slice(0, 100)})`);
    ok = false;
  }
}

console.log("[self-check] Verifying truth-engine codebase...\n");

// 1. TypeScript compilation (zero-cost, always run)
check("TypeScript compiles (tsc --noEmit)", () => {
  try {
    execSync("npx tsc --noEmit", { cwd: import.meta.dir + "/../..", stdio: "pipe", timeout: 60_000 });
    return true;
  } catch (e: any) {
    const output = ((e.stdout?.toString() ?? "") + "\n" + (e.stderr?.toString() ?? "")).trim();
    const errors = output.split("\n").filter((l: string) =>
      l.includes("error TS") && !l.includes("node_modules/")
    ).length;
    return `${errors} TypeScript error(s)`;
  }
});

// 2. Benchmark framework loads (syntax check)
check("Benchmark module loads", () => {
  try {
    const result = execSync("bun run src/test/benchmark.ts 2>&1 | head -1", {
      cwd: import.meta.dir + "/../..", stdio: "pipe", timeout: 30_000,
    });
    return result.toString().includes("[benchmark]") ? true : "unexpected output";
  } catch (e: any) {
    return (e.stderr?.toString() ?? e.message).slice(0, 100);
  }
});

// 3. Core modules import cleanly (no circular deps, runtime errors)
check("Core modules import", () => {
  try {
    execSync("bun -e \"import './src/core/types'; import './src/executors/domains'; import './src/domains/auto-detect';\"", {
      cwd: import.meta.dir + "/../..", stdio: "pipe", timeout: 30_000,
    });
    return true;
  } catch (e: any) {
    return (e.stderr?.toString() ?? e.message).slice(0, 100);
  }
});

const quickOnly = process.argv.includes("--quick");

if (!quickOnly) {
  // 4. Key agents load
  check("Agents load (proposer, repair, supervisor)", () => {
    try {
      execSync("bun -e \"import './src/agents/proposal-schema'; import './src/agents/repair'; import './src/agents/supervisor';\"", {
        cwd: import.meta.dir + "/../..", stdio: "pipe", timeout: 30_000,
      });
      return true;
    } catch (e: any) {
      return (e.stderr?.toString() ?? e.message).slice(0, 100);
    }
  });

  // 5. Knowledge graph opens (SQLite)
  check("Knowledge graph (SQLite)", () => {
    try {
      execSync("bun -e \"import { Database } from 'bun:sqlite'; const db = new Database('./db.sqlite'); db.run('SELECT 1'); db.close();\"", {
        cwd: import.meta.dir + "/../..", stdio: "pipe", timeout: 10_000,
      });
      return true;
    } catch (e: any) {
      return (e.stderr?.toString() ?? e.message).slice(0, 100);
    }
  });

  // 6. UI builds (frontend only, no LLM calls)
  check("UI frontend builds", () => {
    try {
      const result = Bun.spawnSync(["npx", "vite", "build", "--emptyOutDir"], {
        cwd: import.meta.dir + "/../ui/frontend",
        stdout: "pipe", stderr: "pipe",
      });
      const output = (result.stdout?.toString() ?? "") + (result.stderr?.toString() ?? "");
      return result.exitCode === 0 ? true : output.split("\n").slice(-3).join("\n").slice(0, 200);
    } catch (e: any) {
      return e.message?.slice(0, 100);
    }
  });
}

console.log(`\n[self-check] ${ok ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED"}`);
if (!ok) process.exit(1);
