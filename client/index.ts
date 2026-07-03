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
    .option("--suite <name>", "Test suite type (hoot, livechat, …)", "hoot")
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
    .option("--visible", "Run in visible browser with devtools and full-screen window", false)
    .option(
        "--debug",
        "Pause for interactive debugging on a single test (implies -t, workers=1)",
        false,
    )
    .option("--cpu-throttling <number>", "CPU throttling factor (0-100)", parseInt, 0)
    // Legacy flags, check if it should be removed later. Probably keep cpu limit & load parameters.
    .option("--verbose", "ignored", false)
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
    visible: boolean;
    debug: boolean;
    cpuThrottling: number;
}>();

const wardenArgs: string[] = [
    "--server",
    opts.serverUrl,
    "--suite",
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
if (!opts.once) {
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

interface RunResult {
    passed: number;
    failed: number;
    total: number;
}

async function runOnce(): Promise<RunResult> {
    return new Promise((resolve, reject) => {
        const proc = spawn(WARDEN_BIN, wardenArgs, {
            cwd: ENGINE_DIR,
            stdio: ["pipe", "pipe", "ignore"],
        });

        const onSignal = () => proc.kill("SIGINT");
        process.once("SIGINT", onSignal);
        process.once("SIGTERM", onSignal);

        const actionEmitter = new EventEmitter();
        const answerEmitter = new EventEmitter();
        const ui = mountUi(actionEmitter, answerEmitter);
        const dispatch = (action: UiAction) => actionEmitter.emit("action", action);

        let runDone: RunResult | null = null;
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
                        runDone = { passed: msg.passed, failed: msg.failed, total: msg.total };
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
                    case "suite_done":
                    case "worker_done":
                    case "meta_cache_hit":
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

                    case "diagnostic": {
                        const prefix = msg.level === "error" ? "✖" : "▲";
                        dispatch({
                            type: "log",
                            kind: msg.level,
                            text: `${prefix} ${msg.label}: ${msg.message ?? ""}`,
                        });
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

        proc.on("close", () => {
            process.off("SIGINT", onSignal);
            process.off("SIGTERM", onSignal);
            ui.stop();
            resolve(runDone ?? { passed: 0, failed: 0, total: 0 });
        });
    });
}

async function main() {
    const result = await runOnce();
    process.exit(result.failed > 0 ? 1 : 0);
}

main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
});
