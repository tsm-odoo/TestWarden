import chalk from "chalk";
import enquirer from "enquirer";
import { oraPromise } from "ora";
import { Browser, Page } from "puppeteer";
import { combineLatest, filter, from, map, merge, take, takeUntil } from "rxjs";
import { TestResult, TestSuiteAdapter } from "src/adapters/test_suite_adapter.js";
import { launch, setupCache } from "../browser.js";
import { Deferred } from "../helpers/misc.js";
import { formatter } from "../helpers/terminal.js";
import { processExit$ } from "../index.js";
import { TestSuiteConfig } from "../test_suite_config.js";
import { TestSuiteMetadata } from "../test_suite_metadata.js";
import { ProgressBar } from "./progress_bar.js";

export type ExecutorStatistics = {
    min: number;
    max: number;
    median: number;
    sum: number;
};

// TODO - setup DI for config/metadata, https://dev.to/vovaspace/dependency-injection-in-typescript-4mbf
class ExecutorSplit {
    private adapter: TestSuiteAdapter;
    private browser: Browser;
    private page: Page;
    private doneDeferred: Deferred<boolean> = new Deferred();

    constructor(
        private config: TestSuiteConfig,
        private testIds: string[],
    ) {
        this.adapter = new this.config.adapterClass();
    }

    async initalize() {
        this.browser = await launch({ headless: this.config.headless });
        this.page = (await this.browser.pages())[0];
        await setupCache(this.page, this.config);
        await this.page.setCookie(this.config.authCookie);
        await this.page.bringToFront();
        await this.adapter.accessSuite(
            this.page,
            this.adapter.getSuiteURL(this.config, this.testIds),
        );
    }

    async runOnce() {
        return this.adapter.run(this.page);
    }

    async setup() {
        this.adapter.isDonePromise.then((v) => this.doneDeferred.resolve(v));
        await this.adapter.setupProgressListener(this.page);
    }

    async stop() {
        this.doneDeferred.resolve(false);
        try {
            await this.adapter.abort(this.page);
        } catch { }
    }

    async reload() {
        this.adapter.reset();
        this.doneDeferred = new Deferred();
        await this.adapter.reloadSuite(this.page);
    }

    get lastFail$() {
        return this.adapter.lastFail$;
    }

    get currentTest$() {
        return this.adapter.currentTest$;
    }

    get results$() {
        return this.adapter.testResults$;
    }

    get isDonePromise() {
        return this.doneDeferred;
    }

    get failed() {
        return Boolean(this.lastFail$.value);
    }
}

export class Executor {
    private progressBar: ProgressBar;

    constructor(
        private config: TestSuiteConfig,
        private metadata: TestSuiteMetadata,
    ) {
        this.progressBar = new ProgressBar();
        processExit$.pipe(filter(Boolean), take(1)).subscribe(() => this.progressBar.stop());
    }

    async splitTests(): Promise<ExecutorSplit[]> {
        const totalTests = this.metadata.testIds.length;
        let result: string[][] = [];
        if (totalTests === 1) {
            result = Array(this.config.MAX_NUMBER_OF_WORKERS)
                .fill(0)
                .map(() => this.metadata.testIds);
        } else {
            const maxThreadsNeeded = Math.max(
                1,
                Math.floor(totalTests / this.config.MIN_TEST_PER_WORKER),
            );
            const numThreads = Math.min(this.config.MAX_NUMBER_OF_WORKERS, maxThreadsNeeded);
            const testsPerThread = Math.max(
                Math.ceil(totalTests / numThreads),
                this.config.MIN_TEST_PER_WORKER,
            );
            let startIndex = 0;
            for (let i = 0; i < numThreads; i++) {
                const endIndex = Math.min(startIndex + testsPerThread, totalTests);
                result.push(this.metadata.testIds.slice(startIndex, endIndex));
                startIndex = endIndex;
            }
        }
        const splits = result.map((ids) => new ExecutorSplit(this.config, ids));
        await oraPromise(() => Promise.all(splits.map((split) => split.initalize())), {
            text: chalk.white(`Initializing ${result.length} split.s`),
        });
        return splits;
    }

    async run() {
        const splits = await this.splitTests();
        for (let runs = 1; true; runs++) {
            // 1. Setup progress listeners which are taken from every split and
            //    merges as one.
            const isDonePromise = Promise.all(splits.map((s) => s.isDonePromise));
            const done$ = from(isDonePromise);
            const testResults$ = combineLatest(splits.map((s) => s.results$)).pipe(
                takeUntil(processExit$.pipe(filter(Boolean))),
                takeUntil(done$),
                map((r) => r.flat()),
            );
            const currentTest$ = merge(...splits.map((s) => s.currentTest$)).pipe(
                takeUntil(processExit$.pipe(filter(Boolean))),
                takeUntil(done$),
            );
            const lastFail$ = merge(...splits.map((s) => s.lastFail$)).pipe(
                takeUntil(processExit$.pipe(filter(Boolean))),
                takeUntil(done$),
                filter(Boolean),
            );
            // 2. Start the progress bar and update the state according to the
            //    observables.
            this.progressBar.start(
                this.config.testId
                    ? this.config.MAX_NUMBER_OF_WORKERS
                    : this.metadata.testIds.length,
            );
            testResults$.subscribe((r) => {
                this.progressBar.update(r.length, {
                    runs: this.config.testId ? r.length + runs * splits.length : runs,
                    statistics: this.getStatistics(r)
                });
                this.progressBar.refresh();
            });
            lastFail$.subscribe((r) => {
                this.progressBar.log(formatter.warn(`[${r.id}] ${r.name}`));
                if (this.config.failfast || this.config.isSingleTest) {
                    splits.forEach((s) => s.stop());
                }
            });
            if (!this.config.isSingleTest) {
                currentTest$.subscribe((t) =>
                    this.progressBar.update(this.progressBar.value, {
                        currentTestName: t?.name,
                    }),
                );
            }
            // 3. Run the test suite and wait for completion.
            for (const split of splits) {
                await split.setup();
                await split.runOnce();
            }
            await isDonePromise;
            // 4. Process results: print statistics, pause if failed. Then,
            //    reload if there weren't any failures or if the `--run-forever`
            //    option is set.
            const failedSplits = splits.filter((s) => s.failed);
            if (failedSplits.length > 0) {
                if (!this.config.runForever) {
                    await (enquirer as unknown as any).invisible({
                        message: formatter.info("Press any key to continue..."),
                    });
                    this.progressBar.stop();
                    break;
                }
            }
            this.progressBar.logStatistics();
            for (const split of splits) {
                await split.reload();
            }
        }
        this.progressBar.stop();
    }

    getStatistics(results: TestResult[]): ExecutorStatistics {
        let min: number,
            max: number,
            sum: number = 0;
        for (const { duration } of results) {
            if (!min || min > duration) {
                min = duration;
            }
            if (!max || max < duration) {
                max = duration;
            }
            sum += duration;
        }
        let median = sum / results.length;
        min ||= 0;
        max ||= 0;
        return { min, max, median, sum };
    }
}
