import { EventEmitter } from "events";
import { render, Box, Static, Text, useInput } from "ink";
import { useEffect, useReducer, useState } from "react";

import {
    LogLine,
    TestFailure,
    UiAction,
    UiState,
    WorkerDevtools,
    initialUiState,
    osc8,
    reduce,
} from "@warden/ui_state";

const BAR_WIDTH = 80;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

function renderBar(value: number, total: number): string {
    const ratio = total > 0 ? Math.min(1, value / total) : 0;
    const filled = Math.round(ratio * BAR_WIDTH);
    return "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
}

function pad2(value: number): string {
    return String(value).padStart(2, "0");
}

function formatDuration(totalSeconds: number): string {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
        return `${hours}h${pad2(minutes)}m${pad2(seconds)}s`;
    }
    if (minutes > 0) {
        return `${minutes}m${pad2(seconds)}s`;
    }
    return `${seconds}s`;
}

function useSpinnerFrame(active: boolean): string {
    const [frame, setFrame] = useState(0);
    useEffect(() => {
        if (!active) {
            return;
        }
        const timer = setInterval(
            () => setFrame((f) => (f + 1) % SPINNER_FRAMES.length),
            SPINNER_INTERVAL_MS,
        );
        return () => clearInterval(timer);
    }, [active]);
    return SPINNER_FRAMES[frame];
}

// Matches the log package's dynMarker (\x1e) wrapping a per-run value (a name, path, or
// count) so it can be rendered highlighted instead of blending into the static text
// around it.
const DYN_MARKER = "\x1e";

function highlight(text: string) {
    const parts = text.split(DYN_MARKER);
    if (parts.length === 1) {
        return text;
    }
    return parts.map((part, i) =>
        i % 2 === 1 ? (
            <Text key={i} color="cyan">
                {part}
            </Text>
        ) : (
            part
        ),
    );
}

function LogLineView({ line }: { line: LogLine }) {
    switch (line.kind) {
        case "step":
            return (
                <Text>
                    <Text color="green">✔ </Text>
                    <Text>{highlight(line.text)}</Text>
                </Text>
            );
        case "warn":
            return <Text color="yellow">{line.text}</Text>;
        case "error":
            return <Text color="red">{line.text}</Text>;
        case "blank":
            return <Text> </Text>;
        default:
            return <Text>{highlight(line.text)}</Text>;
    }
}

function indent(text: string): string {
    return text
        .split("\n")
        .map((line) => `    ${line}`)
        .join("\n");
}

function WorkerRow({ d }: { d: WorkerDevtools }) {
    const spinnerFrame = useSpinnerFrame(!d.started && !d.errored);
    const icon = d.errored ? (
        <Text color="red">✖</Text>
    ) : d.started ? (
        <Text color="green">✔</Text>
    ) : (
        spinnerFrame
    );
    return (
        <Text>
            {icon} Worker {d.worker} {osc8(d.url, "devtools")}
            {d.failCount > 0 ? ` [${d.failCount} Failed]` : ""}
        </Text>
    );
}

function DevtoolsPanel({ devtools }: { devtools: WorkerDevtools[] }) {
    if (!devtools.length) {
        return null;
    }
    return (
        <Box flexDirection="column" marginY={1}>
            {[...devtools]
                .sort((left, right) => left.worker - right.worker)
                .map((d) => (
                    <WorkerRow key={d.worker} d={d} />
                ))}
        </Box>
    );
}

function FailuresPanel({ failures }: { failures: TestFailure[] }) {
    if (!failures.length) {
        return null;
    }
    return (
        <Box flexDirection="column" marginBottom={1}>
            {failures.map((failure) => (
                <Box key={failure.id} flexDirection="column">
                    <Text color="yellow">
                        {failure.text}
                        {failure.count > 1 ? ` (x${failure.count})` : ""}
                    </Text>
                    {failure.stack ? <Text dimColor>{indent(failure.stack)}</Text> : null}
                </Box>
            ))}
        </Box>
    );
}

function StatusBar({ state }: { state: UiState }) {
    const title = state.currentTestTitle;
    const spinnerFrame = useSpinnerFrame(state.currentStep !== null);

    const testValue = String(state.testValue).padStart(3, " ");
    return (
        <Box flexDirection="column">
            {state.currentStep ? (
                <Text>
                    {spinnerFrame} {state.currentStep}
                </Text>
            ) : null}
            <Box marginTop={state.hasFailed ? 1 : 0} flexDirection="column">
                <Text color={state.running ? "cyan" : "gray"} dimColor={!state.running}>
                    {state.multiMode ? (
                        <>
                            [Run #{state.testValue} | ⧗ {formatDuration(state.elapsedSeconds)}]
                        </>
                    ) : (
                        <>
                            {renderBar(state.testValue, state.testTotal)} {testValue}/
                            {state.testTotal} [Run #{state.runNumber} | ⧗{" "}
                            {formatDuration(state.elapsedSeconds)} | Σ⧗{" "}
                            {formatDuration(state.totalElapsedSeconds)}]
                        </>
                    )}
                </Text>
                {title ? (
                    <Text color={state.running ? "white" : undefined} dimColor={!state.running}>
                        {title}
                    </Text>
                ) : null}
            </Box>
        </Box>
    );
}

function QuitPrompt({ onQuit }: { onQuit: () => void }) {
    useInput(() => {
        onQuit();
    });
    return <Text>Press any key to quit...</Text>;
}

function App({
    actionEmitter,
    answerEmitter,
}: {
    actionEmitter: EventEmitter;
    answerEmitter: EventEmitter;
}) {
    const [state, dispatch] = useReducer(reduce, initialUiState);

    useEffect(() => {
        const handler = (action: UiAction) => dispatch(action);
        actionEmitter.on("action", handler);
        return () => {
            actionEmitter.off("action", handler);
        };
    }, [actionEmitter]);

    useEffect(() => {
        if (!state.running) {
            return;
        }
        const interval = setInterval(() => dispatch({ type: "tick_elapsed" }), 1000);
        return () => clearInterval(interval);
    }, [state.running]);

    return (
        <Box flexDirection="column">
            <Static items={state.log}>{(line) => <LogLineView key={line.id} line={line} />}</Static>
            <DevtoolsPanel devtools={state.devtools} />
            <FailuresPanel failures={state.failures} />
            <Box>
                <StatusBar state={state} />
            </Box>
            {state.awaitingQuitPrompt ? (
                <QuitPrompt
                    onQuit={() => {
                        answerEmitter.emit("answer");
                    }}
                />
            ) : null}
        </Box>
    );
}

export function mountUi(actionEmitter: EventEmitter, answerEmitter: EventEmitter) {
    const instance = render(<App actionEmitter={actionEmitter} answerEmitter={answerEmitter} />, {
        exitOnCtrlC: false,
    });
    return {
        stop: () => instance.unmount(),
    };
}
