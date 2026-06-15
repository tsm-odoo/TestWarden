import { formatter } from "@warden/helpers/terminal";
import { processExit$ } from "@warden/index.js";
import { ExecutorSplit, ExecutorStatistics } from "@warden/runner/executor";

import cliProgress from "cli-progress";
import { filter, takeUntil } from "rxjs";

const OSC = "]";
const BEL = "";

function oscLink(url: string, label: string) {
  return `${OSC}8;;${url}${BEL}🛠️ ${label}${OSC}8;;${BEL}`;
}

export class ProgressBar {
  private manager: cliProgress.MultiBar;
  private titleBar: cliProgress.SingleBar;
  private mainBar: cliProgress.SingleBar;
  private statisticsBar: cliProgress.SingleBar;
  private splitLinks: string[] = [];
  private stopped = false;
  private alreadyLogged = false;

  constructor() {
    this.manager = new cliProgress.MultiBar(
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
    if (this.splitLinks.length > 0) {
      return;
    }
    // OSC 8 hyperlinks cannot go through cli-progress format functions:
    // ansi-regex does not strip OSC sequences, so string-width miscounts
    // invisible URL bytes as visible chars, breaking multibar cursor math.
    // Writing directly to stdout places them above the managed bar area
    // which cli-progress never redraws.
    for (const split of splits) {
      const url = await split.getDevtoolURL();
      const index = this.splitLinks.length;
      const baseLabel = `Inspect Split ${split.id} (${split.testIds.length} test.s)`;
      this.splitLinks.push(oscLink(url, baseLabel));
      process.stdout.write(this.splitLinks[index] + "\n");
      split.failCount$
        .pipe(takeUntil(processExit$.pipe(filter(Boolean))))
        .subscribe((failCount) => {
          const label = failCount
            ? `Inspect Split ${split.id} (${split.testIds.length} test.s | ${failCount} failed)`
            : baseLabel;
          this.splitLinks[index] = oscLink(url, label);
        });
    }
  }
}
