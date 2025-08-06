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

import * as vscode from "vscode";

export interface HighlightRange {
  range: vscode.Range;
  tag:
    | "keyword"
    | "punctuation"
    | "status_ok"
    | "status_err"
    | "time"
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
}

// Helper function to create HighlightRange from character offsets (single line)
function createHighlightRange(line: number, start: number, end: number, tag: HighlightRange["tag"]): HighlightRange {
  return {
    range: new vscode.Range(line, start, line, end),
    tag,
  };
}

// Helper function to create HighlightRange from line/char positions (potentially multi-line)
function createHighlightRangeFromPositions(
  startLine: number,
  startChar: number,
  endLine: number,
  endChar: number,
  tag: HighlightRange["tag"]
): HighlightRange {
  return {
    range: new vscode.Range(startLine, startChar, endLine, endChar),
    tag,
  };
}

// Helper function to adjust ranges when appending text
function adjustRangesForAppendedText(ranges: HighlightRange[], baseText: string): HighlightRange[] {
  if (baseText.length === 0) {
    return ranges;
  }
  
  // Count lines and get the character position of the last line
  const lines = baseText.split('\n');
  const lineOffset = lines.length - 1;
  const charOffset = lines[lines.length - 1].length;
  
  return ranges.map((range) => ({
    ...range,
    range: new vscode.Range(
      range.range.start.line + lineOffset,
      range.range.start.line === 0 ? range.range.start.character + charOffset : range.range.start.character,
      range.range.end.line + lineOffset,
      range.range.end.line === 0 ? range.range.end.character + charOffset : range.range.end.character
    ),
  }));
}

// Helper function to filter and adjust ranges after line-based truncation
function adjustRangesForLineTruncation(ranges: HighlightRange[], truncatedLines: number): HighlightRange[] {
  return ranges
    .filter((range) => range.range.start.line >= truncatedLines)
    .map((range) => ({
      ...range,
      range: new vscode.Range(
        range.range.start.line - truncatedLines,
        range.range.start.character,
        range.range.end.line - truncatedLines,
        range.range.end.character
      ),
    }));
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
          createHighlightRange(0, 0, 1, "punctuation"),
          createHighlightRange(0, 2, 3, "punctuation"),
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
    ranges.push(createHighlightRange(0, 0, 1, "punctuation"));

    // 'time:' keyword
    ranges.push(createHighlightRange(0, 2, 7, "keyword"));

    // Runtime value
    const runtimeStart = 8;
    const runtimeEnd = runtimeStart + runtime.length;
    ranges.push(createHighlightRange(0, runtimeStart, runtimeEnd, "time"));

    if (status) {
      // 'status:' keyword
      const statusKeywordStart = runtimeEnd + 1;
      const statusKeywordEnd = statusKeywordStart + 7;
      ranges.push(createHighlightRange(0, statusKeywordStart, statusKeywordEnd, "keyword"));

      // Status value
      const statusValueStart = statusKeywordEnd + 1;
      const statusValueEnd = statusValueStart +
        this.currentProcess.exitCode!.toString().length;
      ranges.push(createHighlightRange(
        0,
        statusValueStart,
        statusValueEnd,
        this.currentProcess.exitCode === 0 ? "status_ok" : "status_err"
      ));
    }

    // Closing '='
    ranges.push(createHighlightRange(0, text.length - 1, text.length, "punctuation"));

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

    // Adjust stderr ranges to account for stdout text
    const adjustedStderrRanges = adjustRangesForAppendedText(stderrResult.ranges, stdoutResult.text);

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

        // Filter and adjust ranges for the truncated lines
        const truncatedLines = lines.length - maxLines;
        ranges = adjustRangesForLineTruncation(combinedRanges, truncatedLines);
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
    let currentLine = 0;
    let currentChar = 0;
    const ansiRanges: HighlightRange[] = [];

    // Track current ANSI state
    let currentStyles: Set<string> = new Set();
    let styleStartPositions: Map<string, { line: number; char: number }> = new Map();

    // Combined regex for both color codes and character set changes
    // \x1b[...m for colors, \x1b(...) for character sets
    const ansiRegex = /\x1b(?:\[([0-9;]*)m|\(([0B]))/g;

    let match;
    let lastIndex = 0;
    let inLineDrawingMode = false;

    while ((match = ansiRegex.exec(this.rawInput)) !== null) {
      // Add text before this ANSI code, converting line drawing characters if needed
      const textBefore = this.rawInput.slice(lastIndex, match.index);
      let processedTextBefore;
      if (inLineDrawingMode) {
        processedTextBefore = this.convertLineDrawingChars(textBefore);
      } else {
        processedTextBefore = textBefore;
      }
      processed += processedTextBefore;
      
      // Update line/char positions based on processed text
      for (let i = 0; i < processedTextBefore.length; i++) {
        if (processedTextBefore[i] === '\n') {
          currentLine++;
          currentChar = 0;
        } else {
          currentChar++;
        }
      }

      if (match[1] !== undefined) {
        // Color escape sequence \x1b[...m
        const codes = match[1].split(";").map((code) => parseInt(code, 10));
        for (const code of codes) {
          this.processANSICode(
            code,
            currentStyles,
            styleStartPositions,
            currentLine,
            currentChar,
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
    let processedRemainingText;
    if (inLineDrawingMode) {
      processedRemainingText = this.convertLineDrawingChars(remainingText);
    } else {
      processedRemainingText = remainingText;
    }
    processed += processedRemainingText;
    
    // Update line/char positions for remaining text
    for (let i = 0; i < processedRemainingText.length; i++) {
      if (processedRemainingText[i] === '\n') {
        currentLine++;
        currentChar = 0;
      } else {
        currentChar++;
      }
    }

    // Close any remaining open styles
    for (const [style, startPos] of styleStartPositions) {
      ansiRanges.push(createHighlightRangeFromPositions(startPos.line, startPos.char, currentLine, currentChar, style as HighlightRange["tag"]));
    }

    this.resultingText = processed;
    this.ranges = ansiRanges;
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
    styleStartPositions: Map<string, { line: number; char: number }>,
    currentLine: number,
    currentChar: number,
    ansiRanges: HighlightRange[],
  ): void {
    // Close existing ranges when style changes
    const closeStyle = (style: string) => {
      if (styleStartPositions.has(style)) {
        const startPos = styleStartPositions.get(style)!;
        ansiRanges.push(createHighlightRangeFromPositions(
          startPos.line,
          startPos.char,
          currentLine,
          currentChar,
          style as HighlightRange["tag"]
        ));
        styleStartPositions.delete(style);
        currentStyles.delete(style);
      }
    };

    const openStyle = (style: string) => {
      if (!currentStyles.has(style)) {
        currentStyles.add(style);
        styleStartPositions.set(style, { line: currentLine, char: currentChar });
      }
    };

    switch (code) {
      case 0: // Reset all
        for (const style of currentStyles) {
          closeStyle(style);
        }
        break;
      case 1: // Bold
        openStyle("ansi_bold");
        break;
      case 2: // Dim
        openStyle("ansi_dim");
        break;
      case 4: // Underline
        openStyle("ansi_underline");
        break;
      case 22: // Normal intensity (turn off bold/dim)
        closeStyle("ansi_bold");
        closeStyle("ansi_dim");
        break;
      case 24: // No underline
        closeStyle("ansi_underline");
        break;
      case 30: // Black (foreground)
        // Close existing color styles
        this.closeColorStyles(
          currentStyles,
          styleStartPositions,
          currentLine,
          currentChar,
          ansiRanges,
        );
        break;
      case 31: // Red
        this.closeColorStyles(
          currentStyles,
          styleStartPositions,
          currentLine,
          currentChar,
          ansiRanges,
        );
        openStyle("ansi_red");
        break;
      case 32: // Green
        this.closeColorStyles(
          currentStyles,
          styleStartPositions,
          currentLine,
          currentChar,
          ansiRanges,
        );
        openStyle("ansi_green");
        break;
      case 33: // Yellow
        this.closeColorStyles(
          currentStyles,
          styleStartPositions,
          currentLine,
          currentChar,
          ansiRanges,
        );
        openStyle("ansi_yellow");
        break;
      case 34: // Blue
        this.closeColorStyles(
          currentStyles,
          styleStartPositions,
          currentLine,
          currentChar,
          ansiRanges,
        );
        openStyle("ansi_blue");
        break;
      case 35: // Magenta
        this.closeColorStyles(
          currentStyles,
          styleStartPositions,
          currentLine,
          currentChar,
          ansiRanges,
        );
        openStyle("ansi_magenta");
        break;
      case 36: // Cyan
        this.closeColorStyles(
          currentStyles,
          styleStartPositions,
          currentLine,
          currentChar,
          ansiRanges,
        );
        openStyle("ansi_cyan");
        break;
      case 37: // White
        this.closeColorStyles(
          currentStyles,
          styleStartPositions,
          currentLine,
          currentChar,
          ansiRanges,
        );
        openStyle("ansi_white");
        break;
      case 39: // Default foreground color
        this.closeColorStyles(
          currentStyles,
          styleStartPositions,
          currentLine,
          currentChar,
          ansiRanges,
        );
        break;
    }
  }

  private closeColorStyles(
    currentStyles: Set<string>,
    styleStartPositions: Map<string, { line: number; char: number }>,
    currentLine: number,
    currentChar: number,
    ansiRanges: HighlightRange[],
  ): void {
    const colorStyles = [
      "ansi_red",
      "ansi_green",
      "ansi_yellow",
      "ansi_blue",
      "ansi_magenta",
      "ansi_cyan",
      "ansi_white",
    ];
    for (const color of colorStyles) {
      if (styleStartPositions.has(color)) {
        const startPos = styleStartPositions.get(color)!;
        ansiRanges.push(createHighlightRangeFromPositions(
          startPos.line,
          startPos.char,
          currentLine,
          currentChar,
          color as HighlightRange["tag"]
        ));
        styleStartPositions.delete(color);
        currentStyles.delete(color);
      }
    }
  }

}
