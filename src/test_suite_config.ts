import { TestSuiteAdapter } from "./adapters/test_suite_adapter.js";
import { StopExecution } from "./errors.js";
import { logger } from "./helpers/terminal.js";
import { TestSuiteMetadata } from "./test_suite_metadata.js";

enum RUN_TYPE {
    TEST = "Test",
    SUITE = "Suite",
}

export class TestSuiteConfig {
    static NOT_YET_IMPLEMENTED = ["promptForRetry", "onlyLastStats", "mobileEmulation"];
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
                if (config.testId && !(config.testId in config.metadata.testsById)) {
                    return {
                        ok: false,
                        message: `Test with id ${config.testId} does not exist.`,
                        fatal: false,
                    };
                }
                const missingSuiteNames = config.rawOptions["suite-names"]?.filter(
                    (name) => !(name in config.metadata.suiteIdByName),
                ) ?? [];
                if (missingSuiteNames.length > 0) {
                    config.suiteIds = config.suiteIds?.filter(
                        (id) => id in config.metadata.suiteById,
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
            id: "1_WORKER_IN_DEBUG",
            execute: (config: TestSuiteConfig) => {
                if (config.debug && "workers" in config.rawOptions) {
                    config.MAX_NUMBER_OF_WORKERS = 1;
                    delete config.rawOptions["workers"];
                    return {
                        ok: false,
                        message:
                            "Only one worker can be used in debug mode. Ignoring `--workers` argument.",
                        fatal: false,
                    };
                } else if (config.debug) {
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
    suiteIds?: string[];
    suite?: string;
    serverURL: string;
    adapterClass: new () => TestSuiteAdapter;
    authCookie: AuthCookie;
    MAX_NUMBER_OF_WORKERS: number;
    MIN_TEST_PER_WORKER: number;
    metadata: TestSuiteMetadata;

    constructor(
        public rawOptions: TestSuiteConfigOptions,
        authCookie: AuthCookie,
    ) {
        this.debug = rawOptions.debug ?? false;
        this.testId = rawOptions["test-id"];
        this.suite = rawOptions.suite;
        this.serverURL = rawOptions["server-url"] ?? "http://localhost:8069";
        this.headless = !rawOptions.visible && !this.debug;
        this.failfast = rawOptions["fail-fast"] ?? false;
        this.onlyLastStats = rawOptions["only-last-stats"] ?? false;
        this.mobileEmulation = rawOptions.mobile ?? false;
        this.promptForRetry = rawOptions["prompt-for-retry"] ?? false;
        this.authCookie = authCookie;
        this.MAX_NUMBER_OF_WORKERS = rawOptions["workers"] ?? 4;
        this.MIN_TEST_PER_WORKER = rawOptions["tests-per-worker"] ?? 10;
        this.runForever = rawOptions["run-forever"];
    }

    get baseSuiteURL() {
        // TODO - specific suite parameters to adapters
        const opts: [string, any][] = [
            ["debug", "tests,assets"],
            ["timeout", "15000"],
            ["loglevel", "3"],
            ["manual", "true"],
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

    private generateHash(...strings: String[]) {
        const str = strings.join("\x1C");

        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = (hash << 5) - hash + str.charCodeAt(i);
            hash |= 0;
        }

        // Convert the possibly negative number hash code into an 8 character
        // hexadecimal string
        return (hash + 16 ** 8).toString(16).slice(-8);
    }

    /**
     * Checks if the config is valid. If the application can recover, adapt the
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
