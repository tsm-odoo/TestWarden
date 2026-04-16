
import "@warden/adapters/hoot_adapter";
import "@warden/adapters/qunit_adapter";
import os from "os";
import { BehaviorSubject, config as rxjsConfig } from "rxjs";
import { createRequire } from "module";
import { oraPromise } from "ora";
import { Browser, Page } from "puppeteer";

import { StopExecution } from "@warden/errors";
import { TestSuiteAdapter } from "@warden/adapters/test_suite_adapter";
import { TestSuiteConfig } from "@warden/test_suite_config";
import { TestSuiteMetadata } from "@warden/test_suite_metadata";
import { TestSuiteRunner } from "@warden/runner/test_suite_runner";
import { cleanup, launch, setupCache } from "@warden/browser";
import { formatter, logger } from "@warden/helpers/terminal";

const require = createRequire(import.meta.url);
let nc;
try {
  const mod = require("nodeaffinity");
  nc = mod.default || mod;
} catch (err) {
  logger.warn("Missing package: 'nodeaffinity'. `cpuLimit` option will be ignored.");
  nc = null;
}

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
  process.exit(130);
}
const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
signals.forEach((signal) => process.on(signal, doCleanup));
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled Promise Rejection");
  logger.error(reason instanceof Error ? reason.stack : JSON.stringify(reason, null, 2));
  process.exit(1);
});

(async function start() {
  try {
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
        browser = await launch({ headless: config.headless, dumpio: config.verbose });
        [page] = await browser.pages();
        await setupCache(page, config, true);
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
          formatter.info(`Chrome browser started on ${new URL(browser.wsEndpoint()).port}, suite: ${config.suite}`),
        failText: (err) => formatter.error(err.message),
      },
    );
    const AdapterClass = await TestSuiteAdapter.getAdapter(page);
    config.adapterClass = AdapterClass;
    process.setMaxListeners(config.MAX_NUMBER_OF_WORKERS * 2 + 5);
    metadata = await TestSuiteMetadata.fetch(page, config);
    config.metadata = metadata;
    config.check();
    if (nc) {
      let mask = (1 << config.cpuLimit) - 1;
      nc.setAffinity(mask);
      const totalCPUs = os.cpus().length;
      logger.info(`CPU usage restricted to ${config.cpuLimit} core.s out of ${totalCPUs}`);
    }
    await new TestSuiteRunner(config, metadata).run(browser);
  } catch (e) {
    if (!(e instanceof StopExecution) && !isCleaningUp) {
      throw e;
    }
  } finally {
    await cleanup();
  }
})();
