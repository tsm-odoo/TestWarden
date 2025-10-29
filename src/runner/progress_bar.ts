import { formatter } from "@warden/helpers/terminal";
import { ExecutorStatistics } from "@warden/runner/executor";

import cliProgress from "cli-progress";

export class ProgressBar {
  private manager: cliProgress.MultiBar;
  private titleBar: cliProgress.SingleBar;
  private mainBar: cliProgress.SingleBar;
  private statisticsBar: cliProgress.SingleBar;
  private stopped = false;

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
      this.manager.log("\n");
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
  }

  log(message: string) {
    this.manager.log(message + "\n");
  }

  get textColor() {
    return this.stopped ? "disabled" : "info";
  }

  get barColor() {
    return this.stopped ? "disabled" : "cyan";
  }
}
