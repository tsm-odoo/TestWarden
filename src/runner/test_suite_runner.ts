import { formatter, logger } from "@warden/helpers/terminal";
import { TestSuiteConfig } from "@warden/test_suite_config";
import { TestSuiteMetadata } from "@warden/test_suite_metadata";
import { Executor } from "@warden/runner/executor";

import chalk from "chalk";
import enquirer from "enquirer";
import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import { oraPromise } from "ora";
import { cleanup } from "@warden/browser.js";

export class TestSuiteRunner {
    constructor(
        private config: TestSuiteConfig,
        private metadata: TestSuiteMetadata,
    ) {}

    async run() {
        await this.cleanupFailFolder();
        if (!this.config.hasTarget) {
            const { testId, suiteName } = await this.promptSuiteOrTestId();
            this.config.testId = testId;
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
        const executor = new Executor(this.config, this.metadata);
        for await (const { success } of executor.run()) {
            if (!success && !this.config.runForever) {
                executor.stop();
                await executor.screenshotFails();
                await (enquirer as any).invisible({
                    message: formatter.info("Press any key to quit..."),
                });
                break;
            }
        }
        executor.stop();
    }

    private async cleanupFailFolder() {
        if (!fs.existsSync(this.config.failFolderPath)) {
            return;
        }
        const folders = fs
            .readdirSync(this.config.failFolderPath)
            .map((folder) => ({
                folder,
                birthtimeMs: fs.statSync(path.join(this.config.failFolderPath, folder)).birthtimeMs,
            }))
            .filter((f) => Date.now() - f.birthtimeMs > 24 * 60 * 60 * 1000);
        const toDelete = folders.map((f) => path.join(this.config.failFolderPath, f.folder));
        if (toDelete.length === 0) {
            return;
        }
        return oraPromise(
            async () => Promise.all(toDelete.map((f) => fsPromises.rm(f, { recursive: true }))),
            {
                text: formatter.info(`Cleaning up fail folder: ${this.config.failFolderPath}`),
                successText: formatter.info(`Cleaned up ${toDelete.length} old results`),
                failText: formatter.error("Failed to clean up fail folder"),
            },
        );
    }

    private async promptSuiteOrTestId(): Promise<{ testId?: string; suiteName?: string }> {
        // TODO - If there is no suite nor tests detected, display error
        // @ts-ignore
        const mode = await enquirer.select({
            name: "mode",
            message: chalk.white("What are you looking for?"),
            choices: ["Test", "Suite"],
        });
        // @ts-ignore
        const name = await enquirer.autocomplete({
            message: chalk.white(`Which ${mode.toLowerCase()} should I run?`),
            choices:
                mode === this.config.RUN_TYPE.TEST
                    ? this.metadata.testNames
                    : this.metadata.suiteNames,
            limit: 5,
        });
        return {
            testId:
                mode === this.config.RUN_TYPE.TEST ? this.metadata.testIdByName[name] : undefined,
            suiteName: mode === this.config.RUN_TYPE.SUITE ? name : undefined,
        };
    }
}
