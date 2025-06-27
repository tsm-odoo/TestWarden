import { TestResult, TestSuiteAdapter } from "@warden/adapters/test_suite_adapter";
import { launch, setupCache } from "@warden/browser";
import { Deferred } from "@warden/helpers/misc";
import { formatter } from "@warden/helpers/terminal";
import { processExit$ } from "@warden/index";
import { TestSuiteConfig } from "@warden/test_suite_config";
import { TestSuiteMetadata } from "@warden/test_suite_metadata";
import { ProgressBar } from "@warden/runner/progress_bar";
import { uuid } from "@warden/helpers/misc";

import chalk from "chalk";
import fs from "fs";
import path from "path";
import { Browser, Page } from "puppeteer";
import { combineLatest, filter, from, lastValueFrom, map, merge, take, takeUntil } from "rxjs";
import { oraPromise } from "ora";

export type ExecutorStatistics = {
  runs: number;
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
    this.browser = await launch({
      headless: this.config.headless,
      dumpio: this.config.verbose,
    });
    this.page = (await this.browser.pages())[0];
    await setupCache(this.page, this.config);
    await this.page.setCookie(this.config.authCookie);
    await this.page.bringToFront();
    await this.adapter.accessSuite(this.page, this.adapter.getSuiteURL(this.config, this.testIds));
  }

  async start() {
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
    } catch {}
  }

  async reload() {
    this.adapter.reset();
    this.doneDeferred = new Deferred();
    await this.adapter.reloadSuite(this.page);
  }

  async screenshotFails(path: string) {
    return this.adapter.screenshotFails(this.page, path);
  }

  async setFailureFavicon() {
    await this.page.evaluate(() => {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      canvas.width = 24;
      canvas.height = 24;
      ctx.beginPath();
      ctx.arc(12, 12, 11, 0, 2 * Math.PI);
      ctx.fillStyle = "#FF0000";
      ctx.fill();
      const dataUrl = canvas.toDataURL();
      let link = document.querySelector("link[rel*='icon']") as HTMLAnchorElement;
      link.href = dataUrl;
    });
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
  private splits: ExecutorSplit[] = [];

  constructor(
    private config: TestSuiteConfig,
    private metadata: TestSuiteMetadata,
  ) {
    this.progressBar = new ProgressBar();
    processExit$.pipe(filter(Boolean), take(1)).subscribe(() => this.progressBar.stop());
  }

  async splitTests(): Promise<ExecutorSplit[]> {
    let result: string[][] = [];
    if (this.config.isSingleTest) {
      result = Array(this.config.MAX_NUMBER_OF_WORKERS)
        .fill(0)
        .map(() => this.metadata.testIds);
    } else {
      const totalTests = this.metadata.testIds.length;
      const maxThreadsNeeded = Math.max(1, Math.floor(totalTests / this.config.MIN_TEST_PER_WORKER));
      const numThreads = Math.min(this.config.MAX_NUMBER_OF_WORKERS, maxThreadsNeeded);
      const testsPerThread = Math.max(Math.ceil(totalTests / numThreads), this.config.MIN_TEST_PER_WORKER);
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

  async *run() {
    this.splits = await this.splitTests();
    const previousResults = [];
    for (let runs = 1; true; runs++) {
      // 1. Setup progress listeners which are taken from every split and
      //    merges as one.
      const isDonePromise = Promise.all(this.splits.map((s) => s.isDonePromise));
      const done$ = from(isDonePromise);
      const testResults$ = combineLatest(this.splits.map((s) => s.results$)).pipe(
        takeUntil(processExit$.pipe(filter(Boolean))),
        takeUntil(done$),
        map((r) => r.flat()),
      );
      const currentTest$ = merge(...this.splits.map((s) => s.currentTest$)).pipe(
        takeUntil(processExit$.pipe(filter(Boolean))),
        takeUntil(done$),
        filter(Boolean),
      );
      const lastFail$ = merge(...this.splits.map((s) => s.lastFail$)).pipe(
        takeUntil(processExit$.pipe(filter(Boolean))),
        takeUntil(done$),
        filter(Boolean),
      );
      // 2. Start the progress bar and update the state according to the
      //    observables.
      this.progressBar.start(
        this.config.isSingleTest ? this.config.MAX_NUMBER_OF_WORKERS : this.metadata.testIds.length,
      );
      testResults$.subscribe((r) => {
        const totalRuns = this.config.isSingleTest ? r.length + runs * this.splits.length : runs;
        this.progressBar.update(r.length);
        this.updateStatistics(totalRuns, r, previousResults);
      });
      lastFail$.subscribe((r) => {
        const totalRuns = this.config.isSingleTest ? runs * this.splits.length : runs;
        this.progressBar.log(
          formatter.warn(`${totalRuns}. [${r.id}] ${r.name} - ${Math.round(r.duration * 100) / 100}s`),
        );
        if (!this.config.runForever && (this.config.failfast || this.config.isSingleTest)) {
          this.splits.forEach((s) => s.stop());
        }
      });
      if (!this.config.isSingleTest) {
        currentTest$.subscribe((t) => this.progressBar.updateTitle(t.name));
      }
      // 3. Run the test suite and wait for completion.
      await Promise.all(this.splits.map((s) => s.setup()));
      await Promise.all(this.splits.map((s) => s.start()));
      await isDonePromise;
      const success = this.splits.every((s) => !s.failed);
      if (!this.config.runForever) {
        await Promise.all([this.splits.filter((s) => s.failed).map((s) => s.setFailureFavicon())]);
      }
      // 4. Let the runner process the result.
      yield { success };
      previousResults.push(...(await lastValueFrom(testResults$)));
      await Promise.all(this.splits.map((s) => s.reload()));
    }
  }

  async screenshotFails() {
    const fullPath = path.join(this.config.failFolderPath, `result-${uuid()}`);
    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true });
    }
    await oraPromise(
      async () => {
        for (const split of this.splits) {
          await split.screenshotFails(fullPath);
        }
      },
      {
        text: formatter.info(`Saving screenshot.s to ${fullPath}`),
        successText: formatter.info(`Screenshot.s saved to ${fullPath}`),
        failText: formatter.error(`Failed to save screenshot.s to ${fullPath}`),
      },
    );
  }

  stop() {
    this.progressBar.stop();
  }

  updateStatistics(runs: number, currentResults: TestResult[], previousResults: TestResult[]) {
    const allResults = [...currentResults, ...previousResults];
    let min: number,
      max: number,
      sum_all: number = 0;
    for (const { duration } of allResults) {
      if (!min || min > duration) {
        min = duration;
      }
      if (!max || max < duration) {
        max = duration;
      }
      sum_all += duration;
    }
    let median = sum_all / allResults.length;
    min ||= 0;
    max ||= 0;
    const sum_current = currentResults.reduce((acc, { duration }) => acc + duration, 0);
    this.progressBar.updateStatistics({ min, max, median, runs, sum: sum_current });
  }
}
