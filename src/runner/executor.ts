import { TestResult, TestSuiteAdapter } from "@warden/adapters/test_suite_adapter";
import { setupCache } from "@warden/browser";
import { Deferred } from "@warden/helpers/misc";
import { formatter } from "@warden/helpers/terminal";
import { processExit$ } from "@warden/index";
import { ProgressBar } from "@warden/runner/progress_bar";
import { TestSuiteConfig } from "@warden/test_suite_config";
import { TestSuiteMetadata } from "@warden/test_suite_metadata";

import fs from "fs";
import { oraPromise } from "ora";
import { Browser, Page } from "puppeteer";
import { combineLatest, filter, from, map, merge, mergeMap, take, takeUntil } from "rxjs";

export type ExecutorStatistics = {
  runs: number;
  min: number;
  max: number;
  median: number;
  sum: number;
};

// TODO - setup DI for config/metadata, https://dev.to/vovaspace/dependency-injection-in-typescript-4mbf
export class ExecutorSplit {
  static id = 0;

  private adapter: TestSuiteAdapter;
  private page!: Page;
  private doneDeferred: Deferred<boolean> = new Deferred();
  private failIcon?: string;
  id: number;

  constructor(
    private config: TestSuiteConfig,
    public testIds: string[],
  ) {
    this.adapter = new this.config.adapterClass();
    this.id = ExecutorSplit.id++;
  }

  async initalize(browser: Browser) {
    if (this.id === 0) {
      [this.page] = await browser.pages();
    } else {
      const context = await browser.createBrowserContext();
      this.page = await context.newPage();
    }
    await Promise.all([
      setupCache(this.page, this.config),
      this.page.setCookie(this.config.authCookie),
      this.page.bringToFront(),
    ]);
    await this.adapter.accessSuite(this.page, this.adapter.getSuiteURL(this.config, this.testIds));
    await this.setPageFriendlyName();
  }

  get friendlyName() {
    return `TestWarden - Split ${this.id} (${this.testIds.length} tests)`;
  }

  async setPageFriendlyName() {
    await this.page.evaluate((name) => {
      const title = document.head.querySelector("title");
      if (title) title.innerText = name;
    }, this.friendlyName);
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
    await this.setPageFriendlyName();
  }

  async setFailureFavicon() {
    if (!this.failIcon) {
      this.failIcon = (await fs.promises.readFile('src/resources/angry.png')).toString("base64");
    }
    await this.page.evaluate((base64Icon) => {
      const dataUrl = `data:image/png;base64,${base64Icon}`;
      const link = document.querySelector("link[rel*='icon']") as HTMLAnchorElement;
      link.href = dataUrl;
    }, this.failIcon);
  }

  get currentTest$() {
    return this.adapter.currentTest$;
  }

  get results$() {
    return this.adapter.testResults$;
  }

  get lastFail$() {
    const seenIds = new Set<string>();
    return this.results$.pipe(
      mergeMap((results) => {
        const newFails = results.filter((r) => !r.pass && !seenIds.has(r.id));
        for (const r of newFails) seenIds.add(r.id);
        return from(newFails);
      }),
    );
  }


  get isDonePromise() {
    return this.doneDeferred;
  }

  get failed() {
    return this.adapter.testResults$.value.some((r) => !r.pass);
  }

  async getDevtoolURL() {
    const endpoint = new URL(this.page.browser().wsEndpoint());
    const hostPort = endpoint.host;
    const client = this.page.target().createCDPSession();
    const { targetId } = (await (await client).send('Target.getTargetInfo')).targetInfo;
    return `http://${hostPort}/devtools/inspector.html?ws=${hostPort}/devtools/page/${targetId}`;
  }
}

type AggregateStats = { min: number; max: number; sum: number; count: number };

export class Executor {
  private progressBar: ProgressBar;
  private splits: ExecutorSplit[] = [];
  private previousStats: AggregateStats = { min: Infinity, max: -Infinity, sum: 0, count: 0 };
  private currentRunStats: AggregateStats = { min: Infinity, max: -Infinity, sum: 0, count: 0 };
  private lastProcessedCount = 0;

  constructor(
    private browser: Browser,
    private config: TestSuiteConfig,
    private metadata: TestSuiteMetadata,
  ) {
    this.progressBar = new ProgressBar();
    processExit$.pipe(filter(Boolean), take(1)).subscribe(() => this.progressBar.stop());
  }

  resetForRetry() {
    this.previousStats = { min: Infinity, max: -Infinity, sum: 0, count: 0 };
    this.currentRunStats = { min: Infinity, max: -Infinity, sum: 0, count: 0 };
    this.lastProcessedCount = 0;
    this.progressBar.reset();
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
    await oraPromise(() => Promise.all(splits.map((split) => split.initalize(this.browser))), {
      text: formatter.info(`Initializing ${result.length} split.s`),
    });
    return splits;
  }

  async *run() {
    this.splits = await this.splitTests();
    await this.progressBar.registerSplits(this.splits);
    for (let runs = 1; true; runs++) {
      this.currentRunStats = { min: Infinity, max: -Infinity, sum: 0, count: 0 };
      this.lastProcessedCount = 0;
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
      const lastFail$ = merge(...this.splits.map((s) =>
        s.lastFail$.pipe(map((r) => ({ ...r, splitId: s.id })))
      )).pipe(
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
        this.updateStatistics(totalRuns, r);
      });
      lastFail$.subscribe((r) => {
        const totalRuns = this.config.isSingleTest ? runs * this.splits.length : runs;
        const url = new this.config.adapterClass().getTestURL(this.config, r.id);
        const splitPrefix = this.splits.length > 1 ? `[S${r.splitId}] ` : "";
        const text = `${totalRuns}. ${splitPrefix}[${r.id}] ${r.name} - ${Math.round((r.duration ?? 0) * 100) / 100}s`;
        this.progressBar.log(formatter.warn(`]8;;${url}${text}]8;;`));
        if (!this.config.runForever && (this.config.failfast || this.config.isSingleTest)) {
          this.splits.forEach((s) => s.stop());
        }
      });
      if (!this.config.isSingleTest) {
        currentTest$.subscribe((t) => this.progressBar.updateTitle(t.name));
      }
      // 3. Run the test suite and wait for completion.
      await Promise.all(this.splits.map(async (s) => { await s.setup(); await s.start(); }));
      await isDonePromise;
      const success = this.splits.every((s) => !s.failed);
      if (!this.config.runForever) {
        await Promise.all(this.splits.filter((s) => s.failed).map((s) => s.setFailureFavicon()));
      }
      // 4. Let the runner process the result.
      yield { success };
      if (this.config.once) {
        return;
      }
      this.previousStats.min = Math.min(this.previousStats.min, this.currentRunStats.min);
      this.previousStats.max = Math.max(this.previousStats.max, this.currentRunStats.max);
      this.previousStats.sum += this.currentRunStats.sum;
      this.previousStats.count += this.currentRunStats.count;
      await Promise.all(this.splits.map((s) => s.reload()));
    }
  }

  stop() {
    this.progressBar.stop();
  }

  updateStatistics(runs: number, currentResults: TestResult[]) {
    const newResults = currentResults.slice(this.lastProcessedCount);
    this.lastProcessedCount = currentResults.length;
    for (const { duration } of newResults) {
      const d = duration ?? 0;
      if (d < this.currentRunStats.min) this.currentRunStats.min = d;
      if (d > this.currentRunStats.max) this.currentRunStats.max = d;
      this.currentRunStats.sum += d;
      this.currentRunStats.count++;
    }
    const totalMin = Math.min(this.previousStats.min, this.currentRunStats.min);
    const totalMax = Math.max(this.previousStats.max, this.currentRunStats.max);
    const totalSum = this.previousStats.sum + this.currentRunStats.sum;
    const totalCount = this.previousStats.count + this.currentRunStats.count;
    this.progressBar.updateStatistics({
      min: isFinite(totalMin) ? totalMin : 0,
      max: isFinite(totalMax) ? totalMax : 0,
      median: totalCount > 0 ? totalSum / totalCount : 0,
      runs,
      sum: this.currentRunStats.sum,
    });
  }
}
