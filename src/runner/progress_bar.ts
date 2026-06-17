import { formatter } from "@warden/helpers/terminal";
import { ExecutorSplit, ExecutorStatistics } from "@warden/runner/executor";

import cliProgress from "cli-progress";

export class ProgressBar {
  private manager: cliProgress.MultiBar;
  private titleBar: cliProgress.SingleBar | null = null;
  private mainBar: cliProgress.SingleBar | null = null;
  private statisticsBar: cliProgress.SingleBar | null = null;
  private stopped = false;
  private alreadyLogged = false;

  private createManager() {
    return new cliProgress.MultiBar(
      {
        hideCursor: true,
        formatTime(t) {
          return Number.isFinite(t) && Number.isInteger(t) ? t + "s" : t.toString();
        },
        barCompleteChar: "█",
        barIncompleteChar: "░",
        stopOnComplete: true,
        forceRedraw: true,
        barsize: 80,
        linewrap: false,
      },
      cliProgress.Presets.shades_classic,
    );
  }

  constructor() {
    this.manager = this.createManager();
  }

  reset() {
    this.manager = this.createManager();
    this.mainBar = null;
    this.titleBar = null;
    this.statisticsBar = null;
    this.stopped = false;
    this.alreadyLogged = false;
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
      this.mainBar!.start(total, 0);
      this.titleBar!.start(Infinity, 0);
      this.statisticsBar!.start(Infinity, 0);
    }
  }

  update(newValue: number) {
    this.mainBar!.update(newValue);
  }

  updateStatistics(statistics: ExecutorStatistics) {
    const display: Record<string, string | number> = { runs: statistics.runs };
    for (const key of (Object.keys(statistics) as (keyof ExecutorStatistics)[])) {
      if (key === "runs") continue;
      display[key] = statistics[key].toFixed(2) + "s";
    }
    this.statisticsBar!.update(0, display);
  }

  updateTitle(title: string) {
    this.titleBar!.update(0, { currentTestName: title });
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
    this.titleBar!.update(Infinity, { currentTestName: null });
    this.statisticsBar!.update(Infinity);
    this.titleBar!.stop();
    this.statisticsBar!.stop();
    this.manager.stop();
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
    const urls = await Promise.all(splits.map((s) => s.getDevtoolURL()));
    for (const [i, split] of splits.entries()) {
      const label = `\u{1F6E0}\uFE0F Inspect Split ${split.id} (${split.testIds.length} test.s)`;
      this.log(formatter.info(`\u001B]8;;${urls[i]}\u0007${label}\u001B]8;;\u0007`));
    }
    this.manager.log("\n");
  }
}
