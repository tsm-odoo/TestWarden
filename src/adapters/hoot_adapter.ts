import { TestSuiteAdapter, registerAdapter } from "@warden/adapters/test_suite_adapter";
import { uuid } from "@warden/helpers/misc";
import { processExit$ } from "@warden/index";
import { TestSuiteConfig } from "@warden/test_suite_config";

import { Page } from "puppeteer";
import { filter, first, firstValueFrom, takeUntil } from "rxjs";

export class HootAdapter extends TestSuiteAdapter {
  static name = "Hoot";

  static check(page: Page) {
    return page.evaluate(() => Boolean(window.odoo.loader.modules.get("@web/../lib/hoot/hoot")));
  }

  FAIL_SELECTOR = ".HootTestResult:has(.bg-fail)";

  async run(page: Page) {
    await page.waitForSelector(">>> .HootButtons button[title='Run']");
    await page.click(">>> .HootButtons button[title='Run']");
  }

  async abort(page: Page) {
    await page.waitForSelector(">>> .HootButtons button[title*=Stop]");
    await page.click(">>> .HootButtons button[title*=Stop]");
  }

  getSuiteURL(config: TestSuiteConfig, testIds: string[]) {
    const queryParams = testIds.map((id) => `id=${id}`);
    queryParams.push("showdetail=failed");
    if (config.failfast) {
      queryParams.push("bail=1");
    }
    return `${config.baseSuiteURL}&${queryParams.join("&")}`;
  }

  getTestURL(config: any, testId: string): string {
    return `${config.baseSuiteURL}&id=${testId}&debugTest=true`.replace("manual=true", "manual=false");
  }

  async metadataReady() {
    return Boolean(window.odoo?.loader?.modules?.get("@web/../lib/hoot/hoot"))
  }

  async getMetadata() {
    function getAllTests(suite) {
      const allTests = [];
      for (const job of suite.jobs) {
        if (job.constructor.name !== "Suite") {
          allTests.push({
            id: job.id,
            name: job.name,
            tags: job.tags.map(({ id }) => id),
          });
          continue;
        }
        allTests.push(...getAllTests(job));
      }
      return [...new Set(allTests)];
    }

    const { odoo } = window;
    const testById = {};
    const suiteById = {};
    const testsBySuiteId = {};
    for (const { id: testId, fullName, tags } of odoo.loader.modules
      .get("@web/../lib/hoot/hoot")
      .__debug__().tests.values()) {
      testById[testId] = { name: fullName, tags: tags.map(({ id }) => id) };
    }
    for (const suite of odoo.loader.modules.get("@web/../lib/hoot/hoot").__debug__().suites.values()) {
      const { id, fullName, weight } = suite;
      suiteById[id] = { name: fullName, weight };
      testsBySuiteId[id] = getAllTests(suite);
    }
    return { testById, suiteById, testsBySuiteId };
  }

  async accessSuite(page: Page, url: string) {
    const prom = super.accessSuite(page, url);
    // Register the page functions as soon as possible: hoot will take a
    // snpashot of the initial window and clean every thing that was not in
    // it after each suite.
    page.once("framenavigated", async () => {
      const callbacksRegistered = await page.evaluate(() => "beforeEach" in window);
      if (!callbacksRegistered) {
        page.exposeFunction("updateNodeState", async (data: any) => {
          this.currentTest$.next(data.currentTest);
          this.testResults$.next([...this.testResults$.value, ...data.results]);
        });
        page.exposeFunction("afterAll", async () => {
          await new Promise((res) => setTimeout(res, 50));
          this.done$.next(true);
        });
      }
    });
    return prom;
  }

  async setupProgressListener(page: Page) {
    this.testResults$
      .pipe(
        takeUntil(processExit$.pipe(filter(Boolean))),
        takeUntil(this.done$.pipe(filter(Boolean))),
        filter((results) => results?.length > 0 && !results.at(-1).pass),
      )
      .subscribe((results) => this.lastFail$.next(results.at(-1)));
    await page.evaluate(() => {
      const runner = window.odoo.loader.modules.get("@web/../lib/hoot/hoot").__debug__();
      const throttleUpdateNodeState = (() => {
        let lastCurrentTest: any = null;
        let pendingResults: any[] = [];
        let lastFlush = 0;
        const THROTTLE_MS = 500;
        const flush = () => {
          if (lastCurrentTest || pendingResults.length) {
            window.updateNodeState({
              currentTest: lastCurrentTest,
              results: pendingResults
            });
          }
          lastCurrentTest = null;
          pendingResults = [];
          lastFlush = performance.now();
        };
        const throttled = (update: { currentTest?: any; result?: any }) => {
          if (update.currentTest) {
            lastCurrentTest = update.currentTest;
          };
          if (update.result) {
            pendingResults.push(update.result);
          };
          const now = performance.now();
          const timeSinceLastFlush = now - lastFlush;
          if (timeSinceLastFlush >= THROTTLE_MS) {
            flush();
          }
        };
        throttled.flush = flush;
        return throttled;
      })();
      runner.beforeEach(
        (test) => {
          throttleUpdateNodeState({ currentTest: { id: test.id, name: test.fullName } });
        },
        { global: true }
      );
      runner.afterPostTest(
        (test) => {
          throttleUpdateNodeState({
            result: {
              id: test.id,
              name: test.fullName,
              pass: test.results[0].pass,
              duration: (performance.now() - test.results[0].ts) / 1000,
            },
          });
          if (runner.config.debugTest) {
            window.afterAll();
            throttleUpdateNodeState.flush();
          }
        },
        { global: true }
      );
      runner.afterAll(() => {
        throttleUpdateNodeState.flush();
        window.afterAll();
      });
    });
  }

  async screenshotFails(page: Page, path: string) {
    let nextPageBtn;
    do {
      const fails = await page.$$(">>> .HootTestResult.bg-rose-900");
      // TODO - improve file name
      for (const fail of fails) {
        await fail.screenshot({
          path: `${path}/fail-${uuid()}.jpg`,
          optimizeForSpeed: true,
          quality: 25,
        });
      }
      nextPageBtn = await page.$(">>> button[title='Next page']:enabled");
      await nextPageBtn?.click();
    } while (nextPageBtn);
  }

  get isDonePromise() {
    return firstValueFrom(this.done$.pipe(first(Boolean)));
  }
}
registerAdapter(HootAdapter);
