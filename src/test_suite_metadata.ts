import chalk from "chalk";
import { oraPromise } from "ora";
import { Page } from "puppeteer";
import { IMetadata } from "./adapters/test_suite_adapter.js";
import { StopExecution } from "./errors.js";
import { TestSuiteConfig } from "./test_suite_config.js";

export class TestSuiteMetadata {
    // TODO rename testById
    testsById: IMetadata["testById"];
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
        this.testsById = data.testById;
        this.suiteById = data.suiteById;
        this.testsBySuiteId = data.testsBySuiteId;
    }

    get testNames() {
        this._testNames ??= Object.values(this.testsById).map(({ name }) => name);
        return this._testNames;
    }

    get suiteNames() {
        this._suiteNames ??= Object.values(this.suiteById).map((s) => s.name);
        return this._suiteNames;
    }

    get testIdByName() {
        this._testIdByName ??= Object.entries(this.testsById).reduce(
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
        this._testIds ??= this.config.testId
            ? [this.config.testId]
            : this.config.suiteIds
                  .map((suiteId) => this.testsBySuiteId[suiteId])
                  .flat()
                  .filter(
                      (t) => !t.tags || (t.tags.includes("desktop") && !t.tags.includes("skip")),
                  ) // TODO proper support of tags
                  .map((t) => t.id);
        return this._testIds;
    }

    static async fetch(page: Page, config: import("./test_suite_config.js").TestSuiteConfig) {
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
