import { test } from "node:test";
import assert from "node:assert/strict";
import { initialUiState, reduce, UiAction, UiState } from "./ui_state";

function run(...actions: UiAction[]): UiState {
    return actions.reduce(reduce, initialUiState);
}

test("run start resets progress and failures", () => {
    const state = run(
        { type: "run_start", run: 1, total: 10, multi: false },
        { type: "test_started", test: "a" },
        { type: "test_fail", text: "a failed" },
        { type: "run_start", run: 2, total: 12, multi: false },
    );
    assert.equal(state.runNumber, 2);
    assert.equal(state.testTotal, 12);
    assert.equal(state.testValue, 0);
    assert.equal(state.running, true);
    assert.deepEqual(state.failures, []);
    assert.equal(state.hasFailed, true);
});

test("run done fills the bar and stops unless rerunning", () => {
    const start: UiAction = { type: "run_start", run: 1, total: 10, multi: false };
    const started: UiAction = { type: "test_started", test: "a" };
    let state = run(start, started, {
        type: "run_done",
        passed: 10,
        failed: 0,
        total: 10,
        willRerun: false,
    });
    assert.equal(state.testValue, 10);
    assert.equal(state.running, false);
    state = run(
        start,
        started,
        { type: "tick_elapsed" },
        { type: "run_done", passed: 10, failed: 0, total: 10, willRerun: true },
    );
    assert.equal(state.running, true);
    assert.equal(state.elapsedSeconds, 0);
    assert.equal(state.totalElapsedSeconds, 1);
});

test("multi mode keeps the cumulative count on run done", () => {
    const state = run(
        { type: "run_start", run: 1, total: 100, multi: true },
        { type: "test_started", test: "a" },
        { type: "test_started", test: "a" },
        { type: "run_done", passed: 1, failed: 1, total: 2, willRerun: false },
    );
    assert.equal(state.testValue, 2);
});

test("identical failures are counted once per test", () => {
    const state = run(
        { type: "worker_devtools", worker: 1, url: "ws://1" },
        { type: "worker_devtools", worker: 2, url: "ws://2" },
        { type: "run_start", run: 1, total: 10, multi: false },
        { type: "test_fail", worker: 1, text: "a failed", stack: "s" },
        { type: "test_fail", worker: 2, text: "a failed", stack: "s" },
        { type: "test_fail", worker: 1, text: "b failed", stack: "s" },
    );
    assert.equal(state.hasFailed, true);
    assert.deepEqual(
        state.failures.map((f) => [f.text, f.count]),
        [
            ["a failed", 2],
            ["b failed", 1],
        ],
    );
    assert.deepEqual(
        state.devtools.map((d) => d.failCount),
        [2, 1],
    );
});

test("worker error marks only that worker", () => {
    const state = run(
        { type: "worker_devtools", worker: 1, url: "ws://1" },
        { type: "worker_devtools", worker: 2, url: "ws://2" },
        { type: "worker_run", worker: 1 },
        { type: "worker_error", worker: 2 },
    );
    assert.deepEqual(
        state.devtools.map((d) => [d.started, d.errored]),
        [
            [true, false],
            [false, true],
        ],
    );
});

test("flaky result is stored and cleared by the next run", () => {
    let state = run({ type: "flaky_result", passed: 97, failed: 3, total: 100 });
    assert.deepEqual(state.flakyResult, { passed: 97, failed: 3, total: 100 });
    state = reduce(state, { type: "run_start", run: 2, total: 1, multi: true });
    assert.equal(state.flakyResult, null);
});

test("interrupted stops the run", () => {
    const state = run(
        { type: "run_start", run: 1, total: 10, multi: false },
        { type: "step_start", label: "launch" },
        { type: "run_wait_prompt" },
        { type: "interrupted" },
    );
    assert.equal(state.running, false);
    assert.equal(state.currentStep, null);
    assert.equal(state.awaitingQuitPrompt, false);
    assert.equal(reduce(state, { type: "tick_elapsed" }), state);
});
