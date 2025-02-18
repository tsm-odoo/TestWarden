import { TestSuiteAdapter } from "@warden/adapters/test_suite_adapter";
import { cleanup, launch, setupCache } from "@warden/browser";
import { StopExecution } from "@warden/errors";
import { formatter, logger } from "@warden/helpers/terminal";
import { TestSuiteRunner } from "@warden/runner/test_suite_runner";
import { TestSuiteConfig } from "@warden/test_suite_config";
import { TestSuiteMetadata } from "@warden/test_suite_metadata";
import { config as rxjsConfig } from "rxjs";
import os from "os";
import "@warden/adapters/hoot_adapter";
import "@warden/adapters/qunit_adapter";

import { oraPromise } from "ora";
import { Browser, Page } from "puppeteer";
import { BehaviorSubject } from "rxjs";
import nc from "nodeaffinity";

export const ABORT_CONTROLLER = new AbortController();
export const processExit$ = new BehaviorSubject(false);
let isCleaningUp = false;
async function doCleanup() {
    if (isCleaningUp) {
        return;
    }
    isCleaningUp = true;
    processExit$.next(true);
    await cleanup();
    process.exit(0);
}
const signals = ["SIGINT", "SIGTERM", "SIGHUP", "beforeExit"];
signals.forEach((signal) => process.on(signal, doCleanup));

(async function start() {
    try {
        // config = TestSuiteConifg.initialize(); => then parse options and return config
        const config = await TestSuiteConfig.parseCLIOptions();
        let browser: Browser, page: Page, metadata: TestSuiteMetadata;
        rxjsConfig.onUnhandledError = (err) => {
            if (err instanceof StopExecution || isCleaningUp) {
                return;
            }
            throw err;
        };
        await oraPromise(
            async () => {
                browser = await launch({ headless: true, dumpio: config.verbose });
                [page] = await browser.pages();
                await setupCache(page, config);
                await page.setCookie(config.authCookie);
                await page.goto(config.baseSuiteURL);
                await page.waitForResponse((response) => {
                    if (response.status() === 404) {
                        const url = new URL(config.baseSuiteURL);
                        throw new StopExecution(`Suite not found: ${url.origin}${url.pathname}`);
                    }
                    return true;
                });
            },
            {
                text: formatter.info(`Launching chrome browser, suite: ${config.suite}`),
                successText: () =>
                    formatter.info(
                        `Chrome browser started on ${new URL(browser.wsEndpoint()).port}, suite: ${
                            config.suite
                        }`,
                    ),
                failText: (err) => formatter.error(err.message),
            },
        );
        const AdapterClass = await TestSuiteAdapter.getAdapter(page);
        config.adapterClass = AdapterClass;
        process.setMaxListeners(config.MAX_NUMBER_OF_WORKERS * 2 + 5);
        metadata = await TestSuiteMetadata.fetch(page, config);
        await browser.close();
        config.metadata = metadata;
        config.check();
        let mask = (1 << config.cpuLimit) - 1;
        nc.setAffinity(mask);
        const totalCPUs = os.cpus().length;
        logger.info(`CPU usage restricted to ${config.cpuLimit} core.s out of ${totalCPUs}`);
        await new TestSuiteRunner(config, metadata).run();
    } catch (e) {
        if (!(e instanceof StopExecution) && !isCleaningUp) {
            throw e;
        }
    }
    doCleanup();
})();
