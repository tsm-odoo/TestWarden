import { spawn } from "child_process";
import { EventEmitter } from "events";
import path from "path";
import { fileURLToPath } from "url";
import { program } from "commander";
import fs from "fs";
import { mountUi } from "@warden/ui";
import { UiAction, osc8 } from "@warden/ui_state";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = path.resolve(__dirname, "../engine");

const ARCH_MAP: Record<string, string> = { x64: "amd64", arm64: "arm64" };
const arch = ARCH_MAP[process.arch];
if (!arch || (process.platform !== "linux" && process.platform !== "darwin")) {
    process.stderr.write(`Unsupported platform: ${process.platform}/${process.arch}\n`);
    process.exit(2);
}
const WARDEN_BIN = path.join(ENGINE_DIR, "dist", `engine-${process.platform}-${arch}`);

let settings: Record<string, any> = {};
try {
    settings = JSON.parse(fs.readFileSync(path.join(ENGINE_DIR, "settings.json"), "utf8"));
} catch {}

program
    .option("--server-url <url>", "Odoo server URL", settings.serverURL ?? "http://localhost:8069")
    .option("--suite <path-or-name>", "Test suite path or name (hoot, livechat, …)", "hoot")
    .option("-m, --suite-names <names...>", "Suite name(s) to run")
    .option("-t, --test <id>", "Single test name or ID")
    .option(
        "--workers <number>",
        "Parallel browser contexts",
        (value) => parseInt(value),
        settings.workers ?? 4,
    )
    .option("--fail-fast", "Stop on the first failure", false)
    .option("--once", "Run once and exit (default: re-run until a failure is found)", false)
    .option(
        "--flaky-check <number>",
        "Repeat a single test N times total (split across --workers) without stopping on failure, then report a pass/fail ratio (requires -t)",
        (value) => parseInt(value),
    )
    .option("--visible", "Run in visible browser with devtools and full-screen window", false)
    .option(
        "--debug",
        "Pause for interactive debugging on a single test (implies -t, workers=1)",
        false,
    )
    .option("--cpu-throttling <number>", "CPU throttling factor (0-100)", parseInt, 0)
    .option("--console", "Print the browser console lines Hoot doesn't emit itself", false)
    .option(
        "--worker-timeout <seconds>",
        "Fail a worker whose page shows no test progress for this long (0 disables)",
        (value) => parseInt(value),
    )
    .option("--verbose", "Print the command issued to the engine", false)
    // Legacy flags, check if it should be removed later. Probably keep cpu limit & load parameters.
    .option("--devtools", "ignored", false)
    .option("--cpu-limit <number>", "ignored", parseInt, 0)
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
    flakyCheck?: number;
    visible: boolean;
    debug: boolean;
    cpuThrottling: number;
    console: boolean;
    workerTimeout?: number;
    verbose: boolean;
}>();

const wardenArgs: string[] = [
    "--server",
    opts.serverUrl,
    opts.suite.startsWith("/") ? "--suite-path" : "--suite",
    opts.suite,
    "--workers",
    String(opts.workers),
    "--pause-before-exit",
];
if (opts.suiteNames?.length) {
    wardenArgs.push("--suite-names", opts.suiteNames.join(","));
}
if (opts.test) {
    wardenArgs.push("--test", opts.test);
}
if (opts.failFast) {
    wardenArgs.push("--fail-fast");
}
if (opts.flakyCheck) {
    wardenArgs.push("--flaky-check", String(opts.flakyCheck));
} else if (!opts.once) {
    wardenArgs.push("--run-until-fail");
}
if (opts.visible) {
    wardenArgs.push("--visible");
}
if (opts.debug) {
    wardenArgs.push("--debug");
}
if (opts.cpuThrottling) {
    wardenArgs.push("--cpu-throttling", String(opts.cpuThrottling));
}
if (opts.console) {
    wardenArgs.push("--console");
}
if (opts.workerTimeout !== undefined) {
    wardenArgs.push("--worker-timeout", String(opts.workerTimeout));
}

// Resolves with the engine's own exit code, so a run that dies before any test ran (server
// unreachable, unknown suite, no test matched, ...) doesn't read as green.
async function runOnce(): Promise<number> {
    return new Promise((resolve, reject) => {
        const actionEmitter = new EventEmitter();
        const answerEmitter = new EventEmitter();
        const ui = mountUi(actionEmitter, answerEmitter);
        const dispatch = (action: UiAction) => actionEmitter.emit("action", action);

        if (opts.verbose) {
            dispatch({
                type: "log",
                kind: "debug",
                text: `${WARDEN_BIN} ${wardenArgs.join(" ")}`,
            });
        }

        const proc = spawn(WARDEN_BIN, wardenArgs, {
            cwd: ENGINE_DIR,
            stdio: ["pipe", "pipe", "ignore"],
        });

        // The engine force-exits on a signal without emitting run_done, so grey out the UI
        // here instead of waiting on a done event that will never come.
        const onSignal = () => {
            dispatch({ type: "interrupted" });
            proc.kill("SIGINT");
        };
        process.once("SIGINT", onSignal);
        process.once("SIGTERM", onSignal);

        let buf = "";

        proc.stdout!.on("data", (chunk: Buffer) => {
            buf += chunk.toString();
            const lines = buf.split("\n");
            buf = lines.pop()!;

            for (const line of lines) {
                if (!line.trim()) {
                    continue;
                }
                let msg: any;
                try {
                    msg = JSON.parse(line);
                } catch {
                    continue;
                }
                switch (msg.type) {
                    case "step_start":
                    case "run_start":
                    case "test_started":
                    case "log":
                        dispatch(msg as UiAction);
                        continue;
                    case "step_done":
                        dispatch(msg as UiAction);
                        continue;
                    case "run_done":
                        dispatch(msg as UiAction);
                        continue;
                    case "flaky_result":
                        dispatch(msg as UiAction);
                        continue;
                    case "run_wait_prompt":
                        if (!process.stdin.isTTY) {
                            proc.stdin!.write("\n");
                            continue;
                        }
                        proc.stdout!.pause();
                        dispatch(msg as UiAction);
                        answerEmitter.once("answer", () => {
                            proc.stdin!.write("\n");
                        });
                        continue;
                    case "worker_start":
                        if (msg.devtools) {
                            dispatch({
                                type: "worker_devtools",
                                worker: msg.worker,
                                url: msg.devtools,
                            });
                        }
                        continue;
                    case "worker_run":
                        dispatch({ type: "worker_run", worker: msg.worker });
                        continue;
                    case "suite_done":
                    case "worker_done":
                        continue;
                    case "test_fail": {
                        const id = msg.id ? `[${msg.id}] ` : "";
                        const label = id + msg.test;
                        const text = msg.url ? osc8(msg.url, label) : label;
                        dispatch({
                            type: "test_fail",
                            worker: msg.worker,
                            text,
                            stack: msg.stack,
                        });
                        continue;
                    }
                    case "tests_not_run": {
                        const shown = (msg.ids as string[]).slice(0, 10).join(" ");
                        const more = msg.count > 10 ? ` (+${msg.count - 10} more)` : "";
                        dispatch({
                            type: "log",
                            kind: "warn",
                            text: `▲ worker ${msg.worker}: ${msg.count} tests did not run: ${shown}${more}`,
                        });
                        continue;
                    }
                    case "console": {
                        const test = msg.test ? `[${msg.test}] ` : "";
                        dispatch({
                            type: "log",
                            kind: "console",
                            text: `console.${msg.level} ${test}${msg.text}`,
                        });
                        continue;
                    }
                    case "debug": {
                        const { type: _type, event, ms, ...fields } = msg;
                        let text: string;
                        if (ms !== undefined) {
                            text = `${event} (done in ${ms}ms)`;
                        } else {
                            const rest = Object.entries(fields)
                                .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
                                .join(" ");
                            text = rest ? `${event} ${rest}` : event;
                        }
                        dispatch({ type: "log", kind: "debug", text });
                        continue;
                    }
                    case "diagnostic": {
                        const prefix = msg.level === "error" ? "✖" : "▲";
                        dispatch({
                            type: "log",
                            kind: msg.level,
                            text: `${prefix} ${msg.label}: ${msg.message ?? ""}`,
                        });
                        if (msg.worker !== undefined) {
                            dispatch({ type: "worker_error", worker: msg.worker });
                        }
                        continue;
                    }
                }
            }
        });

        proc.on("error", (err) => {
            process.off("SIGINT", onSignal);
            process.off("SIGTERM", onSignal);
            reject(new Error(`Failed to spawn warden: ${err.message}`));
        });

        proc.on("close", (code, signal) => {
            process.off("SIGINT", onSignal);
            process.off("SIGTERM", onSignal);
            ui.stop();
            resolve(code ?? (signal ? 130 : 2));
        });
    });
}

async function main() {
    process.exit(await runOnce());
}

main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
});
