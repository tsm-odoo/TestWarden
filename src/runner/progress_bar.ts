import { formatter } from "@warden/helpers/terminal";
import { processExit$ } from "@warden/index.js";
import { ExecutorSplit, ExecutorStatistics } from "@warden/runner/executor";

import cliProgress from "cli-progress";
import { Subscription, filter, takeUntil } from "rxjs";

export class ProgressBar {
  private manager: cliProgress.MultiBar;
  private titleBar: cliProgress.SingleBar;
  private mainBar: cliProgress.SingleBar;
  private statisticsBar: cliProgress.SingleBar;
  private splitBars = new Map<string, cliProgress.SingleBar>();
  private splitHeader?: cliProgress.SingleBar;
  private splitFooter?: cliProgress.SingleBar;
  private splitToSubscribers = new Map<ExecutorSplit, Subscription>();
  private stopped = false;
  private alreadyLogged = false;

  constructor() {
    this.manager = new cliProgress.MultiBar(
      {
        hideCursor: true,
        formatTime(t) {
          return Number.isFinite(t) && Number.isInteger(t) ? t + "s" : t.toString();
        },
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
    this.stopped = false;
    if (!this.mainBar) {
      this.statisticsBar = this.manager.create(
        Infinity,
        0,
        {},
        {
          format: (options, params, payload) => {
            options.format = formatter[this.textColor](
              "[run.s: {runs} | t: {duration_formatted} | Σt: {sum} | min: {min} | med: {median} | max: {max}]",
            );
            return cliProgress.Format.Formatter(options, params, payload);
          },
        },
      );
      this.mainBar = this.manager.create(
        total,
        0,
        {},
        {
          format: (options, params, payload) => {
            options.format = formatter[this.barColor]("{bar} {value}/{total}");
            return cliProgress.Format.Formatter(options, params, payload);
          },
        },
      );
      this.titleBar = this.manager.create(
        Infinity,
        0,
        {},
        {
          format: (options, params, payload) => {
            options.format = formatter[this.textColor](payload.currentTestName ?? "");
            return cliProgress.Format.Formatter(options, params, payload);
          },
        },
      );
    } else {
      this.mainBar.start(total, 0);
      this.titleBar.start(Infinity, 0);
      this.statisticsBar.start(Infinity, 0);
      for (const [key, value] of this.splitToSubscribers) {
        value.unsubscribe();
        this.setupSplitSubscription(key);
      }
    }
  }

  update(newValue: number) {
    this.mainBar.update(newValue);
  }

  updateStatistics(statistics: ExecutorStatistics) {
    for (const key in statistics) {
      if (key === "runs") {
        continue;
      }
      statistics[key] = statistics[key].toFixed(2) + "s";
    }
    this.statisticsBar.update(0, statistics);
  }

  updateTitle(title: string) {
    this.titleBar.update(0, { currentTestName: title });
  }

  refresh() {
    this.manager.update();
  }

  stop() {
    if (this.stopped) {
      return;
    }
    this.refresh();
    this.stopped = true;
    this.titleBar.update(Infinity, { currentTestName: null });
    this.statisticsBar.update(Infinity);
    this.titleBar.stop();
    this.statisticsBar.stop();
    this.manager.stop();
    this.splitBars.forEach((bar) => bar.stop());
    this.splitHeader.stop();
    this.splitFooter.stop();
  }

  log(message: string) {
    if (!this.alreadyLogged) {
      this.manager.log("\n");
      this.alreadyLogged = true;
    }
    this.manager.log(message + "\n");
  }

  get textColor() {
    return this.stopped ? "disabled" : "info";
  }

  get barColor() {
    return this.stopped ? "disabled" : "cyan";
  }

  async registerSplits(splits: ExecutorSplit[]) {
    if (this.splitBars.size > 0) {
      return; // Already registered.
    }
    this.splitHeader = this.manager.create(
      Infinity,
      0,
      {},
      {
        format: () => "",
      },
    );
    this.splitHeader.update(0);
    for (const split of splits ) {
      const key = String(split.id);
      const url = await split.getDevtoolURL();
      const testCount = split.testIds.length;
      const bar = this.manager.create(
        1,
        0,
        {},
        {
          format: (options, params, payload) => {
            const text = `\u001B]8;;${payload.url}\u0007🛠️  ${payload.label}\u001B]8;;\u0007`;
            options.format = formatter[this.textColor](text);
            return cliProgress.Format.Formatter(options, params, payload);
          },
        },
      );
      bar.update(0, {
        label: `Inspect Split ${key} (${testCount} test.s)`,
        url,
      });
      this.splitBars.set(key, bar);
      await this.setupSplitSubscription(split);
    }
    this.splitFooter = this.manager.create(
      Infinity,
      0,
      {},
      {
        format: () => "",
      },
    );
    this.splitFooter.update(0);
  }

  private async setupSplitSubscription(split: ExecutorSplit) {
    const key = String(split.id);
    const url = await split.getDevtoolURL();
    const sub = split.failCount$
        .pipe(
          takeUntil(processExit$.pipe(filter(Boolean))),
        )
        .subscribe((failCount) => {
          let label = `Inspect Split ${split.id} (${split.testIds.length} test.s)`;
          if (failCount) {
            label = `Inspect Split ${split.id} (${split.testIds.length} test.s | ${failCount} failed)`;
          }
          this.splitBars.get(key).update(0, { label, url });
        });
      this.splitToSubscribers.set(split, sub);
  }
}
