import { IMetadata, Test, TestResult, TestSuiteAdapter, registerAdapter } from "@warden/adapters/test_suite_adapter";
import { processExit$ } from "@warden/index";
import { TestSuiteConfig } from "@warden/test_suite_config";

import { Page } from "puppeteer";
import { filter, first, firstValueFrom, takeUntil } from "rxjs";


export class QUnitAdapter extends TestSuiteAdapter {
  static name = "QUnit";

  static check(page: Page) {
    return page.evaluate(() => Boolean(window.QUnit));
  }

  getSuiteURL(config: TestSuiteConfig, testIds: string[]) {
    const queryParams = testIds.map((id) => `testId=${id}`);
    if (config.failfast) {
      queryParams.push("failfast=true");
    }
    return `${config.baseSuiteURL}&${queryParams.join("&")}`;
  }

  getTestURL(config: TestSuiteConfig, testId: string): string {
    return `${config.baseSuiteURL}&testId=${testId}&debugTest=True`;
  }

  async getMetadata() {
    type QUnitSuiteEntry = { name: string; weight: number | null };
    type QUnitTestEntry = { id: string; name: string };
    const result: {
      testById: Record<string, QUnitTestEntry>;
      suiteById: Record<string, QUnitSuiteEntry>;
      testsBySuiteId: Record<string, QUnitTestEntry[]>;
    } = {
      testById: {},
      suiteById: {},
      testsBySuiteId: {},
    };
    function getAllTests(suite: QUnitModule): QUnitTestEntry[] {
      const tests: QUnitTestEntry[] = [];
      result.suiteById[suite.moduleId] = { name: suite.name, weight: null };
      for (const test of suite.tests) {
        if (!test.skip) {
          result.testById[test.testId] = { id: test.testId, name: test.name };
          tests.push({ id: test.testId, name: test.name });
        }
      }
      for (const childModule of suite.childModules) {
        tests.push(...getAllTests(childModule));
      }
      return tests;
    }
    for (const suite of window.QUnit.config.modules) {
      const allTests = getAllTests(suite);
      const uniqueTests: Record<string, QUnitTestEntry> = {};
      allTests.forEach((t) => (uniqueTests[t.id] = t));
      result.testsBySuiteId[suite.moduleId] ??= [];
      result.testsBySuiteId[suite.moduleId] = [
        ...new Set(result.testsBySuiteId[suite.moduleId].concat(Object.values(uniqueTests))),
      ];
      if (result.testsBySuiteId[suite.moduleId].length > 0) {
        result.suiteById[suite.moduleId].weight = result.testsBySuiteId[suite.moduleId].length;
      } else {
        delete result.suiteById[suite.moduleId];
        delete result.testsBySuiteId[suite.moduleId];
      }
    }
    return result;
  }

  async run(page: Page) {
    page.evaluate(() => window.originalQUnitStart());
  }

  async abort(page: Page) {
    await page.waitForSelector("#qunit-abort-tests-button");
    await page.click("#qunit-abort-tests-button");
  }

  async accessSuite(page: Page, url: string) {
    const prom = super.accessSuite(page, url);
    page.once("framenavigated", () => {
      page.evaluate(() => {
        window.addEventListener(
          "DOMContentLoaded",
          () => {
            window.originalQUnitStart = window.QUnit.start;
            window.QUnit.start = () => {};
          },
          { capture: true, once: true },
        );
      });
    });
    return prom;
  }

  async reloadSuite(page: Page) {
    const prom = super.reloadSuite(page);
    page.once("framenavigated", () => {
      page.evaluate(() => {
        window.addEventListener(
          "DOMContentLoaded",
          () => {
            window.originalQUnitStart = window.QUnit.start;
            window.QUnit.start = () => {};
          },
          { capture: true, once: true },
        );
      });
    });
    return prom;
  }

  async setupProgressListener(page: Page) {
    // this could be part of the abstract class => the child just provide
    // 1. a way to listen to callback (beforeEach etc)
    // 2. a formatter for the test/results
    this.testResults$
      .pipe(
        takeUntil(processExit$.pipe(filter(Boolean))),
        takeUntil(this.done$.pipe(filter(Boolean))),
        filter((results) => results.length > 0 && results.at(-1)?.pass === false),
      )
      .subscribe((results) => this.lastFail$.next(results.at(-1) ?? null));
    const callbacksRegistered = await page.evaluate(() => "beforeEach" in window);
    if (!callbacksRegistered) {
      await page.exposeFunction("beforeEach", (test: Test) => this.currentTest$.next(test));
      await page.exposeFunction("afterEach", (result: TestResult) => {
        this.testResults$.next([...this.testResults$.value, result]);
      });
      await page.exposeFunction("afterAll", async () => {
        // TODO - use rxjs instead, smth like testResults$.pipe(take(1)).subscribe(() => ...)
        await new Promise((res) => setTimeout(res, 50));
        this.done$.next(true);
      });
    }
    await page.evaluate(() => {
      const { testStart, testDone, done } = window.QUnit;
      testStart((test) => {
        window.beforeEach({ id: test.testId, name: test.name });
      });
      testDone((test: QUnitTestCallback) => {
        window.afterEach({
          id: test.testId,
          name: test.name,
          pass: test.failed === 0,
          duration: test.runtime / 1000,
        });
      });
      done(() => window.afterAll());
    });
  }

  get isDonePromise() {
    return firstValueFrom(this.done$.pipe(first(Boolean)));
  }
}
registerAdapter(QUnitAdapter);
