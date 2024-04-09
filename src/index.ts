import commandLineArgs from "command-line-args";
import { TestSuiteConfig } from "./test_suite_config.js";
import { TestSuiteMetadata } from "./test_suite_metadata.js";
import { authenticate } from "./helpers/network.js";
import { cleanup, launch, setupCache } from "./browser.js";
import { TestSuiteRunner } from "./runner/test_suite_runner.js";
import { StopExecution } from "./errors.js";
import { formatter, logger } from "./helpers/terminal.js";
import { TestSuiteAdapter } from "./adapters/test_suite_adapter.js";
// TODO - how to load files automatically?
import "./adapters/hoot_adapter.js";
import "./adapters/qunit_adapter.js";
import { BehaviorSubject } from "rxjs";
import { oraPromise } from "ora";
import { Browser, Page } from "puppeteer";

export const processExit$ = new BehaviorSubject(false);
function setupSignals() {
    const onSigInt = async () => {
        process.off("SIGINT", onSigInt);
        processExit$.next(true);
        await new Promise((res) => setTimeout(res));
        process.exit();
    };
    process.on("SIGINT", onSigInt);
}

(async function start() {
    try {
        setupSignals();
        // TODO - --disable-cache to allow modifying code in place
        const optionsDefinition = [
            { name: "debug", type: Boolean },
            { name: "test-id", alias: "t", type: String },
            { name: "workers", type: Number },
            { name: "tests-per-worker", type: Number },
            { name: "suite-names", alias: "m", multiple: true },
            { name: "suite", type: String, defaultValue: "/web/tests/next" },
            { name: "server-url", type: String, defaultValue: "http://localhost:8069" },
            { name: "visible", type: Boolean, defaultValue: false },
            { name: "fail-fast", type: Boolean, defaultValue: false },
            { name: "only-last-stats", type: Boolean, defaultValue: false }, // TODO - NOT YET IMPLEMENTEED
            { name: "mobile", type: Boolean, defaultValue: false }, // TODO - NOT YET IMPLEMENTED
            { name: "prompt-for-retry", type: Boolean, defaultValue: false }, // TODO - NOT YET IMPLEMENTED
            { name: "open-fail-folder", type: Boolean, defaultValue: false }, // TODO - NOT YET IMPLEMENTED
        ];
        const rawOptions = commandLineArgs(optionsDefinition);
        const authCookie = await authenticate(rawOptions["server-url"], "admin", "admin");
        // config = TestSuiteConifg.initialize(); => then parse options and return config
        const config = new TestSuiteConfig(rawOptions, authCookie);
        let browser: Browser, page: Page, metadata: TestSuiteMetadata;
        try {
            await oraPromise(
                async () => {
                    browser = await launch({ headless: false });
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
                    text: formatter.info("Launching chrome browser"),
                    failText: (err) => formatter.error(err instanceof StopExecution ? err.message : "Could not start chrome browser"),
                },
            );
            const AdapterClass = await TestSuiteAdapter.getAdapter(page);
            config.adapterClass = AdapterClass;
            process.setMaxListeners(config.MAX_NUMBER_OF_WORKERS * 2 + 5);
            metadata = await TestSuiteMetadata.fetch(page, config);
        } finally {
            await browser.close();
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
