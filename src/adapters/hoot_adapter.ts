import { Page } from "puppeteer";
import { BehaviorSubject, filter, first, firstValueFrom, takeUntil } from "rxjs";
import {
    Test,
    TestResult,
    TestSuiteAdapter,
    registerAdapter,
} from "../adapters/test_suite_adapter.js";
import { processExit$ } from "../index.js";
import { TestSuiteConfig } from "../test_suite_config.js";

export class HootAdapter extends TestSuiteAdapter {
    static check(page: Page) {
        return page.evaluate(() =>
            Boolean(window.odoo.loader.modules.get("@web/../lib/hoot/hoot")),
        );
    }

    currentTest$ = new BehaviorSubject<Omit<Test, "pass">>(null);
    done$ = new BehaviorSubject<boolean>(false);
    lastFail$ = new BehaviorSubject<TestResult>(null);
    testResults$ = new BehaviorSubject<TestResult[]>([]);

    async run(page: Page) {
        await page.waitForSelector(">>> .HootButtons button[title='Run']");
        await page.click(">>> .HootButtons button[title='Run']");
    }

    async abort(page: Page) {
        await page.waitForSelector(">>> .HootButtons button[title*=Stop]");
        await page.click(">>> .HootButtons button[title*=Stop]");
    }

    getSuiteURL(config: TestSuiteConfig, testIds: string[]) {
        const queryParams = testIds.map((id) => `test=${id}`);
        if (config.failfast) {
            queryParams.push("bail=1");
        }
        return `${config.baseSuiteURL}&${queryParams.join("&")}`;
    }

    async getMetadata() {
        // TODO - odoo.loader.modules.get("@web/../lib/hoot/hoot").__debug__
        // if debug is set, and the config is not set to this single test
        // we should abort everything
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
        for (const { id: testId, fullName } of odoo.loader.modules
            .get("@web/../lib/hoot/hoot")
            .__debug__.tests.values()) {
            testById[testId] = { name: fullName };
        }
        for (const suite of odoo.loader.modules
            .get("@web/../lib/hoot/hoot")
            .__debug__.suites.values()) {
            const { id, fullName, weight } = suite;
            suiteById[id] = { name: fullName, weight };
            testsBySuiteId[id] = getAllTests(suite);
        }
        return { testById, suiteById, testsBySuiteId };
    }

    async setupProgressListener(page: Page) {
        // NOTE - CPU USAGE investigation, removing those lines does not reduce
        // cpu usage, 10-15% per browser in any case.
        this.testResults$
            .pipe(
                takeUntil(processExit$.pipe(filter(Boolean))),
                takeUntil(this.done$.pipe(filter(Boolean))),
                filter((results) => results?.length > 0 && !results.at(-1).pass),
            )
            .subscribe((results) => this.lastFail$.next(results.at(-1)));
        const callbacksRegistered = await page.evaluate(() => "beforeEach" in window);
        if (!callbacksRegistered) {
            page.exposeFunction("beforeEach", (test: Test) => this.currentTest$.next(test));
            page.exposeFunction("afterEach", (result: TestResult) => {
                this.testResults$.next([...this.testResults$.value, result]);
            });
            page.exposeFunction("afterAll", async () => {
                // TODO - use rxjs instead, smth like testResults$.pipe(take(1)).subscribe(() => ...)
                await new Promise((res) => setTimeout(res, 50));
                this.done$.next(true);
            });
        }
        await page.evaluate(() => {
            const { beforeEach, afterEach, afterAll } =
                window.odoo.loader.modules.get("@web/../lib/hoot/hoot");
            beforeEach((test) => {
                window.beforeEach({ id: test.id, name: test.fullName });
            });
            afterEach((test) => {
                window.afterEach({
                    id: test.id,
                    name: test.fullName,
                    pass: test.results[0].pass && test.results[0].errors.length === 0,
                    duration: (performance.now() - test.results[0].ts) / 1000,
                });
            });
            afterAll(() => window.afterAll());
        });
    }

    get isDonePromise() {
        return firstValueFrom(this.done$.pipe(first(Boolean)));
    }
}
registerAdapter(HootAdapter);
