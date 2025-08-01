import { ChildProcess, spawn } from "child_process";
import { syncPending } from "./extension";

export interface TerminalSettings {
  maxOutputLines(): number;
}

export interface TerminalEvents {
  onOutput?: () => void;
  onStateChange?: () => void;
  onRuntimeUpdate?: () => void;
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
  runtimeUpdateInterval?: NodeJS.Timeout;
}

export class Terminal {
  private currentProcess?: ProcessInfo;
  private settings: TerminalSettings;
  private events: TerminalEvents;
  private workingDirectory: string;
  private folded: boolean = true;

  constructor(
    settings: TerminalSettings,
    events: TerminalEvents = {},
    workingDirectory?: string,
  ) {
    this.settings = settings;
    this.events = events;
    this.workingDirectory = workingDirectory || process.cwd();
  }

  status(): { text: string } {
    if (!this.currentProcess) {
      return { text: "= =" };
    }

    const runtime = this.formatRuntime();
    const status = this.currentProcess.exitCode !== undefined
      ? ` status: ${this.currentProcess.exitCode}`
      : "";

    return { text: `= time: ${runtime}${status} =` };
  }

  private formatRuntime(): string {
    if (!this.currentProcess) {
      return "0s";
    }

    const now = new Date();

    const durationMs = now.getTime() - this.currentProcess.startTime.getTime();
    const durationSeconds = Math.floor(durationMs / 1000);

    if (durationSeconds < 60) {
      return `${durationSeconds}s`;
    }

    const minutes = Math.floor(durationSeconds / 60);
    const seconds = durationSeconds % 60;

    return `${minutes}m ${seconds}s`;
  }

  output(): { text: string } {
    if (!this.currentProcess) {
      return { text: "" };
    }

    const combinedOutput = this.currentProcess.stdout +
      this.currentProcess.stderr;

    // In full mode, return all output
    if (!this.folded) {
      return { text: combinedOutput };
    }

    // In folded mode, limit to maxOutputLines
    const lines = combinedOutput.split("\n");
    const maxLines = this.settings.maxOutputLines();
    if (lines.length <= maxLines) {
      return { text: combinedOutput };
    }

    const limitedLines = lines.slice(-maxLines);
    return { text: limitedLines.join("\n") };
  }

  run(commandString: string): void {
    // Kill existing process if running and stop runtime updates
    if (this.currentProcess && this.currentProcess.exitCode === undefined) {
      clearInterval(this.currentProcess.runtimeUpdateInterval);
      this.currentProcess.process.kill("SIGKILL");
    }
    if (this.currentProcess?.runtimeUpdateInterval) {
      clearInterval(this.currentProcess.runtimeUpdateInterval);
      this.currentProcess.runtimeUpdateInterval = undefined;
    }

    // Parse command
    const parsed = parseCommand(commandString);
    if (parsed.tokens.length === 0) {
      return;
    }

    // Start new process
    const [program, ...args] = parsed.tokens;
    const process = spawn(program, args, { cwd: this.workingDirectory });

    let completionResolve: (code: number) => void;
    const completion = new Promise<number>((resolve) => {
      completionResolve = resolve;
    });

    const processInfo: ProcessInfo = {
      process,
      startTime: new Date(),
      exitCode: undefined,
      stdout: "",
      stderr: "",
      commandLine: commandString,
      completion,
      runtimeUpdateInterval: setInterval(() => {
        if (processInfo.exitCode !== undefined) {
          clearInterval(processInfo.runtimeUpdateInterval);
          processInfo.runtimeUpdateInterval = undefined;
          return;
        }
        this.events.onRuntimeUpdate?.();
      }, 1000),
    };
    this.currentProcess = processInfo;

    // Handle process close (normal exit)
    process.on("close", (code: number) => {
      processInfo.exitCode = code;
      this.events.onStateChange?.();
      completionResolve(code);
    });

    // Handle spawn errors (e.g., command not found)
    process.on("error", (error: Error) => {
      processInfo.stderr += error.message + "\n";
      processInfo.exitCode = 127; // Standard exit code for command not found
      this.events.onOutput?.();
      this.events.onStateChange?.();
      completionResolve(127);
    });

    // Capture stdout (only if it exists)
    if (process.stdout) {
      process.stdout.on("data", (data: Buffer) => {
        processInfo.stdout += data.toString();
        this.events.onOutput?.();
      });
    }

    // Capture stderr (only if it exists)
    if (process.stderr) {
      process.stderr.on("data", (data: Buffer) => {
        processInfo.stderr += data.toString();
        this.events.onOutput?.();
      });
    }

    // Notify that state has changed (process started)
    this.events.onStateChange?.();
  }

  isRunning(): boolean {
    return this.currentProcess !== undefined &&
      this.currentProcess.exitCode === undefined;
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

  toggleFold(): void {
    this.folded = !this.folded;
    this.events.onStateChange?.();
  }

  isFolded(): boolean {
    return this.folded;
  }
}

export function parseCommand(
  command: string,
  cursorPosition?: number,
): ParsedCommand {
  const tokens: string[] = [];
  let cursorTokenIndex: number | undefined;
  let cursorTokenOffset: number | undefined;
  let i = 0;

  // Single pass: tokenize and track cursor position simultaneously
  while (i < command.length) {
    // Skip whitespace
    while (i < command.length && (command[i] === " " || command[i] === "\t")) {
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
    let token = "";

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
      while (i < command.length && command[i] !== " " && command[i] !== "\t") {
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
    if (
      command.length === 0 || command[command.length - 1] === " " ||
      command[command.length - 1] === "\t"
    ) {
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
    cursorTokenOffset,
  };
}
