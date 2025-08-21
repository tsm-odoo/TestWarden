import { IMetadata } from "@warden/adapters/test_suite_adapter";
import { StopExecution } from "@warden/errors";
import { TestSuiteConfig } from "@warden/test_suite_config";

import chalk from "chalk";
import { oraPromise } from "ora";
import { Page } from "puppeteer";

export class TestSuiteMetadata {
  testById: IMetadata["testById"];
  suiteById: IMetadata["suiteById"];
  testsBySuiteId: IMetadata["testsBySuiteId"];
  private _testNames: string[];
  private _suiteNames: string[];
  private _testIdByName: { [name: string]: string };
  private _suiteIdByName: { [name: string]: string };
  private _testIds: string[];

  constructor(
    private config: TestSuiteConfig,
    data: IMetadata,
  ) {
    this.testById = data.testById;
    this.suiteById = data.suiteById;
    this.testsBySuiteId = data.testsBySuiteId;
  }

  get testNames() {
    this._testNames ??= Object.values(this.testById).map(({ name }) => name);
    return this._testNames;
  }

  get suiteNames() {
    this._suiteNames ??= Object.values(this.suiteById).map((s) => s.name);
    return this._suiteNames;
  }

  get testIdByName() {
    this._testIdByName ??= Object.entries(this.testById).reduce(
      (acc, [key, value]) => ((acc[value.name] = key), acc),
      {},
    );
    return this._testIdByName;
  }

  get suiteIdByName() {
    this._suiteIdByName ??= Object.entries(this.suiteById).reduce(
      (acc, [key, value]) => ((acc[value.name] = key), acc),
      {},
    );
    return this._suiteIdByName;
  }

  get testIds() {
    return this.config.testId
      ? [this.config.testId]
      : this.config.suiteIds
          .map((suiteId) => this.testsBySuiteId[suiteId])
          .flat()
          .filter((t) => !t.tags?.length || (t.tags.includes("desktop") && !t.tags.includes("skip"))) // TODO proper support of tags
          .map((t) => t.id);
  }

  static async fetch(page: Page, config: import("@warden/test_suite_config").TestSuiteConfig) {
    try {
      const adapter = new config.adapterClass();
      return await oraPromise(
        async () => {
          return new TestSuiteMetadata(config, await page.evaluate(adapter.getMetadata));
        },
        {
          text: chalk.white("Fetching test suite metadata"),
          failText: (e) => chalk.red("Failed to fetch test suite metadata:", e.message),
        },
      );
    } catch (e) {
      throw new StopExecution();
    }
  }
}
