import { StopExecution } from "@warden/errors";
import { formatter } from "@warden/helpers/terminal";
import { TestSuiteConfig } from "@warden/test_suite_config";

import { oraPromise } from "ora";
import { Page } from "puppeteer";
import { BehaviorSubject, first, firstValueFrom } from "rxjs";

export type IMetadata = {
  testById: { [id: string]: { name: string; tags: string[] } }; // TODO - deduce this from testBySuiteId
  suiteById: { [id: string]: { name: string; weight: number } };
  testsBySuiteId: { [id: string]: { id: string; name: string; tags: string[] } };
};

const adapters: (typeof TestSuiteAdapter)[] = [];
export function registerAdapter(cls: typeof TestSuiteAdapter) {
  adapters.push(cls);
}

export abstract class TestSuiteAdapter {
  static name: string;
  static check = async (page: Page) => false;
  static async getAdapter(page: Page): Promise<new () => TestSuiteAdapter> {
    return oraPromise(
      async () => {
        for (const adapter of adapters) {
          if (await adapter.check(page)) {
            return adapter as unknown as new () => TestSuiteAdapter;
          }
        }
        throw new StopExecution();
      },
      {
        text: formatter.info("Looking for test suite adapter"),
        failText: formatter.error("No adapter were found"),
        successText: (result) => formatter.info(`${result.name} adapter will be used`),
      },
    );
  }

  abstract getMetadata(): Promise<IMetadata>;
  abstract setupProgressListener(page: Page): Promise<void>;
  abstract run(page: Page): Promise<void>;
  abstract abort(page: Page): Promise<void>;
  abstract getSuiteURL(config: TestSuiteConfig, testIds: string[]): string;
  abstract getTestURL(config, testId: string): string;

  currentTest$ = new BehaviorSubject<Omit<Test, "pass">>(null);
  done$ = new BehaviorSubject<boolean>(false);
  lastFail$ = new BehaviorSubject<TestResult>(null);
  testResults$ = new BehaviorSubject<TestResult[]>([]);

  get success() {
    return this.done$.value && !this.lastFail$.value;
  }

  get isDonePromise() {
    return firstValueFrom(this.done$.pipe(first(Boolean)));
  }

  reset() {
    this.done$ = new BehaviorSubject<boolean>(false);
    this.lastFail$ = new BehaviorSubject<TestResult>(null);
    this.testResults$ = new BehaviorSubject<TestResult[]>([]);
  }

  /**
   * Go to the test suite. After this method, the current page should be the
   * one of the suite and the suite should not be started. This will allow to
   * register required listeners.
   */
  async accessSuite(page: Page, url: string) {
    return page.goto(url, { waitUntil: "networkidle0" });
  }

  /**
   * Reload the current test suite. After this method, the current page should
   * be the one of the suite and the suite should not be started. This will
   * allow to register required listeners.
   */
  async reloadSuite(page: Page) {
    return page.reload({ waitUntil: "domcontentloaded" });
  }

  async screenshotFails(page: Page, path: string) {}
  async metadataReady() {
    return true;
  }
}

export type TestResult = {
  id: string;
  name: string;
  pass: boolean;
  duration?: number;
};

export type Test = Omit<TestResult, "pass">;
