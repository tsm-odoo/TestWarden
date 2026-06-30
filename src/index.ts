import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { program } from "commander";
import fs from "fs";
import { ProgressBar } from "@warden/progress_bar";

const formatter = {
  info: (s: string) => `\x1b[37m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  error: (s: string) => `\x1b[31m${s}\x1b[0m`,
  success: (s: string) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.resolve(__dirname, "../backend");
const WARDEN_BIN = path.join(BACKEND_DIR, "warden");

function osc8(url: string, label: string): string {
  return `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`;
}

let settings: Record<string, any> = {};
try {
  settings = JSON.parse(fs.readFileSync(path.join(BACKEND_DIR, "settings.json"), "utf8"));
} catch { }

program
  .option("--server-url <url>", "Odoo server URL", settings.serverURL ?? "http://localhost:8069")
  .option("--suite <name>", "Test suite type (hoot, livechat, …)", "hoot")
  .option("-m, --suite-names <names...>", "Suite name(s) to run")
  .option("-t, --test <id>", "Single test name or ID")
  .option("--workers <number>", "Parallel browser contexts", (v) => parseInt(v), settings.workers ?? 4)
  .option("--fail-fast", "Stop on the first failure", false)
  .option("--once", "Run once and exit (default: re-run until a failure is found)", false)
  .option("--visible", "Run in visible browser with devtools and full-screen window", false)
  // Legacy flags accepted for backward compatibility
  .option("--verbose", "ignored", false)
  .option("--debug", "ignored", false)
  .option("--devtools", "ignored", false)
  .option("--cpu-limit <number>", "ignored", parseInt, 0)
  .option("--cpu-throttling <number>", "ignored", parseInt, 0)
  .option("--min-worker-load <number>", "ignored", parseInt, 0)
  .parse();

const opts = program.opts<{
  serverUrl: string;
  suite: string;
  suiteNames?: string[];
  test?: string;
  workers: number;
  failFast: boolean;
  once: boolean;
  visible: boolean;
}>();

const wardenArgs: string[] = [
  "--server", opts.serverUrl,
  "--suite", opts.suite,
  "--workers", String(opts.workers),
];
if (opts.suiteNames?.length) wardenArgs.push("--suite-names", opts.suiteNames.join(","));
if (opts.test) wardenArgs.push("--test", opts.test);
if (opts.failFast) wardenArgs.push("--fail-fast");
if (!opts.once) wardenArgs.push("--run-until-fail");
if (opts.visible) wardenArgs.push("--visible");
wardenArgs.push("--pause-on-fail");

const STEP_LABELS: Record<string, string> = {
  chrome_launch: "Launching Chrome",
  db_fetch: "Fetching database",
  auth: "Authenticating",
  meta_fetch: "Loading test metadata",
  file_scan: "Scanning test files",
  workers_launch: "Launching workers",
};

interface RunResult { passed: number; failed: number; total: number; }

async function runOnce(): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(WARDEN_BIN, wardenArgs, {
      cwd: BACKEND_DIR,
      stdio: ["pipe", "ignore", "pipe"],
    });

    const onSignal = () => proc.kill("SIGINT");
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);

    const bar = new ProgressBar();

    let testTotal = 0;
    let testStarted = 0;
    let runDone: RunResult | null = null;
    const pendingDevtools: { worker: number; url: string }[] = [];
    let buf = "";

    proc.stderr!.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop()!;

      for (const line of lines) {
        if (!line.trim()) continue;
        let ev: any;
        try { ev = JSON.parse(line); } catch { continue; }

        if (ev.status === "start" && STEP_LABELS[ev.event]) {
          let label = STEP_LABELS[ev.event];
          if (ev.event === "auth" && ev.db) label += ` to ${ev.db}`;
          bar.logStepStart(label);
          continue;
        }
        if (ev.status === "done" && STEP_LABELS[ev.event]) {
          let label = STEP_LABELS[ev.event];
          if (ev.event === "auth" && ev.db) label += ` to ${ev.db}`;
          bar.logStepDone(label, ev.ms);
          if (ev.event === "workers_launch" && pendingDevtools.length) {
            process.stdout.write("\n");
            for (const d of pendingDevtools.sort((a, b) => a.worker - b.worker)) {
              process.stdout.write(`  Worker ${d.worker}  ${osc8(d.url, "devtools")}\n`);
            }
            process.stdout.write("\n");
            pendingDevtools.length = 0;
          }
          continue;
        }

        if (ev.event === "tests_resolve" && ev.total !== undefined) {
          testTotal = ev.total;
          bar.log(`${formatter.cyan("ℹ")} ${ev.total} tests across ${ev.workers} workers`);
          continue;
        }
        if (ev.event === "file_scan" && ev.files !== undefined) {
          bar.log(`${formatter.cyan("ℹ")} Scanned ${ev.files} files -- ${ev.tests} tests (${ev.cached} cached, ${ev.updated} updated)`);
          continue;
        }
        if (ev.event === "cache_write_fail") {
          bar.log(formatter.warn(`⚠️ Cache write failed: ${ev.err}`));
          continue;
        }
        if (ev.event === "run_skip") {
          bar.log(formatter.warn("⚠️ No tests matched -- nothing to run"));
          continue;
        }

        if (ev.event === "worker_start") {
          if (ev.devtools) pendingDevtools.push({ worker: ev.worker, url: ev.devtools });
          continue;
        }

        if (ev.event === "run_start") {
          testStarted = 0;
          if (ev.run === 1) {
            bar.start(testTotal, 1);
          } else {
            bar.update(0, ev.run)
          }
          continue;
        }

        if (ev.event === "worker_run" || ev.event === "suite_done") {
          continue;
        }

        if (ev.event === "test_started") {
          bar.startTimer();
          testStarted++;
          bar.update(testStarted);
          bar.updateTitle(ev.test);
          continue;
        }

        if (ev.event === "test_fail") {
          const worker = ev.worker !== undefined ? `[W${ev.worker}] ` : "";
          const id = ev.id ? `[${ev.id}] ` : "";
          const label = worker + id + ev.test;
          const title = ev.url
            ? osc8(ev.url, formatter.warn(label))
            : formatter.warn(label);
          bar.log(title);
          continue;
        }

        if (ev.event === "worker_error") {
          bar.log(formatter.error(`Worker ${ev.worker} crashed: ${ev.err}`));
          continue;
        }

        if (ev.event === "run_done") {
          runDone = { passed: ev.passed, failed: ev.failed, total: ev.total };
          bar.update(testTotal);
          testStarted = 0;
          continue;
        }

        if (ev.event === "run_wait") {
          // Go is blocked on stdin waiting for Y/N after a failed run.
          proc.stderr!.pause();
          const prompt = "Run again? [y/N] ";
          process.stdout.write("\n" + prompt);
          if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
            process.stdin.resume();
            process.stdin.once("data", (key: Buffer) => {
              process.stdin.setRawMode(false);
              process.stdin.pause();
              const ch = key.toString();
              const yes = ch === "\n" || ch === "y" || ch === "Y";
              process.stdout.write((yes ? "y" : ch === "\x03" ? "^C" : ch) + "\n\n");
              proc.stdin!.write(yes ? "y\n" : "n\n");
              if (yes) {
                bar.resetTimer();
                proc.stderr!.resume();
              }
            });
          } else {
            proc.stdin!.write("n\n");
          }
          continue;
        }

        if (ev.level === "error") {
          const label = STEP_LABELS[ev.event] ? `${STEP_LABELS[ev.event]}: ` : `${ev.event}: `;
          bar.log(formatter.error(`✖ ${label}${ev.err ?? ""}`));
        }
      }
    });

    proc.on("error", (err) => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      reject(new Error(`Failed to spawn warden: ${err.message}`));
    });

    proc.on("close", () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      bar.stop();
      resolve(runDone ?? { passed: 0, failed: 0, total: 0 });
    });
  });
}

async function main() {
  const result = await runOnce();
  process.exit(result.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(formatter.error(err.message) + "\n");
  process.exit(2);
});
