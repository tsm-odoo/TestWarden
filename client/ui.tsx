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

function LogLineView({ line }: { line: LogLine }) {
    switch (line.kind) {
        case "step":
            return (
                <Text>
                    <Text color="green">✔ </Text>
                    <Text>{line.text}</Text>
                </Text>
            );
        case "warn":
            return <Text color="yellow">{line.text}</Text>;
        case "error":
            return <Text color="red">{line.text}</Text>;
        case "blank":
            return <Text> </Text>;
        default:
            return <Text>{line.text}</Text>;
    }
}

function indent(text: string): string {
    return text
        .split("\n")
        .map((line) => `    ${line}`)
        .join("\n");
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
                    <Text key={d.worker}>
                        Worker {d.worker} {osc8(d.url, "devtools")}
                        {d.failCount > 0 ? ` [${d.failCount} Failed]` : ""}
                    </Text>
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
                    <Text color="yellow">{failure.text}</Text>
                    {failure.stack ? <Text dimColor>{indent(failure.stack)}</Text> : null}
                </Box>
            ))}
        </Box>
    );
}

function StatusBar({ state }: { state: UiState }) {
    const title = state.currentTestTitle;
    const spinnerFrame = useSpinnerFrame(state.currentStep !== null);
    return (
        <Box flexDirection="column">
            {state.currentStep ? (
                <Text>
                    {spinnerFrame} {state.currentStep}
                </Text>
            ) : null}
            <Box marginTop={state.hasFailed ? 1 : 0} flexDirection="column">
                <Text color={state.running ? "cyan" : "gray"} dimColor={!state.running}>
                    {renderBar(state.testValue, state.testTotal)} {state.testValue}/
                    {state.testTotal} [Run #{state.runNumber} | {state.elapsedSeconds}s]
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
    const instance = render(<App actionEmitter={actionEmitter} answerEmitter={answerEmitter} />);
    return {
        stop: () => instance.unmount(),
    };
}
