const OSC = "\x1b]";
const BEL = "\x07";

export function osc8(url: string, label: string): string {
    return `${OSC}8;;${url}${BEL}${label}${OSC}8;;${BEL}`;
}

export interface LogLine {
    id: string;
    kind: "info" | "warn" | "error" | "step" | "blank" | "debug";
    text: string;
}

export interface WorkerDevtools {
    worker: number;
    url: string;
    failCount: number;
    started: boolean;
    errored: boolean;
}

export interface TestFailure {
    id: string;
    text: string;
    stack?: string;
    count: number;
}

export interface FlakyResult {
    passed: number;
    failed: number;
    total: number;
}

export interface UiState {
    currentStep: string | null;
    hasFailed: boolean;
    log: LogLine[];
    failures: TestFailure[];
    testTotal: number;
    testValue: number;
    runNumber: number;
    multiMode: boolean;
    elapsedSeconds: number;
    totalElapsedSeconds: number;
    currentTestTitle: string;
    running: boolean;
    awaitingQuitPrompt: boolean;
    devtools: WorkerDevtools[];
    flakyResult: FlakyResult | null;
}

export type UiAction =
    | { type: "test_fail"; worker?: number; text: string; stack?: string }
    | { type: "step_start"; label: string }
    | { type: "step_done"; label: string; ms: number }
    | { type: "log"; kind: LogLine["kind"]; text: string }
    | { type: "run_start"; run: number; total: number; multi: boolean }
    | { type: "worker_devtools"; worker: number; url: string }
    | { type: "worker_run"; worker: number }
    | { type: "worker_error"; worker: number }
    | { type: "test_started"; test: string }
    | { type: "run_done"; passed: number; failed: number; total: number; willRerun: boolean }
    | { type: "flaky_result"; passed: number; failed: number; total: number }
    | { type: "run_wait_prompt" }
    | { type: "tick_elapsed" }
    | { type: "interrupted" };

export const initialUiState: UiState = {
    currentStep: null,
    log: [],
    failures: [],
    testTotal: 0,
    testValue: 0,
    runNumber: 0,
    multiMode: false,
    elapsedSeconds: 0,
    totalElapsedSeconds: 0,
    hasFailed: false,
    currentTestTitle: "",
    running: false,
    awaitingQuitPrompt: false,
    devtools: [],
    flakyResult: null,
};

let nextLogId = 0;

function pushLog(state: UiState, kind: LogLine["kind"], text: string): UiState {
    const line: LogLine = { id: String(nextLogId++), kind, text };
    return { ...state, log: [...state.log, line] };
}

export function reduce(state: UiState, action: UiAction): UiState {
    switch (action.type) {
        case "step_start": {
            return { ...state, currentStep: action.label };
        }
        case "step_done": {
            const withDone = pushLog(state, "step", `${action.label} (${action.ms}ms)`);
            return { ...withDone, currentStep: null };
        }
        case "log": {
            return pushLog(state, action.kind, action.text);
        }
        case "run_start": {
            return {
                ...state,
                testTotal: action.total,
                testValue: 0,
                runNumber: action.run,
                multiMode: action.multi,
                elapsedSeconds: 0,
                running: true,
                failures: [],
                flakyResult: null,
                devtools: state.devtools.map((d) => ({ ...d, failCount: 0 })),
            };
        }
        case "worker_devtools": {
            return {
                ...state,
                devtools: [
                    ...state.devtools,
                    {
                        worker: action.worker,
                        url: action.url,
                        failCount: 0,
                        started: false,
                        errored: false,
                    },
                ],
            };
        }
        case "worker_run": {
            return {
                ...state,
                devtools: state.devtools.map((d) =>
                    d.worker === action.worker ? { ...d, started: true } : d,
                ),
            };
        }
        case "worker_error": {
            return {
                ...state,
                devtools: state.devtools.map((d) =>
                    d.worker === action.worker ? { ...d, errored: true } : d,
                ),
            };
        }
        case "test_started": {
            return {
                ...state,
                testValue: state.testValue + 1,
                currentTestTitle: action.test,
            };
        }
        case "run_done": {
            return {
                ...state,
                // In multi mode testValue is the cumulative repetition count, not
                // progress toward testTotal, so it must survive a failure as-is.
                testValue: state.multiMode ? state.testValue : state.testTotal,
                running: action.willRerun,
                elapsedSeconds: action.willRerun ? 0 : state.elapsedSeconds,
            };
        }
        case "flaky_result": {
            return {
                ...state,
                flakyResult: { passed: action.passed, failed: action.failed, total: action.total },
            };
        }
        case "run_wait_prompt": {
            return { ...state, awaitingQuitPrompt: true };
        }
        case "interrupted": {
            // The engine force-exits on SIGINT/SIGTERM without emitting run_done, so the UI
            // must gray itself out on the signal instead of waiting for a done event that
            // will never arrive.
            return { ...state, running: false, currentStep: null, awaitingQuitPrompt: false };
        }
        case "tick_elapsed": {
            return state.running
                ? {
                      ...state,
                      elapsedSeconds: state.elapsedSeconds + 1,
                      totalElapsedSeconds: state.totalElapsedSeconds + 1,
                  }
                : state;
        }
        case "test_fail": {
            // Retries (across workers, or repeated runs in multi mode) can report the exact
            // same failure more than once; collapse those into a single entry with a count
            // instead of repeating the same text/stack in the panel.
            const existing = state.failures.find(
                (f) => f.text === action.text && f.stack === action.stack,
            );
            const failures = existing
                ? state.failures.map((f) => (f === existing ? { ...f, count: f.count + 1 } : f))
                : [
                      ...state.failures,
                      { id: String(nextLogId++), text: action.text, stack: action.stack, count: 1 },
                  ];
            return {
                ...state,
                hasFailed: true,
                failures,
                devtools:
                    action.worker === undefined
                        ? state.devtools
                        : state.devtools.map((d) =>
                              d.worker === action.worker ? { ...d, failCount: d.failCount + 1 } : d,
                          ),
            };
        }
        default:
            return state;
    }
}
