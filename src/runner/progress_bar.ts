import chalk from "chalk";
import cliProgress from "cli-progress";
import { ExecutorStatistics } from "./executor.js";

enum BarSentinel {
    TITLE = Infinity,
}

export class ProgressBar {
    private manager: cliProgress.MultiBar;
    private titleBar: cliProgress.SingleBar;
    private mainBar: cliProgress.SingleBar;
    private currentValue = 0;
    private stopped = false;
    private statisticDelimiter = "‎";
    private lastStatistics: string;

    constructor() {
        this.manager = new cliProgress.MultiBar(
            {
                format: (options, params, payload) => {
                    if (params.total === BarSentinel.TITLE) {
                        options.format = chalk[this.textColor](payload.currentTestName ?? "");
                    } else {
                        options.format = chalk[this.barColor]("{bar} {value}/{total}");
                        options.format += ` ${this.statisticDelimiter}[run.s: {runs} | t: {duration_formatted} | Σt: {sum} | min: {min} | med: {median} | max: {max}]`;
                    }
                    const format = cliProgress.Format.Formatter(options, params, payload);
                    if (params.total !== BarSentinel.TITLE) {
                        this.lastStatistics = format.split(this.statisticDelimiter)[1];
                    }
                    return format;
                },
                hideCursor: true,
                formatTime(t) {
                    return Number.isFinite(t) && Number.isInteger(t) ? t + "s" : t.toString();
                },
                linewrap: true,
                barCompleteChar: "\u2588",
                barIncompleteChar: "\u2591",
                stopOnComplete: true,
                forceRedraw: true,
                barsize: 80,
            },
            cliProgress.Presets.shades_classic,
        );
    }

    start(total: number) {
        this.currentValue = 0;
        if (!this.mainBar) {
            this.manager.log("\n");
            this.mainBar = this.manager.create(total, 0);
            this.titleBar = this.manager.create(BarSentinel.TITLE, 0);
        } else {
            this.mainBar.start(total, 0);
            this.titleBar.start(BarSentinel.TITLE, 0);
        }
    }

    update(
        newValue: number,
        options: { currentTestName?: string; runs?: number; statistics?: ExecutorStatistics } = {},
    ) {
        this.currentValue = newValue;
        const mainBarOptions = Object.entries(options.statistics ?? {}).reduce((o, [k, v]) => {
            o[k] = v.toFixed(2) + "s";
            return o;
        }, {});
        if (options.runs) {
            mainBarOptions["runs"] = options.runs;
        }
        this.mainBar.update(newValue, mainBarOptions);
        if (options.currentTestName) {
            this.titleBar.update(this.mainBar.getTotal() === newValue ? BarSentinel.TITLE : 0, {
                currentTestName: options.currentTestName,
            });
        }
    }

    refresh() {
        this.manager.update();
    }

    stop() {
        this.stopped = true;
        this.titleBar.update(BarSentinel.TITLE, { currentTestName: null });
        this.titleBar.stop();
        this.manager.stop();
    }

    log(message: string) {
        this.manager.log(message + "\n");
    }

    logStatistics() {
        this.log(this.lastStatistics);
    }

    get value() {
        return this.currentValue;
    }

    private get barColor() {
        return this.stopped ? "gray" : "cyan";
    }

    private get textColor() {
        return this.stopped ? "gray" : "white";
    }
}
