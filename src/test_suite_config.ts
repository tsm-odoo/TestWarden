import { TestSuiteAdapter } from "@warden/adapters/test_suite_adapter";
import { StopExecution } from "@warden/errors";
import { formatter, logger } from "@warden/helpers/terminal";
import { TestSuiteMetadata } from "@warden/test_suite_metadata";
import { authenticate } from "@warden/helpers/network";

import commandLineArgs from "command-line-args";
import fs from "fs";
import path from "path";
import { oraPromise } from "ora";

enum RUN_TYPE {
    TEST = "Test",
    SUITE = "Suite",
}

type JSONSettings = {
    suites: { [key: string]: string };
    workers: number;
    minWorkerLoad: number;
    serverURL: string;
    cpuLimit?: number;
};

export class TestSuiteConfig {
    static NOT_YET_IMPLEMENTED = ["promptForRetry", "onlyLastStats", "mobileEmulation"];
    // TODO, move in dedicated file
    static CHECKS = [
        {
            id: "NOT_IMPLEMENTED_YET",
            execute: (config: TestSuiteConfig) => {
                const notYetlImplemFeatures = TestSuiteConfig.NOT_YET_IMPLEMENTED.filter(
                    (feature) => config[feature],
                );
                if (notYetlImplemFeatures.length > 0) {
                    notYetlImplemFeatures.forEach((feature) => (config[feature] = false));
                    return {
                        ok: false,
                        message: `Not yet implemented features will be ignored: ${notYetlImplemFeatures.join(
                            ", ",
                        )}.`,
                        fatal: false,
                    };
                }
                return { ok: true };
            },
        },
        {
            id: "TEST_XOR_MODULE",
            execute: (config: TestSuiteConfig) => {
                if (config.testId && config.suiteIds.length > 0) {
                    return {
                        ok: false,
                        message:
                            "You must provide either `--test-id` or `--suite-ids` but not both.",
                        fatal: true,
                    };
                }
                return { ok: true };
            },
        },
        {
            id: "TARGET_EXISTS",
            execute: (config: TestSuiteConfig) => {
                if (config.testId && !(config.testId in config.metadata.testById)) {
                    return {
                        ok: false,
                        message: `Test with id ${config.testId} does not exist.`,
                        fatal: false,
                    };
                }
                const missingSuiteNames =
                    config.suiteNames.filter((name) => !(name in config.metadata.suiteIdByName)) ??
                    [];
                if (missingSuiteNames.length > 0) {
                    config.suiteNames = config.suiteNames.filter(
                        (name) => !missingSuiteNames.includes(name),
                    );
                    return {
                        ok: false,
                        message: `Dropping missing suites: ${missingSuiteNames.join(", ")}.`,
                        fatal: false,
                    };
                }
                return { ok: true };
            },
        },
        {
            id: "DEBUG_VISIBLE_ONLY_1_WORKER",
            execute: (config: TestSuiteConfig) => {
                if (config.debug && !config.headless && "workers" in config.rawOptions) {
                    config.MAX_NUMBER_OF_WORKERS = 1;
                    delete config.rawOptions["workers"];
                    return {
                        ok: false,
                        message:
                            "Only one worker can be used in debug mode. Ignoring `--workers` argument.",
                        fatal: false,
                    };
                } else if (config.debug && !config.headless) {
                    config.MAX_NUMBER_OF_WORKERS = 1;
                }
                return { ok: true };
            },
        },
        {
            id: "DEBUG_ONLY_SINGLE_TEST",
            execute: (config: TestSuiteConfig) => {
                if (config.debug && config.suiteIds.length > 0) {
                    config.debug = false;
                    config.headless = false;
                    config.MAX_NUMBER_OF_WORKERS = 1;
                    return {
                        ok: false,
                        message:
                            "Debug mode only works with single tests. Downgrading to `--workers 1 --visible`.",
                        fatal: false,
                    };
                }
                return { ok: true };
            },
        },
        {
            id: "RUN_FOREVER_NO_FAIL_FAST",
            execute: (config: TestSuiteConfig) => {
                if (config.failfast && config.runForever) {
                    config.runForever = false;
                    return {
                        ok: false,
                        message:
                            "Cannot use `--run-forever` and `--fail-fast` at the same time. Ignoring `--run-forever`.",
                        fatal: false,
                    };
                }
                return { ok: true };
            },
        },
        {
            id: "NO_DEBUG_NO_ONLY_TAG",
            execute: (config: TestSuiteConfig) => {
                const tags = new Set(
                    Object.values(config.metadata.testById)
                        .map(({ tags }) => tags)
                        .flat(),
                );
                if (tags.has("debug") || tags.has("only")) {
                    return {
                        ok: false,
                        message: "Tests with `test.debug` or `test.only` are not allowed.",
                        fatal: true,
                    };
                }
                return { ok: true };
            },
        },
        {
            id: "NO_TEST_FOUND",
            execute: (config: TestSuiteConfig) => {
                if (!config.metadata.testIds.length && config.suiteIds.length) {
                    return {
                        ok: false,
                        message: `No test found for suite.s: ${config.suiteNames.join(", ")}`,
                        fatal: true, // todo, fatal false, reset everything and prompt the user for a test.
                    };
                }
                return { ok: true };
            },
        },
    ];
    private failedChecks = new Set();
    RUN_TYPE = RUN_TYPE;
    headless: boolean;
    failfast: boolean;
    debug: boolean;
    onlyLastStats: boolean;
    mobileEmulation: boolean;
    promptForRetry: boolean;
    runForever: boolean;
    testId?: string;
    suiteNames?: string[];
    suite?: string;
    serverURL: string;
    verbose: boolean = false;
    cpuLimit: number = 0;
    adapterClass: new () => TestSuiteAdapter;
    authCookie: AuthCookie;
    MAX_NUMBER_OF_WORKERS: number;
    MIN_TEST_PER_WORKER: number;
    metadata: TestSuiteMetadata;
    failFolderPath = path.join(process.cwd(), "FailedTests");

    private static async parseJSONSettings(): Promise<JSONSettings> {
        const settingsFilePath = path.resolve(process.cwd(), "settings.json");
        let settings = {} as JSONSettings;
        try {
            await oraPromise(
                async () => {
                    const settingsFilePath = path.resolve(process.cwd(), "settings.json");
                    await fs.promises.access(settingsFilePath, fs.constants.F_OK);
                    const rawData = await fs.promises.readFile(settingsFilePath, "utf-8");
                    settings = JSON.parse(rawData);
                    return settings;
                },
                {
                    text: formatter.info(`Loading settings from ${settingsFilePath}`),
                    failText: (err: any) => {
                        return err.code === "ENOENT"
                            ? formatter.info("No settings found, defaults will be used")
                            : formatter.error(
                                  `Failed to load settings from "${settingsFilePath}"\n\t${err.message}`,
                              );
                    },
                    successText: formatter.info(`Settings loaded from ${settingsFilePath}`),
                },
            );
        } catch (e) {}
        settings.suites ??= {};
        settings.workers = Number(settings.workers ?? 4);
        settings.minWorkerLoad = Number(settings.minWorkerLoad ?? 15);
        settings.serverURL ??= "http://localhost:8069";
        settings.cpuLimit ??= 0;
        return settings;
    }

    static async parseCLIOptions() {
        const settings = await TestSuiteConfig.parseJSONSettings();
        const optionsDefinition = [
            { name: "verbose", type: Boolean, default: false },
            { name: "debug", type: Boolean },
            { name: "test-id", alias: "t", type: String },
            { name: "workers", type: Number, defaultValue: settings["workers"] },
            { name: "min-worker-load", type: Number, defaultValue: settings["minWorkerLoad"] },
            { name: "suite-names", alias: "m", multiple: true },
            { name: "suite", type: String, defaultValue: "hoot" },
            { name: "server-url", type: String, defaultValue: settings["serverURL"] },
            { name: "visible", type: Boolean, defaultValue: false },
            { name: "fail-fast", type: Boolean, defaultValue: false },
            { name: "run-forever", type: Boolean, defaultValue: false },
            { name: "mobile", type: Boolean, defaultValue: false }, // TODO - NOT YET IMPLEMENTED
            { name: "prompt-for-retry", type: Boolean, defaultValue: false }, // TODO - NOT YET IMPLEMENTED
            { name: "cpu-limit", type: Number, defaultValue: settings["cpuLimit"] },
        ];
        const rawOptions = commandLineArgs(optionsDefinition);
        if ("suite" in rawOptions) {
            rawOptions["suite"] =
                settings.suites[rawOptions["suite"] as string] ?? rawOptions["suite"];
        }
        console.log(rawOptions["server-url"]);
        const authCookie = await authenticate(rawOptions["server-url"], "admin", "admin");
        return new TestSuiteConfig(rawOptions, authCookie);
    }

    constructor(
        public rawOptions: TestSuiteConfigOptions,
        authCookie: AuthCookie,
    ) {
        this.debug = rawOptions.debug ?? false;
        this.testId = rawOptions["test-id"];
        this.suite = rawOptions.suite;
        this.serverURL = rawOptions["server-url"];
        this.headless = !rawOptions.visible;
        this.failfast = rawOptions["fail-fast"] ?? false;
        this.onlyLastStats = rawOptions["only-last-stats"] ?? false;
        this.mobileEmulation = rawOptions.mobile ?? false;
        this.promptForRetry = rawOptions["prompt-for-retry"] ?? false;
        this.authCookie = authCookie;
        this.MAX_NUMBER_OF_WORKERS = rawOptions["workers"];
        this.MIN_TEST_PER_WORKER = rawOptions["min-worker-load"];
        this.runForever = rawOptions["run-forever"];
        this.suiteNames = rawOptions["suite-names"] ?? [];
        this.verbose = rawOptions.verbose;
        this.cpuLimit = rawOptions["cpu-limit"] ?? 0;
    }

    get baseSuiteURL() {
        // TODO - specific suite parameters to adapters
        const opts: [string, any][] = [
            ["debug", "tests,assets"],
            ["timeout", "15000"],
            ["loglevel", "3"],
            ["manual", "true"],
            // ["headless", "true"],
        ];
        if (this.failfast) {
            opts.push(["failfast", true]);
        }
        if (this.debug) {
            opts.push(["debugTest", "true"]);
        }
        const baseUrlParts = [this.serverURL, ...this.suite.split("/").filter(Boolean)];
        if (this.failfast) {
            opts.push(["bail", 1]);
        }
        const queryString = opts.map((pair) => pair.join("=")).join("&");
        return `${baseUrlParts.join("/")}?${queryString}`;
    }

    get hasTarget() {
        return this.testId || this.suiteIds.length > 0;
    }

    get runType() {
        return this.testId ? this.RUN_TYPE.TEST : this.RUN_TYPE.SUITE;
    }

    get isSingleTest() {
        return this.metadata.testIds.length === 1;
    }

    get suiteIds() {
        return this.suiteNames
            .map((name: string) => this.metadata.suiteIdByName[name])
            .filter(Boolean);
    }

    /**
     * Check if the config is valid. If the application can recover, adapt the
     * config and go further. If not, throw an error. This method should only be
     * called when the metadata are available.
     */
    check() {
        const missingChecks = TestSuiteConfig.CHECKS.filter(({ id }) => !this.failedChecks.has(id));
        for (const check of missingChecks) {
            const result = check.execute(this);
            if (result.ok) {
                continue;
            }
            this.failedChecks.add(check.id);
            if (result.fatal) {
                logger.error(result.message);
                throw new StopExecution();
            }
            logger.warn(result.message);
        }
    }
}
