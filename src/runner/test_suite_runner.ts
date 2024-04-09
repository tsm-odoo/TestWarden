import { TestSuiteConfig } from "../test_suite_config.js";
import { TestSuiteMetadata } from "../test_suite_metadata.js";
import enquirer from "enquirer";
import chalk from "chalk";
import { Executor } from "./executor.js";
import { formatter, logger } from "../helpers/terminal.js";

export class TestSuiteRunner {
    constructor(
        private config: TestSuiteConfig,
        private metadata: TestSuiteMetadata,
    ) {}

    async run() {
        // TODO - clean outdated fails
        if (!this.config.hasTarget) {
            const { testId, suiteId } = await this.promptSuiteOrTestId();
            this.config.testId = testId;
            this.config.suiteIds = suiteId ? [suiteId] : this.config.suiteIds;
        }
        this.config.check();
        if (this.config.RUN_TYPE.SUITE === this.config.runType) {
            logger.info(
                "Hoot test suite started for suite.s:",
                this.config.suiteIds.map((id) => this.metadata.suiteById[id].name).join(", "),
            );
        } else {
            logger.info(
                `Hoot test suite started for test: [${this.config.testId}] ${
                    this.metadata.testsById[this.config.testId].name
                }`,
            );
        }
        const executor = new Executor(this.config, this.metadata);
        await executor.run();
    }

    private async promptSuiteOrTestId(): Promise<{ testId?: string; suiteId?: string }> {
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
        const targetId =
            mode === this.config.RUN_TYPE.TEST
                ? this.metadata.testIdByName[name]
                : this.metadata.suiteIdByName[name];
        return {
            testId: mode === this.config.RUN_TYPE.TEST ? targetId : undefined,
            suiteId: mode === this.config.RUN_TYPE.SUITE ? targetId : undefined,
        };
    }
}
