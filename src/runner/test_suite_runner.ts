import { formatter, logger } from "@warden/helpers/terminal";
import { TestSuiteConfig } from "@warden/test_suite_config";
import { TestSuiteMetadata } from "@warden/test_suite_metadata";
import { Executor } from "@warden/runner/executor";
import { clearCache } from "@warden/browser";

import enquirer from "enquirer";
import { Browser } from "puppeteer";

export class TestSuiteRunner {
  constructor(
    private config: TestSuiteConfig,
    private metadata: TestSuiteMetadata,
  ) {}

  async run(browser: Browser) {
    if (!this.config.hasTarget) {
      const { testId, suiteName } = await this.promptSuiteOrTestId();
      this.config.test = testId;
      this.config.suiteNames = suiteName ? [suiteName] : this.config.suiteNames;
    }
    this.config.check();
    if (this.config.testId) {
      logger.info(
        `${this.config.adapterClass.name} test suite started for test: [${
          this.config.testId
        }] ${this.metadata.testById[this.config.testId].name}`,
      );
    } else {
      logger.info(
        `${this.config.adapterClass.name} test suite started for suite.s:`,
        this.config.suiteIds.map((id) => this.metadata.suiteById[id].name).join(", "),
      );
    }
    const executor = new Executor(browser, this.config, this.metadata);
    for await (const { success } of executor.run()) {
      if (!success && !this.config.runForever) {
        executor.stop();
        const retry = await this.promptRetryOrQuit();
        if (retry) {
          await clearCache();
          executor.resetForRetry();
          continue;
        }
        break;
      }
    }
    executor.stop();
  }

  private async promptRetryOrQuit(): Promise<boolean> {
    // @ts-ignore
    return enquirer.confirm({
      message: formatter.info("Retry?"),
      initial: false,
      format: () => "",
    });
  }

  private async promptSuiteOrTestId(): Promise<{ testId?: string; suiteName?: string }> {
    // TODO - If there is no suite nor tests detected, display error
    // @ts-ignore
    const mode = await enquirer.select({
      name: "mode",
      message: formatter.info("What are you looking for?"),
      choices: ["Test", "Suite"],
    });
    // @ts-ignore
    const name = await enquirer.autocomplete({
      message: formatter.info(`Which ${mode.toLowerCase()} should I run?`),
      choices: mode === this.config.RUN_TYPE.TEST ? this.metadata.testNames : this.metadata.suiteNames,
      limit: 5,
    });
    return {
      testId: mode === this.config.RUN_TYPE.TEST ? this.metadata.testIdByName[name] : undefined,
      suiteName: mode === this.config.RUN_TYPE.SUITE ? name : undefined,
    };
  }
}
