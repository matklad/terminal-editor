import { spawn, ChildProcess } from 'child_process';

export interface TerminalSettings {
    maxOutputLines(): number;
}

export interface ParsedCommand {
    tokens: string[];
    cursorTokenIndex?: number;
    cursorTokenOffset?: number;
}

interface ProcessInfo {
    process: ChildProcess;
    startTime: Date;
    exitCode?: number;
    stdout: string;
    stderr: string;
    commandLine: string;
    completion: Promise<number>;
}

export class Terminal {
    private currentProcess?: ProcessInfo;
    private settings: TerminalSettings;

    constructor(settings: TerminalSettings) {
        this.settings = settings;
    }

    status(): { text: string } {
        return { text: "= =" };
    }

    output(): { text: string } {
        if (!this.currentProcess) {
            return { text: "" };
        }

        const combinedOutput = this.currentProcess.stdout + this.currentProcess.stderr;
        const lines = combinedOutput.split('\n');

        const maxLines = this.settings.maxOutputLines();
        if (lines.length <= maxLines) {
            return { text: combinedOutput };
        }

        const limitedLines = lines.slice(-maxLines);
        return { text: limitedLines.join('\n') };
    }

    run(commandString: string): void {
        // Kill existing process if running
        if (this.currentProcess && this.currentProcess.exitCode === undefined) {
            this.currentProcess.process.kill("SIGKILL");
        }

        // Parse command
        const parsed = parseCommand(commandString);
        if (parsed.tokens.length === 0) {
            return;
        }

        // Start new process
        const [program, ...args] = parsed.tokens;
        const process = spawn(program, args);

        // Create completion promise that resolves when process exits
        const completion = new Promise<number>((resolve) => {
            process.on('close', (code: number) => {
                processInfo.exitCode = code;
                resolve(code);
            });
        });

        const processInfo: ProcessInfo = {
            process,
            startTime: new Date(),
            exitCode: undefined,
            stdout: '',
            stderr: '',
            commandLine: commandString,
            completion
        };

        this.currentProcess = processInfo;

        // Capture stdout
        process.stdout.on('data', (data: Buffer) => {
            processInfo.stdout += data.toString();
        });

        // Capture stderr
        process.stderr.on('data', (data: Buffer) => {
            processInfo.stderr += data.toString();
        });
    }

    async waitForCompletion(): Promise<void> {
        if (!this.currentProcess) {
            return;
        }

        if (this.currentProcess.exitCode !== undefined) {
            return;
        }

        await this.currentProcess.completion;
    }
}

export function parseCommand(command: string, cursorPosition?: number): ParsedCommand {
    const tokens: string[] = [];
    let cursorTokenIndex: number | undefined;
    let cursorTokenOffset: number | undefined;
    let i = 0;

    // Single pass: tokenize and track cursor position simultaneously
    while (i < command.length) {
        // Skip whitespace
        while (i < command.length && (command[i] === ' ' || command[i] === '\t')) {
            // Check if cursor is on whitespace
            if (cursorPosition === i) {
                cursorTokenIndex = undefined;
                cursorTokenOffset = undefined;
            }
            i++;
        }

        if (i >= command.length) {
            break;
        }

        // Parse token
        const tokenStart = i;
        const tokenIndex = tokens.length;
        let token = '';

        if (command[i] === '"') {
            // Quoted token
            const quoteStart = i;
            i++; // Skip opening quote

            while (i < command.length && command[i] !== '"') {
                // Check cursor position within quoted content
                if (cursorPosition === i) {
                    cursorTokenIndex = tokenIndex;
                    cursorTokenOffset = i - quoteStart - 1; // Offset from start of content (excluding quote)
                }
                token += command[i];
                i++;
            }

            if (i < command.length) {
                i++; // Skip closing quote
            }

            // Check if cursor is at the opening quote
            if (cursorPosition === quoteStart) {
                cursorTokenIndex = tokenIndex;
                cursorTokenOffset = 0;
            }
        } else {
            // Unquoted token
            while (i < command.length && command[i] !== ' ' && command[i] !== '\t') {
                // Check cursor position within token
                if (cursorPosition === i) {
                    cursorTokenIndex = tokenIndex;
                    cursorTokenOffset = i - tokenStart;
                }
                token += command[i];
                i++;
            }
        }

        tokens.push(token);
    }

    // Handle cursor at end of command
    if (cursorPosition === command.length) {
        if (command.length === 0 || command[command.length - 1] === ' ' || command[command.length - 1] === '\t') {
            // Cursor at end on whitespace
            cursorTokenIndex = undefined;
            cursorTokenOffset = undefined;
        } else if (tokens.length > 0) {
            // Cursor at end of last token
            cursorTokenIndex = tokens.length - 1;
            cursorTokenOffset = tokens[tokens.length - 1].length;
        }
    }

    return {
        tokens,
        cursorTokenIndex,
        cursorTokenOffset
    };
}
