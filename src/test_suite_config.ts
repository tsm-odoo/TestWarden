import { TestSuiteAdapter } from "@warden/adapters/test_suite_adapter";
import { StopExecution } from "@warden/errors";
import { formatter, logger } from "@warden/helpers/terminal";
import { TestSuiteMetadata } from "@warden/test_suite_metadata";
import { authenticate } from "@warden/helpers/network";

import { Command } from "commander";
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
  // Do not return object, throw FatalConfigError() or ConfigError()
  static CHECKS: {
    id: string;
    execute: (config: TestSuiteConfig) => { ok: boolean; message?: string; fatal?: boolean };
  }[] = [
      {
        id: "NOT_IMPLEMENTED_YET",
        execute: (config: TestSuiteConfig) => {
          const notYetlImplemFeatures = TestSuiteConfig.NOT_YET_IMPLEMENTED.filter((feature) => config[feature]);
          if (notYetlImplemFeatures.length > 0) {
            notYetlImplemFeatures.forEach((feature) => (config[feature] = false));
            return {
              ok: false,
              message: `Not yet implemented features will be ignored: ${notYetlImplemFeatures.join(", ")}.`,
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
              message: "You must provide either `--test-id` or `--suite-ids` but not both.",
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
            };
          }
          const missingSuiteNames = config.suiteNames.filter((name) => !(name in config.metadata.suiteIdByName)) ?? [];
          if (missingSuiteNames.length > 0) {
            config.suiteNames = config.suiteNames.filter((name) => !missingSuiteNames.includes(name));
            return {
              ok: false,
              message: `Dropping missing suites: ${missingSuiteNames.join(", ")}.`,
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
              message: "Only one worker can be used in debug mode. Ignoring `--workers` argument.",
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
              message: "Debug mode only works with single tests. Downgrading to `--workers 1 --visible`.",
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
              message: "Cannot use `--run-forever` and `--fail-fast` at the same time. Ignoring `--run-forever`.",
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
  MAX_NUMBER_OF_WORKERS: number;
  MIN_TEST_PER_WORKER: number;
  RUN_TYPE = RUN_TYPE;
  adapterClass: new () => TestSuiteAdapter;
  authCookie: AuthCookie;
  cpuLimit: number = 0;
  cpuThrottling: number = 0;
  debug: boolean;
  devtools: boolean = false;
  failFolderPath = path.join(process.cwd(), "FailedTests");
  failfast: boolean;
  headless: boolean;
  metadata: TestSuiteMetadata;
  mobileEmulation: boolean;
  onlyLastStats: boolean;
  runForever: boolean;
  serverURL: string;
  suite?: string;
  suiteNames?: string[];
  testId?: string;
  verbose: boolean = false;
  once: boolean = false

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
              : formatter.error(`Failed to load settings from "${settingsFilePath}"\n\t${err.message}`);
          },
          successText: formatter.info(`Settings loaded from ${settingsFilePath}`),
        },
      );
    } catch (e) { }
    settings.suites ??= {};
    settings.workers = Number(settings.workers ?? 4);
    settings.minWorkerLoad = Number(settings.minWorkerLoad ?? 15);
    settings.serverURL ??= "http://localhost:8069";
    settings.cpuLimit ??= 0;
    return settings;
  }

  static async parseCLIOptions() {
    const settings = await TestSuiteConfig.parseJSONSettings();
    const program = new Command();
    program
      .description(
        'Test Warden is a CLI launcher for unit testing that runs tests until failure, reporting screenshots, logs, and notifying when failures occur.'
      )
      .addHelpText(
        'before',
        `
████████ ███████ ███████ ████████     ██     ██  █████  ██████  ██████  ███████ ███    ██
   ██    ██      ██         ██        ██     ██ ██   ██ ██   ██ ██   ██ ██      ████   ██
   ██    █████   ███████    ██        ██  █  ██ ███████ ██████  ██   ██ █████   ██ ██  ██
   ██    ██           ██    ██        ██ ███ ██ ██   ██ ██   ██ ██   ██ ██      ██  ██ ██
   ██    ███████ ███████    ██         ███ ███  ██   ██ ██   ██ ██████  ███████ ██   ████

`)
      .option(
        "--verbose",
        "Enable Chrome debug messages (dumpio). Useful for debugging browser behavior."
      )
      .option(
        "--devtools",
        "Open Chrome DevTools during test execution."
      )
      .option(
        "--once",
        "Run the test suite only once, then exit (success or failure).",
        false,
      )
      .option(
        "--debug",
        "Activate test suite debug mode (UI visible)."
      )
      .option(
        "--visible",
        "Run tests in headful mode (headless disabled)."
      )
      .option(
        "-t, --test-id <id>",
        "Specify the ID of a single test to run."
      )
      .option(
        "--workers <number>",
        "Number of parallel browser instances used to run tests.",
        parseInt,
        settings["workers"]
      )
      .option(
        "--min-worker-load <number>",
        "Minimum number of tests to assign to a worker. For example, with 50 tests and 4 workers, setting 25 means only 2 workers will run.",
        parseInt,
        settings["minWorkerLoad"]
      )
      .option(
        "-m, --suite-names <names...>",
        "Run only specific test suites by name."
      )
      .option(
        "--suite <name>",
        "Name of the suite to run (default: 'hoot').",
        "hoot"
      )
      .option(
        "--server-url <url>",
        "URL of the server to run tests against.",
        settings["serverURL"]
      )
      .option(
        "--fail-fast",
        "Stop immediately when a test fails (by default, remaining tests continue).",
        false
      )
      .option(
        "--run-forever",
        "Continue running tests even if a test fails.",
        false
      )
      .option(
        "--mobile",
        "Enable mobile emulation (TODO: not fully implemented).",
        false
      )
      .option(
        "--cpu-limit <number>",
        "Maximum number of CPU cores to use when running tests.",
        parseInt,
        settings["cpuLimit"]
      )
      .option("--cpu-throttling <number>", "CPU throttling factor (0-100)", parseInt, 0)
    program.parse(process.argv);

    const rawOptions = program.opts();
    if ("suite" in rawOptions) {
      rawOptions["suite"] = settings.suites[rawOptions["suite"] as string] ?? rawOptions["suite"];
    }
    const authCookie = await authenticate(rawOptions["serverUrl"], "admin", "admin");
    return new TestSuiteConfig(rawOptions as any, authCookie);
  }

  constructor(
    public rawOptions: TestSuiteConfigOptions,
    authCookie: AuthCookie,
  ) {
    this.debug = rawOptions.debug;
    this.devtools = rawOptions.devtools;
    this.testId = rawOptions["testId"];
    this.suite = rawOptions.suite;
    this.serverURL = rawOptions["serverUrl"];
    this.headless = !rawOptions.visible;
    this.failfast = rawOptions["failFast"];
    this.onlyLastStats = rawOptions["onlyLastStats"];
    this.mobileEmulation = rawOptions.mobile ?? false;
    this.authCookie = authCookie;
    this.MAX_NUMBER_OF_WORKERS = rawOptions["workers"];
    this.MIN_TEST_PER_WORKER = rawOptions["minWorkerLoad"];
    this.runForever = rawOptions["runForever"];
    this.suiteNames = rawOptions["suiteNames"] ?? [];
    this.verbose = rawOptions.verbose;
    this.once = rawOptions.once;
    this.cpuLimit = rawOptions["cpuLimit"] ?? 0;
    this.cpuThrottling = rawOptions["cpuThrottling"] ?? 0;
  }

  get baseSuiteURL() {
    // TODO - specific suite parameters to adapters
    const opts: [string, any][] = [
      ["debug", "tests,assets"],
      ["timeout", "15000"],
      ["loglevel", this.debug ? "3" : "0"],
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

  get isSingleTest() {
    return this.metadata.testIds.length === 1;
  }

  get suiteIds() {
    return this.suiteNames.map((name: string) => this.metadata.suiteIdByName[name]).filter(Boolean);
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
