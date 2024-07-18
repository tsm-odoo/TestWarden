import { TestSuiteConfig } from "@warden/test_suite_config";
import { TestSuiteMetadata } from "@warden/test_suite_metadata";
import { cleanup, launch, setupCache } from "@warden/browser";
import { TestSuiteRunner } from "@warden/runner/test_suite_runner";
import { StopExecution } from "@warden/errors";
import { formatter } from "@warden/helpers/terminal";
import { TestSuiteAdapter } from "@warden/adapters/test_suite_adapter";

import "@warden/adapters/hoot_adapter";
import "@warden/adapters/qunit_adapter";

import { BehaviorSubject } from "rxjs";
import { oraPromise } from "ora";
import { Browser, Page } from "puppeteer";

export const processExit$ = new BehaviorSubject(false);
function setupSignals() {
    const onSigInt = async () => {
        process.off("SIGINT", onSigInt);
        processExit$.next(true);
        await cleanup();
        await new Promise((res) => setTimeout(res));
        process.exit();
    };
    process.on("SIGINT", onSigInt);
}

(async function start() {
    try {
        setupSignals();

        // config = TestSuiteConifg.initialize(); => then parse options and return config
        const config = await TestSuiteConfig.parseCLIOptions();
        let browser: Browser, page: Page, metadata: TestSuiteMetadata;
        try {
            await oraPromise(
                async () => {
                    browser = await launch({ headless: true, dumpio: config.verbose });
                    [page] = await browser.pages();
                    await setupCache(page, config);
                    await page.setCookie(config.authCookie);
                    await Promise.all([page.bringToFront(), page.goto(config.baseSuiteURL)]);
                    await page.waitForResponse((response) => {
                        if (response.status() === 404) {
                            const url = new URL(config.baseSuiteURL);
                            throw new StopExecution(
                                `Suite not found: ${url.origin}${url.pathname}`,
                            );
                        }
                        return true;
                    });
                },
                {
                    text: formatter.info(`Launching chrome browser, suite: ${config.suite}`),
                    failText: (err) => formatter.error(err.message),
                },
            );
            const AdapterClass = await TestSuiteAdapter.getAdapter(page);
            config.adapterClass = AdapterClass;
            process.setMaxListeners(config.MAX_NUMBER_OF_WORKERS * 2 + 5);
            metadata = await TestSuiteMetadata.fetch(page, config);
        } finally {
            await browser?.close();
        }
        config.metadata = metadata;
        config.check();
        await new TestSuiteRunner(config, metadata).run();
    } catch (e) {
        if (e instanceof StopExecution) {
            return;
        }
        throw e;
    } finally {
        await cleanup();
    }
})();
