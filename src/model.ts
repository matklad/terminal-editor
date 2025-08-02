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

export interface Token {
  start: number;
  end: number;
  tag: "word" | "quoted" | "whitespace";
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

export function tokenizeCommand(command: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < command.length) {
    const start = i;

    if (command[i] === " " || command[i] === "\t") {
      // Whitespace token
      while (i < command.length && (command[i] === " " || command[i] === "\t")) {
        i++;
      }
      tokens.push({
        start,
        end: i,
        tag: "whitespace",
      });
    } else if (command[i] === '"') {
      // Quoted token
      i++; // Skip opening quote
      const contentStart = i;
      
      while (i < command.length && command[i] !== '"') {
        i++;
      }
      
      const content = command.slice(contentStart, i);
      
      if (i < command.length) {
        i++; // Skip closing quote
      }
      
      tokens.push({
        start,
        end: i,
        tag: "quoted",
      });
    } else {
      // Word token
      while (i < command.length && command[i] !== " " && command[i] !== "\t") {
        i++;
      }
      tokens.push({
        start,
        end: i,
        tag: "word",
      });
    }
  }

  // Assert range consistency
  for (let j = 0; j < tokens.length; j++) {
    const token = tokens[j];
    
    // Check that start is at expected position
    if (j === 0) {
      console.assert(token.start === 0, `First token should start at 0, got ${token.start}`);
    } else {
      const prevToken = tokens[j - 1];
      console.assert(token.start === prevToken.end, 
        `Token ${j} should start at ${prevToken.end}, got ${token.start}`);
    }
    
    // Check that range is valid
    console.assert(token.start < token.end, 
      `Token ${j} should have start < end, got ${token.start} >= ${token.end}`);
  }
  
  // Check that ranges cover entire input
  if (tokens.length > 0) {
    const lastToken = tokens[tokens.length - 1];
    console.assert(lastToken.end === command.length, 
      `Last token should end at ${command.length}, got ${lastToken.end}`);
  } else {
    console.assert(command.length === 0, 
      `Empty token list should only occur for empty command, got length ${command.length}`);
  }

  return tokens;
}

export function parseCommand(
  command: string,
  cursorPosition?: number,
): ParsedCommand {
  const allTokens = tokenizeCommand(command);
  const tokens: string[] = [];
  let cursorTokenIndex: number | undefined;
  let cursorTokenOffset: number | undefined;

  // Extract non-whitespace tokens and track cursor position
  let currentTokenIndex = 0;
  
  for (const token of allTokens) {
    if (token.tag === "whitespace") {
      // Check if cursor is on whitespace
      if (cursorPosition !== undefined && cursorPosition >= token.start && cursorPosition < token.end) {
        cursorTokenIndex = undefined;
        cursorTokenOffset = undefined;
      }
    } else {
      // Non-whitespace token (word or quoted)
      let tokenValue: string;
      if (token.tag === "quoted") {
        // For quoted tokens, extract content without quotes
        const fullText = command.slice(token.start, token.end);
        if (fullText.startsWith('"') && fullText.length > 1) {
          const endIndex = fullText.endsWith('"') ? -1 : fullText.length;
          tokenValue = fullText.slice(1, endIndex);
        } else {
          tokenValue = fullText;
        }
      } else {
        // For word tokens, use the full range
        tokenValue = command.slice(token.start, token.end);
      }
      
      tokens.push(tokenValue);
      
      // Check if cursor is within this token
      if (cursorPosition !== undefined && cursorPosition >= token.start && cursorPosition < token.end) {
        cursorTokenIndex = currentTokenIndex;
        
        if (token.tag === "quoted") {
          // For quoted tokens, cursor position relative to quote start
          if (cursorPosition === token.start) {
            // Cursor at opening quote
            cursorTokenOffset = 0;
          } else {
            // Cursor within content (exclude opening quote)
            cursorTokenOffset = cursorPosition - token.start - 1;
          }
        } else {
          // For word tokens, cursor position relative to token start
          cursorTokenOffset = cursorPosition - token.start;
        }
      }
      
      currentTokenIndex++;
    }
  }

  // Handle cursor at end of command
  if (cursorPosition === command.length) {
    if (allTokens.length === 0 || allTokens[allTokens.length - 1].tag === "whitespace") {
      // Cursor at end on whitespace or empty command
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
