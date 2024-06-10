import chalk from "chalk";
import { oraPromise } from "ora";
import { Page } from "puppeteer";
import { BehaviorSubject, first, firstValueFrom } from "rxjs";
import { StopExecution } from "../errors.js";
import { TestSuiteConfig } from "../test_suite_config.js";

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
                text: chalk.white("Looking for test suite adapter"),
                failText: chalk.red("No adapter were found"),
                successText: (result) => chalk.white(`${result.name} adapter will be used`),
            },
        );
    }

    abstract getMetadata(): Promise<IMetadata>;
    abstract setupProgressListener(page: Page): Promise<void>;
    abstract run(page: Page): Promise<void>;
    abstract abort(page: Page): Promise<void>;
    abstract getSuiteURL(config: TestSuiteConfig, testIds: string[]): string;

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
        return page.goto(url);
    }

    /**
     * Reload the current test suite. After this method, the current page should
     * be the one of the suite and the suite should not be started. This will
     * allow to register required listeners.
     */
    async reloadSuite(page: Page) {
        return page.reload({
            waitUntil: "load",
        });
    }
}

export type TestResult = {
    id: string;
    name: string;
    pass: boolean;
    duration?: number;
};

export type Test = Omit<TestResult, "pass">;
