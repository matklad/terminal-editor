import { env as my_env } from "process";
import { ChildProcess, spawn } from "child_process";

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
    | "error"
    | "ansi_dim"
    | "ansi_bold"
    | "ansi_underline"
    | "ansi_red"
    | "ansi_green"
    | "ansi_yellow"
    | "ansi_blue"
    | "ansi_magenta"
    | "ansi_cyan"
    | "ansi_white";
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
  stdout: ANSIText;
  stderr: ANSIText;
  commandLine: string;
  completion: Promise<void>;
  cleanup: (code: number | undefined) => void;
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

    // Combine stdout and stderr text and ranges
    const stdoutResult = this.currentProcess.stdout.getTextWithRanges();
    const stderrResult = this.currentProcess.stderr.getTextWithRanges();

    const combinedText = stdoutResult.text + stderrResult.text;

    // Adjust stderr ranges to account for stdout text length
    const adjustedStderrRanges = stderrResult.ranges.map((range) => ({
      ...range,
      start: range.start + stdoutResult.text.length,
      end: range.end + stdoutResult.text.length,
    }));

    const combinedRanges = [...stdoutResult.ranges, ...adjustedStderrRanges];

    let text: string;
    let ranges: HighlightRange[];

    // In full mode, return all output
    if (!this.folded) {
      text = combinedText;
      ranges = combinedRanges;
    } else {
      // In folded mode, limit to maxOutputLines
      const lines = combinedText.split("\n");
      const maxLines = this.settings.maxOutputLines();
      if (lines.length <= maxLines) {
        text = combinedText;
        ranges = combinedRanges;
      } else {
        const limitedLines = lines.slice(-maxLines);
        text = limitedLines.join("\n");

        // Calculate the character offset where truncation begins
        const fullLines = combinedText.split("\n");
        const truncatedLines = fullLines.length - maxLines;
        let truncationOffset = 0;
        for (let i = 0; i < truncatedLines; i++) {
          truncationOffset += fullLines[i].length + 1; // +1 for newline
        }

        // Filter and adjust ranges that fall within the truncated text
        ranges = combinedRanges
          .filter((range) => range.start >= truncationOffset)
          .map((range) => ({
            ...range,
            start: range.start - truncationOffset,
            end: range.end - truncationOffset,
          }));
      }
    }

    return { text, ranges };
  }

  run(commandString: string): void {
    // Kill existing process if running and stop runtime updates
    if (this.currentProcess) {
      this.currentProcess.process.kill("SIGKILL");
      this.currentProcess.cleanup(-1);
      this.currentProcess = undefined;
    }

    // Parse command
    const parsed = parseCommand(commandString);
    if (parsed.tokens.length === 0) {
      return;
    }

    this.folded = true;

    // Start new process
    const [program, ...args] = parsed.tokens;
    const process = spawn(program, args, {
      cwd: this.workingDirectory,
      env: {
        ...my_env,
        "CLICOLOR_FORCE": "1",
      },
    });

    let completionResolve: () => void;
    const completion = new Promise<void>((resolve) => {
      completionResolve = resolve;
    });

    const processInfo: ProcessInfo = {
      process,
      startTime: new Date(),
      exitCode: undefined,
      stdout: new ANSIText(),
      stderr: new ANSIText(),
      commandLine: commandString,
      completion,
      runtimeUpdateInterval: setInterval(
        () => this.events.onRuntimeUpdate?.(),
        1000,
      ),
      cleanup: (code: number | undefined) => {
        if (processInfo.exitCode !== undefined) {
          return;
        }
        processInfo.exitCode = (code === undefined) ? -1 : code;
        clearInterval(processInfo.runtimeUpdateInterval);
        this.events.onStateChange?.();
        completionResolve();
      },
    };
    this.currentProcess = processInfo;

    // Handle spawn errors (e.g., command not found)
    process.on("error", (error: Error) => {
      processInfo.stderr.append(error.message + "\n");
      processInfo.cleanup(127);
    });

    // Handle process close (normal exit)
    process.on("close", (code: number) => processInfo.cleanup(code));
    process.on("exit", (code: number) => processInfo.cleanup(code));

    // Capture stdout
    process.stdout.on("data", (data: Buffer) => {
      processInfo.stdout.append(data.toString());
      this.events.onOutput?.();
    });

    // Capture stderr
    process.stderr.on("data", (data: Buffer) => {
      processInfo.stderr.append(data.toString());
      this.events.onOutput?.();
    });

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

    const combinedOutput = this.currentProcess.stdout.getResultingText() +
      this.currentProcess.stderr.getResultingText();
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
      while (
        i < command.length && (command[i] === " " || command[i] === "\t")
      ) {
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
      console.assert(
        token.start === 0,
        `First token should start at 0, got ${token.start}`,
      );
    } else {
      const prevToken = tokens[j - 1];
      console.assert(
        token.start === prevToken.end,
        `Token ${j} should start at ${prevToken.end}, got ${token.start}`,
      );
    }

    // Check that range is valid
    console.assert(
      token.start < token.end,
      `Token ${j} should have start < end, got ${token.start} >= ${token.end}`,
    );
  }

  // Check that ranges cover entire input
  if (tokens.length > 0) {
    const lastToken = tokens[tokens.length - 1];
    console.assert(
      lastToken.end === command.length,
      `Last token should end at ${command.length}, got ${lastToken.end}`,
    );
  } else {
    console.assert(
      command.length === 0,
      `Empty token list should only occur for empty command, got length ${command.length}`,
    );
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
      if (
        cursorPosition !== undefined && cursorPosition >= token.start &&
        cursorPosition < token.end
      ) {
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
      if (
        cursorPosition !== undefined && cursorPosition >= token.start &&
        cursorPosition < token.end
      ) {
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
    if (
      allTokens.length === 0 ||
      allTokens[allTokens.length - 1].tag === "whitespace"
    ) {
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

export class ANSIText {
  private rawInput: string = "";
  private resultingText: string = "";
  private ranges: HighlightRange[] = [];

  append(input: string): void {
    this.rawInput += input;
    this.processANSI();
  }

  getRawInput(): string {
    return this.rawInput;
  }

  getResultingText(): string {
    return this.resultingText;
  }

  getRanges(): HighlightRange[] {
    return [...this.ranges];
  }

  getTextWithRanges(): TextWithRanges {
    return {
      text: this.resultingText,
      ranges: [...this.ranges],
    };
  }

  private processANSI(): void {
    let processed = "";
    let currentPos = 0;
    const ansiRanges: HighlightRange[] = [];

    // Track current ANSI state
    let currentStyles: Set<string> = new Set();
    let styleStartPositions: Map<string, number> = new Map();

    // Combined regex for both color codes and character set changes
    // \x1b[...m for colors, \x1b(...) for character sets
    const ansiRegex = /\x1b(?:\[([0-9;]*)m|\(([0B]))/g;

    let match;
    let lastIndex = 0;
    let inLineDrawingMode = false;

    while ((match = ansiRegex.exec(this.rawInput)) !== null) {
      // Add text before this ANSI code, converting line drawing characters if needed
      const textBefore = this.rawInput.slice(lastIndex, match.index);
      if (inLineDrawingMode) {
        processed += this.convertLineDrawingChars(textBefore);
      } else {
        processed += textBefore;
      }
      currentPos += textBefore.length;

      if (match[1] !== undefined) {
        // Color escape sequence \x1b[...m
        const codes = match[1].split(";").map((code) => parseInt(code, 10));
        for (const code of codes) {
          this.processANSICode(
            code,
            currentStyles,
            styleStartPositions,
            currentPos,
            ansiRanges,
          );
        }
      } else if (match[2] !== undefined) {
        // Character set escape sequence \x1b(...
        const charset = match[2];
        if (charset === "0") {
          inLineDrawingMode = true; // Enter DEC Special Character Set
        } else if (charset === "B") {
          inLineDrawingMode = false; // Return to ASCII
        }
      }

      lastIndex = match.index + match[0].length;
    }

    // Add remaining text after last ANSI code
    const remainingText = this.rawInput.slice(lastIndex);
    if (inLineDrawingMode) {
      processed += this.convertLineDrawingChars(remainingText);
    } else {
      processed += remainingText;
    }
    currentPos += remainingText.length;

    // Close any remaining open styles
    for (const [style, startPos] of styleStartPositions) {
      if (startPos < currentPos) {
        ansiRanges.push({
          start: startPos,
          end: currentPos,
          tag: this.styleToTag(style),
        });
      }
    }

    this.resultingText = processed;

    // Combine ANSI ranges with file path and error detection
    this.ranges = [...ansiRanges, ...this.detectHighlightRanges(processed)];

    // Sort ranges by start position to ensure proper ordering
    this.ranges.sort((a, b) => a.start - b.start);
  }

  private convertLineDrawingChars(text: string): string {
    // Convert DEC Special Character Set to Unicode equivalents
    return text.replace(/./g, (char) => {
      switch (char) {
        case "q":
          return "─"; // horizontal line
        case "x":
          return "│"; // vertical line
        case "l":
          return "┌"; // top-left corner
        case "k":
          return "┐"; // top-right corner
        case "m":
          return "└"; // bottom-left corner
        case "j":
          return "┘"; // bottom-right corner
        case "t":
          return "├"; // tee pointing right
        case "u":
          return "┤"; // tee pointing left
        case "v":
          return "┴"; // tee pointing up
        case "w":
          return "┬"; // tee pointing down
        case "n":
          return "┼"; // cross
        default:
          return char; // keep other characters as-is
      }
    });
  }

  private processANSICode(
    code: number,
    currentStyles: Set<string>,
    styleStartPositions: Map<string, number>,
    currentPos: number,
    ansiRanges: HighlightRange[],
  ): void {
    // Close existing ranges when style changes
    const closeStyle = (style: string) => {
      if (styleStartPositions.has(style)) {
        const startPos = styleStartPositions.get(style)!;
        if (startPos < currentPos) {
          ansiRanges.push({
            start: startPos,
            end: currentPos,
            tag: this.styleToTag(style),
          });
        }
        styleStartPositions.delete(style);
        currentStyles.delete(style);
      }
    };

    const openStyle = (style: string) => {
      if (!currentStyles.has(style)) {
        currentStyles.add(style);
        styleStartPositions.set(style, currentPos);
      }
    };

    switch (code) {
      case 0: // Reset all
        for (const style of currentStyles) {
          closeStyle(style);
        }
        break;
      case 1: // Bold
        openStyle("bold");
        break;
      case 2: // Dim
        openStyle("dim");
        break;
      case 4: // Underline
        openStyle("underline");
        break;
      case 22: // Normal intensity (turn off bold/dim)
        closeStyle("bold");
        closeStyle("dim");
        break;
      case 24: // No underline
        closeStyle("underline");
        break;
      case 30: // Black (foreground)
        // Close existing color styles
        this.closeColorStyles(
          currentStyles,
          styleStartPositions,
          currentPos,
          ansiRanges,
        );
        break;
      case 31: // Red
        this.closeColorStyles(
          currentStyles,
          styleStartPositions,
          currentPos,
          ansiRanges,
        );
        openStyle("red");
        break;
      case 32: // Green
        this.closeColorStyles(
          currentStyles,
          styleStartPositions,
          currentPos,
          ansiRanges,
        );
        openStyle("green");
        break;
      case 33: // Yellow
        this.closeColorStyles(
          currentStyles,
          styleStartPositions,
          currentPos,
          ansiRanges,
        );
        openStyle("yellow");
        break;
      case 34: // Blue
        this.closeColorStyles(
          currentStyles,
          styleStartPositions,
          currentPos,
          ansiRanges,
        );
        openStyle("blue");
        break;
      case 35: // Magenta
        this.closeColorStyles(
          currentStyles,
          styleStartPositions,
          currentPos,
          ansiRanges,
        );
        openStyle("magenta");
        break;
      case 36: // Cyan
        this.closeColorStyles(
          currentStyles,
          styleStartPositions,
          currentPos,
          ansiRanges,
        );
        openStyle("cyan");
        break;
      case 37: // White
        this.closeColorStyles(
          currentStyles,
          styleStartPositions,
          currentPos,
          ansiRanges,
        );
        openStyle("white");
        break;
      case 39: // Default foreground color
        this.closeColorStyles(
          currentStyles,
          styleStartPositions,
          currentPos,
          ansiRanges,
        );
        break;
    }
  }

  private closeColorStyles(
    currentStyles: Set<string>,
    styleStartPositions: Map<string, number>,
    currentPos: number,
    ansiRanges: HighlightRange[],
  ): void {
    const colorStyles = [
      "red",
      "green",
      "yellow",
      "blue",
      "magenta",
      "cyan",
      "white",
    ];
    for (const color of colorStyles) {
      if (styleStartPositions.has(color)) {
        const startPos = styleStartPositions.get(color)!;
        if (startPos < currentPos) {
          ansiRanges.push({
            start: startPos,
            end: currentPos,
            tag: this.styleToTag(color),
          });
        }
        styleStartPositions.delete(color);
        currentStyles.delete(color);
      }
    }
  }

  private styleToTag(style: string): HighlightRange["tag"] {
    switch (style) {
      case "dim":
        return "ansi_dim";
      case "bold":
        return "ansi_bold";
      case "underline":
        return "ansi_underline";
      case "red":
        return "ansi_red";
      case "green":
        return "ansi_green";
      case "yellow":
        return "ansi_yellow";
      case "blue":
        return "ansi_blue";
      case "magenta":
        return "ansi_magenta";
      case "cyan":
        return "ansi_cyan";
      case "white":
        return "ansi_white";
      default:
        return "ansi_dim"; // fallback
    }
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
}
