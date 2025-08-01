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

export interface HighlightRange {
  start: number;
  end: number;
  tag:
    | "keyword"
    | "punctuation"
    | "status_ok"
    | "status_err"
    | "time"
    | "path"
    | "error";
  file?: string;
  line?: number;
  column?: number;
}

export interface TextWithRanges {
  text: string;
  ranges: HighlightRange[];
}

export interface ParsedCommand {
  tokens: string[];
  cursorTokenIndex?: number;
  cursorTokenOffset?: number;
}

interface ProcessInfo {
  process: ChildProcess;
  startTime: Date;
  endTime?: Date;
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

  status(): TextWithRanges {
    if (!this.currentProcess) {
      return {
        text: "= =",
        ranges: [
          { start: 0, end: 1, tag: "punctuation" },
          { start: 2, end: 3, tag: "punctuation" },
        ],
      };
    }

    const runtime = this.formatRuntime();
    const status = this.currentProcess.exitCode !== undefined
      ? ` status: ${this.currentProcess.exitCode}`
      : "";

    // Always display `...` for long output.
    const ellipsis = this.outputLarge() ? "..." : "";

    const text = `= time: ${runtime}${status} ${ellipsis}=`;
    const ranges: HighlightRange[] = [];

    // Opening '='
    ranges.push({ start: 0, end: 1, tag: "punctuation" });

    // 'time:' keyword
    ranges.push({ start: 2, end: 7, tag: "keyword" });

    // Runtime value
    const runtimeStart = 8;
    const runtimeEnd = runtimeStart + runtime.length;
    ranges.push({ start: runtimeStart, end: runtimeEnd, tag: "time" });

    if (status) {
      // 'status:' keyword
      const statusKeywordStart = runtimeEnd + 1;
      const statusKeywordEnd = statusKeywordStart + 7;
      ranges.push({
        start: statusKeywordStart,
        end: statusKeywordEnd,
        tag: "keyword",
      });

      // Status value
      const statusValueStart = statusKeywordEnd + 1;
      const statusValueEnd = statusValueStart +
        this.currentProcess.exitCode!.toString().length;
      ranges.push({
        start: statusValueStart,
        end: statusValueEnd,
        tag: this.currentProcess.exitCode === 0 ? "status_ok" : "status_err",
      });
    }

    // Closing '='
    ranges.push({
      start: text.length - 1,
      end: text.length,
      tag: "punctuation",
    });

    return { text, ranges };
  }

  private formatRuntime(): string {
    if (!this.currentProcess) {
      return "0s";
    }

    // Use endTime if process has finished, otherwise use current time
    const endTime = this.currentProcess.endTime || new Date();

    const durationMs = endTime.getTime() -
      this.currentProcess.startTime.getTime();
    const durationSeconds = Math.floor(durationMs / 1000);

    if (durationSeconds < 60) {
      return `${durationSeconds}s`;
    }

    const minutes = Math.floor(durationSeconds / 60);
    const seconds = durationSeconds % 60;

    return `${minutes}m ${seconds}s`;
  }

  output(): TextWithRanges {
    if (!this.currentProcess) {
      return { text: "", ranges: [] };
    }

    const combinedOutput = this.currentProcess.stdout +
      this.currentProcess.stderr;

    let text: string;
    // In full mode, return all output
    if (!this.folded) {
      text = combinedOutput;
    } else {
      // In folded mode, limit to maxOutputLines
      const lines = combinedOutput.split("\n");
      const maxLines = this.settings.maxOutputLines();
      if (lines.length <= maxLines) {
        text = combinedOutput;
      } else {
        const limitedLines = lines.slice(-maxLines);
        text = limitedLines.join("\n");
      }
    }

    // Detect file paths and error messages
    const ranges = this.detectHighlightRanges(text);
    return { text, ranges };
  }

  private detectHighlightRanges(text: string): HighlightRange[] {
    const ranges: HighlightRange[] = [];

    // Pattern for file paths: capture file.ext:line:column (including absolute paths)
    const filePathPattern = /([^\s:]+\.[a-zA-Z]+):(\d+):(\d+)/g;

    // Pattern for error messages: "error:" (with colon) case insensitive
    const errorPattern = /\berror\s*:/gi;

    let match;

    // Find file paths
    while ((match = filePathPattern.exec(text)) !== null) {
      const filePath = match[1];
      const line = parseInt(match[2], 10);
      const column = parseInt(match[3], 10);

      ranges.push({
        start: match.index,
        end: match.index + match[0].length,
        tag: "path",
        file: filePath,
        line: line,
        column: column,
      });
    }

    // Reset regex lastIndex for error pattern
    errorPattern.lastIndex = 0;

    // Find error messages
    while ((match = errorPattern.exec(text)) !== null) {
      ranges.push({
        start: match.index,
        end: match.index + match[0].length,
        tag: "error",
      });
    }

    return ranges;
  }

  run(commandString: string): void {
    // Kill existing process if running and stop runtime updates
    if (this.currentProcess && this.currentProcess.exitCode === undefined) {
      clearInterval(this.currentProcess.runtimeUpdateInterval);
      this.currentProcess.process.kill("SIGKILL");
    }

    // Parse command
    const parsed = parseCommand(commandString);
    if (parsed.tokens.length === 0) {
      return;
    }

    this.folded = true;

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
      processInfo.endTime = new Date();
      this.events.onStateChange?.();
      completionResolve(code);
    });

    // Handle spawn errors (e.g., command not found)
    process.on("error", (error: Error) => {
      processInfo.stderr += error.message + "\n";
      processInfo.exitCode = 127; // Standard exit code for command not found
      processInfo.endTime = new Date();
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

  private outputLarge(): boolean {
    if (!this.currentProcess) {
      return false;
    }

    const combinedOutput = this.currentProcess.stdout +
      this.currentProcess.stderr;
    const lines = combinedOutput.split("\n");
    const maxLines = this.settings.maxOutputLines();

    return lines.length > maxLines;
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
