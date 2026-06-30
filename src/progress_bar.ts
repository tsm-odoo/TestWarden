import cliProgress from "cli-progress";

const formatter = {
  info: (s: string) => `\x1b[37m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  error: (s: string) => `\x1b[31m${s}\x1b[0m`,
  success: (s: string) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
};

export class ProgressBar {
  private manager: cliProgress.MultiBar;
  private mainBar: cliProgress.SingleBar | null = null;
  private titleBar: cliProgress.SingleBar | null = null;
  private elapsedTicker: ReturnType<typeof setInterval> | null = null;
  private startMs = -1;
  private runNumber = 0;
  private alreadyLogged = false;
  private stepInProgress = false;
  private active = false;
  private stopped = false;

  constructor() {
    this.manager = this.createManager();
  }

  get isActive() {
    return this.active;
  }

  private createManager() {
    return new cliProgress.MultiBar(
      {
        hideCursor: true,
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

  start(total: number, runNumber: number) {
    this.runNumber = runNumber;
    this.alreadyLogged = false;
    this.active = true;
    this.stopped = false;

    if (!this.mainBar) {
      this.mainBar = this.manager.create(total, 0, { elapsed: "0s" }, {
        format: (opts: any, params: any, payload: any) => {
          const color = this.stopped ? formatter.gray : formatter.cyan;
          opts.format = color(`{bar} {value}/{total} [Run #${this.runNumber} | {elapsed}]`);
          return cliProgress.Format.Formatter(opts, params, payload);
        },
      });
      this.titleBar = this.manager.create(Infinity, 0, { name: "" }, {
        format: (_opts: any, _params: any, payload: any) => {
          const cols = (process.stdout.columns || 100) - 2;
          const text = String(payload.name || "").substring(0, cols);
          return this.stopped ? formatter.gray(text) : formatter.info(text);
        },
      });
    } else {
      this.mainBar.start(total, 0, { elapsed: "0s" });
      this.titleBar!.start(Infinity, 0, { name: "" });
    }

    if (!this.elapsedTicker) {
      this.elapsedTicker = setInterval(() => {
        if (this.startMs === -1) return;
        const s = Math.floor((Date.now() - this.startMs) / 1000);
        this.mainBar?.update({ elapsed: `${s}s` });
      }, 1000);
    }
  }

  update(value: number, runNumber?: number) {
    this.mainBar?.update(value);
    if (runNumber) {
      this.runNumber = runNumber;
    }
  }

  updateTitle(name: string) {
    this.titleBar?.update(0, { name });
  }

  startTimer() {
    if (this.startMs === -1) {
      this.startMs = Date.now();
    }
  }

  resetTimer() {
    this.startMs = -1;
    this.mainBar?.update(this.mainBar.getTotal());
    this.mainBar?.update({ elapsed: "0s" });
    this.mainBar?.render();
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.stopped = true;

    if (this.elapsedTicker) {
      clearInterval(this.elapsedTicker);
      this.elapsedTicker = null;
    }

    const finalElapsed = this.startMs !== -1
      ? `${Math.floor((Date.now() - this.startMs) / 1000)}s`
      : "0s";
    this.startMs = -1;

    this.mainBar?.update({ elapsed: finalElapsed });
    this.mainBar?.render();
    this.titleBar?.render();

    this.manager.stop();

    this.mainBar = null;
    this.titleBar = null;
    this.stopped = false;
    this.manager = this.createManager();
  }

  log(message: string) {
    if (this.active) {
      if (!this.alreadyLogged) {
        this.manager.log("\n");
        this.alreadyLogged = true;
      }
      this.manager.log(message + "\n");
    } else {
      if (this.stepInProgress) {
        process.stdout.write(`\r\x1b[2K`);
        this.stepInProgress = false;
      }
      process.stdout.write(message + "\n");
    }
  }

  logStepStart(label: string) {
    process.stdout.write(formatter.info(`ℹ ${label}...`));
    this.stepInProgress = true;
  }

  logStepDone(label: string, ms: number) {
    this.stepInProgress = false;
    process.stdout.write(`\r\x1b[2K${formatter.success("✔")} ${label} (${ms}ms)\n`);
  }
}
