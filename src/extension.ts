import * as vscode from "vscode";
import {
  HighlightRange,
  Terminal,
  TerminalEvents,
  TerminalSettings,
  FakeTimeProvider,
} from "./model";

interface DocumentRanges {
  command: vscode.Range;
  status: vscode.Range | undefined;
  output: vscode.Range | undefined;
}

let terminal: Terminal;
let ansiDecorationProvider: AnsiDecorationProvider;
let extensionContext: vscode.ExtensionContext;
let syncRunning = false;
export let syncPending = false;
let syncCompletionResolvers: (() => void)[] = [];

class VSCodeTerminalSettings implements TerminalSettings {
  maxOutputLines(): number {
    const config = vscode.workspace.getConfiguration("terminal-editor");
    return config.get<number>("maxOutputLines", 40);
  }

  workingDirectory(): string {
    const config = vscode.workspace.getConfiguration("terminal-editor");
    const configuredDir = config.get<string>("workingDirectory", "");
    
    if (configuredDir.trim() !== "") {
      return configuredDir;
    }
    
    return getWorkspaceRoot();
  }
}

function getWorkspaceRoot(): string {
  // Get the first workspace folder if available, otherwise use current working directory
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders && workspaceFolders.length > 0) {
    return workspaceFolders[0].uri.fsPath;
  }
  return process.cwd();
}

// Test helper function to reset state
export function resetForTesting() {
  syncRunning = false;
  syncPending = false;
  syncCompletionResolvers = [];
  const fakeTime = new FakeTimeProvider();
  terminal = new Terminal(
    new VSCodeTerminalSettings(),
    createTerminalEvents(),
    [],
    fakeTime,
  );
  ansiDecorationProvider = new AnsiDecorationProvider();
}

// Test helper function to get terminal instance
export function getTerminalForTesting(): Terminal {
  return terminal;
}

function createTerminalEvents(): TerminalEvents {
  function syncIfVisible() {
    const editor = visibleTerminal();
    if (editor) {
      sync(editor);
    }
  }
  return {
    onOutput: syncIfVisible,
    onStateChange: syncIfVisible,
    onRuntimeUpdate: syncIfVisible,
  };
}

function saveHistory(): void {
  if (extensionContext) {
    extensionContext.globalState.update("terminal-editor.history", terminal.getHistory());
  }
}

export function activate(context: vscode.ExtensionContext) {
  console.log(
    'Congratulations, your extension "terminal-editor" is now active!',
  );

  extensionContext = context;

  // Load history from VS Code state
  const savedHistory = context.globalState.get<string[]>("terminal-editor.history", []);

  terminal = new Terminal(
    new VSCodeTerminalSettings(),
    createTerminalEvents(),
    savedHistory,
  );

  const fileSystemProvider = new EphemeralFileSystem();
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(
      "terminal-editor",
      fileSystemProvider,
    ),
  );

  ansiDecorationProvider = new AnsiDecorationProvider();
  context.subscriptions.push(ansiDecorationProvider);

  const definitionProvider = new FilePathDefinitionProvider();
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(
      { scheme: "terminal-editor" },
      definitionProvider,
    ),
  );

  const revealCommand = vscode.commands.registerCommand(
    "terminal-editor.reveal",
    reveal,
  );
  const runCommand = vscode.commands.registerCommand(
    "terminal-editor.run",
    run,
  );
  const dwimCommand = vscode.commands.registerCommand(
    "terminal-editor.dwim",
    dwim,
  );
  const toggleFoldCommand = vscode.commands.registerCommand(
    "terminal-editor.toggleFold",
    toggleFold,
  );
  const tabCommand = vscode.commands.registerCommand(
    "terminal-editor.tab",
    handleTab,
  );
  const clearHistoryCommand = vscode.commands.registerCommand(
    "terminal-editor.clearHistory",
    clearHistory,
  );

  context.subscriptions.push(
    revealCommand,
    runCommand,
    dwimCommand,
    toggleFoldCommand,
    tabCommand,
    clearHistoryCommand,
  );
}

export function deactivate() {}

class FilePathDefinitionProvider implements vscode.DefinitionProvider {
  private readonly filePathRegex =
    /([a-zA-Z0-9_\-\/\.]+\.(?:zig|rs|ts|js|py|c|cpp|h|hpp|java|go|rb|php|cs|swift|kt|scala|clj|ml|hs|elm|dart|lua|r|jl|nim|cr|ex|exs|erl|hrl|f90|f95|pas|pl|sh|bat|ps1|vim|tex|md|rst|org|adoc|json|yaml|yml|toml|ini|cfg|conf|xml|html|css|scss|sass|less|sql|proto|thrift|avro|graphql|dockerfile|makefile|cmake|gradle|sbt|cabal|mix|cargo|poetry|pipfile|requirements|setup|package|bower|composer|npm|yarn|pom)):(\d+):(\d+)/g;

  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.Definition> {
    const line = document.lineAt(position.line);
    const text = line.text;

    this.filePathRegex.lastIndex = 0;
    let match;
    while ((match = this.filePathRegex.exec(text)) !== null) {
      const [fullMatch, filePath, lineNum, colNum] = match;
      const matchStart = match.index;
      const matchEnd = match.index + fullMatch.length;

      if (position.character >= matchStart && position.character <= matchEnd) {
        const workspaceRoot = getWorkspaceRoot();
        const fullPath = vscode.Uri.file(
          filePath.startsWith("/") ? filePath : `${workspaceRoot}/${filePath}`,
        );

        const targetLine = Math.max(0, parseInt(lineNum, 10) - 1);
        const targetCol = Math.max(0, parseInt(colNum, 10) - 1);
        const targetPosition = new vscode.Position(targetLine, targetCol);

        return new vscode.Location(fullPath, targetPosition);
      }
    }

    return null;
  }
}

export class AnsiDecorationProvider {
  private decorationTypes = new Map<string, vscode.TextEditorDecorationType>();

  // Map ANSI colors to VS Code terminal theme colors
  private ansiColorMap: Record<string, vscode.ThemeColor> = {
    ansi_red: new vscode.ThemeColor("terminal.ansiRed"),
    ansi_green: new vscode.ThemeColor("terminal.ansiGreen"),
    ansi_yellow: new vscode.ThemeColor("terminal.ansiYellow"),
    ansi_blue: new vscode.ThemeColor("terminal.ansiBlue"),
    ansi_magenta: new vscode.ThemeColor("terminal.ansiMagenta"),
    ansi_cyan: new vscode.ThemeColor("terminal.ansiCyan"),
    ansi_white: new vscode.ThemeColor("terminal.ansiWhite"),
  };

  private getOrCreateDecorationType(
    tag: string,
  ): vscode.TextEditorDecorationType {
    if (this.decorationTypes.has(tag)) {
      return this.decorationTypes.get(tag)!;
    }

    let decorationOptions: vscode.DecorationRenderOptions = {};

    // Handle ANSI colors
    if (this.ansiColorMap[tag]) {
      decorationOptions.color = this.ansiColorMap[tag];
    } else if (tag === "ansi_dim") {
      decorationOptions.opacity = "0.5";
    } else if (tag === "ansi_bold") {
      decorationOptions.fontWeight = "bold";
    } else if (tag === "ansi_underline") {
      decorationOptions.textDecoration = "underline";
    }

    const decorationType = vscode.window.createTextEditorDecorationType(
      decorationOptions,
    );
    this.decorationTypes.set(tag, decorationType);
    return decorationType;
  }

  public updateDecorations(editor: vscode.TextEditor): void {
    const ranges = findInput(editor);

    // Group ranges by tag for efficient decoration
    const rangesByTag = new Map<string, vscode.Range[]>();
    for (const tag of this.decorationTypes.keys()) {
      rangesByTag.set(tag, []);
    }

    // Add status ranges
    if (ranges.status) {
      const statusResult = terminal.status();
      for (const highlightRange of statusResult.ranges) {
        this.addRangeToMap(rangesByTag, highlightRange, ranges.status.start);
      }
    }

    // Add output ranges
    if (ranges.output) {
      const outputResult = terminal.output();
      for (const highlightRange of outputResult.ranges) {
        this.addRangeToMap(rangesByTag, highlightRange, ranges.output.start);
      }
    }

    // Apply decorations
    for (const [tag, rangeList] of rangesByTag) {
      const decorationType = this.getOrCreateDecorationType(tag);
      editor.setDecorations(decorationType, rangeList);
    }
  }

  private addRangeToMap(
    rangesByTag: Map<string, vscode.Range[]>,
    highlightRange: HighlightRange,
    basePosition: vscode.Position,
  ): void {
    // Convert relative range to absolute document range
    const absoluteStartLine = basePosition.line +
      highlightRange.range.start.line;
    const absoluteStartChar = highlightRange.range.start.line === 0
      ? basePosition.character + highlightRange.range.start.character
      : highlightRange.range.start.character;
    const absoluteEndLine = basePosition.line + highlightRange.range.end.line;
    const absoluteEndChar = highlightRange.range.end.line === 0
      ? basePosition.character + highlightRange.range.end.character
      : highlightRange.range.end.character;

    const absoluteRange = new vscode.Range(
      absoluteStartLine,
      absoluteStartChar,
      absoluteEndLine,
      absoluteEndChar,
    );

    if (!rangesByTag.has(highlightRange.tag)) {
      rangesByTag.set(highlightRange.tag, []);
    }
    rangesByTag.get(highlightRange.tag)!.push(absoluteRange);
  }

  public dispose(): void {
    for (const decorationType of this.decorationTypes.values()) {
      decorationType.dispose();
    }
    this.decorationTypes.clear();
  }
}

class EphemeralFileSystem implements vscode.FileSystemProvider {
  // In-memory storage for the current session
  private files = new Map<string, Uint8Array>();
  private readonly _emitter = new vscode.EventEmitter<
    vscode.FileChangeEvent[]
  >();
  readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> =
    this._emitter.event;

  static getScheme(): string {
    return "terminal-editor";
  }

  static createUri(path: string): vscode.Uri {
    return vscode.Uri.parse(`"terminal-editor":${path}`);
  }

  watch(
    uri: vscode.Uri,
    options: { recursive: boolean; excludes: string[] },
  ): vscode.Disposable {
    // We don't need to implement watching for ephemeral files
    return new vscode.Disposable(() => {});
  }

  stat(uri: vscode.Uri): vscode.FileStat | Thenable<vscode.FileStat> {
    const data = this.files.get(uri.path);
    if (data) {
      return {
        type: vscode.FileType.File,
        ctime: Date.now(),
        mtime: Date.now(),
        size: data.length,
      };
    }

    // Return a fake stat for any path to make VS Code think the file exists
    return {
      type: vscode.FileType.File,
      ctime: Date.now(),
      mtime: Date.now(),
      size: 0,
    };
  }

  readDirectory(
    uri: vscode.Uri,
  ): [string, vscode.FileType][] | Thenable<[string, vscode.FileType][]> {
    // Not needed for our use case
    return [];
  }

  createDirectory(uri: vscode.Uri): void | Thenable<void> {
    // Not needed for our use case
  }

  readFile(uri: vscode.Uri): Uint8Array | Thenable<Uint8Array> {
    const data = this.files.get(uri.path);
    if (data) {
      return data;
    }

    // Return empty content for any file that doesn't exist
    return new Uint8Array(0);
  }

  writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean },
  ): void | Thenable<void> {
    // "Save" the file in memory but don't persist it anywhere
    this.files.set(uri.path, content);

    // Emit a change event to let VS Code know the file was "saved"
    this._emitter.fire([{
      type: vscode.FileChangeType.Changed,
      uri: uri,
    }]);
  }

  delete(
    uri: vscode.Uri,
    options: { recursive: boolean },
  ): void | Thenable<void> {
    this.files.delete(uri.path);

    this._emitter.fire([{
      type: vscode.FileChangeType.Deleted,
      uri: uri,
    }]);
  }

  rename(
    oldUri: vscode.Uri,
    newUri: vscode.Uri,
    options: { overwrite: boolean },
  ): void | Thenable<void> {
    const data = this.files.get(oldUri.path);
    if (data) {
      this.files.set(newUri.path, data);
      this.files.delete(oldUri.path);
    }

    this._emitter.fire([
      { type: vscode.FileChangeType.Deleted, uri: oldUri },
      { type: vscode.FileChangeType.Created, uri: newUri },
    ]);
  }
}

export function visibleTerminal(): vscode.TextEditor | undefined {
  return vscode.window.visibleTextEditors.find((editor) =>
    editor.document.uri.scheme === "terminal-editor"
  );
}

function findInput(editor: vscode.TextEditor): DocumentRanges {
  const document = editor.document;
  const text = document.getText();
  const lines = text.split("\n");

  // Find the first line that starts with '=' character
  let splitLine = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("=")) {
      splitLine = i;
      break;
    }
  }

  // If no status line found, its just user input
  if (splitLine === lines.length) {
    return {
      command: new vscode.Range(
        document.positionAt(0),
        document.positionAt(document.getText().length),
      ),
      status: undefined,
      output: undefined,
    };
  }

  // The document structure is:
  // - Lines 0 to (splitLine-2): command text
  // - Line (splitLine-1): blank line separating command from status
  // - Line splitLine: status line (starts with '=')
  // - Line (splitLine+1): blank line separating status from output
  // - Lines (splitLine+2) and beyond: output

  // Command range: from start of document to just before the blank line before status
  // The document structure should be:
  // Line 0+: command text (may be multiple lines)
  // Line X: blank line
  // Line X+1: status line (starts with '=')
  // So command ends at the line before the blank line before status

  const commandStart = new vscode.Position(0, 0);
  let commandEndLine: number;
  let commandEndChar: number;

  if (splitLine <= 1) {
    // If status is at line 0 or 1, there's no room for command text
    commandEndLine = 0;
    commandEndChar = 0;
  } else {
    // Command ends at the line before the blank line before status
    // So if status is at line 2, blank line is at 1, command ends at line 0
    commandEndLine = splitLine - 2;
    commandEndChar = commandEndLine < lines.length
      ? lines[commandEndLine].length
      : 0;

    // Make sure we don't go negative
    if (commandEndLine < 0) {
      commandEndLine = 0;
      commandEndChar = 0;
    }
  }

  const commandEnd = new vscode.Position(commandEndLine, commandEndChar);
  const commandRange = new vscode.Range(commandStart, commandEnd);

  // Status range: the line that starts with '='
  const statusStart = new vscode.Position(splitLine, 0);
  const statusEnd = new vscode.Position(splitLine, lines[splitLine].length);
  const statusRange = new vscode.Range(statusStart, statusEnd);

  // Output range: from two lines after status to end of document
  const outputStart = new vscode.Position(splitLine + 2, 0);
  const lastLineIndex = Math.max(0, document.lineCount - 1);
  const lastLineLength = lastLineIndex < lines.length
    ? lines[lastLineIndex].length
    : 0;
  const outputEnd = new vscode.Position(lastLineIndex, lastLineLength);
  const outputRange = new vscode.Range(outputStart, outputEnd);

  const ranges: DocumentRanges = {
    command: commandRange,
    status: statusRange,
    output: outputRange,
  };

  // Assert that ranges cover entire document
  console.assert(
    commandRange.start.line === 0 && commandRange.start.character === 0,
    "Command range should start at document beginning",
  );
  console.assert(
    outputRange.end.line === document.lineCount - 1,
    `Output range should end at document end: got line ${outputRange.end.line}, expected ${
      document.lineCount - 1
    }`,
  );

  return ranges;
}

async function sync(editor: vscode.TextEditor) {
  // If sync is already running, mark that another sync is needed
  if (syncRunning) {
    syncPending = true;
    return;
  }

  syncRunning = true;

  try {
    // Keep syncing until no more syncs are pending
    do {
      syncPending = false;
      await doSync(editor);
    } while (syncPending);
  } finally {
    syncRunning = false;

    // Notify all waiting promises that sync is complete
    const resolvers = syncCompletionResolvers;
    syncCompletionResolvers = [];
    resolvers.forEach((resolve) => resolve());
  }
}

async function doSync(editor: vscode.TextEditor) {
  const document = editor.document;
  const ranges = findInput(editor);

  // If document is empty/unparseable, start with blank line as user input
  if (!ranges.status) {
    const newContent = "\n\n" + terminal.status().text + "\n\n" +
      terminal.output().text;
    await editor.edit((edit) => edit.insert(ranges.command.end, newContent));
    ansiDecorationProvider.updateDecorations(editor);
    return;
  }

  // Extract command from command range
  const command = document.getText(ranges.command).trim();

  // If command is empty, recreate document structure
  if (command === "") {
    const fullRange = new vscode.Range(0, 0, document.lineCount, 0);
    const newContent = "\n\n" + terminal.status().text + "\n\n" +
      terminal.output().text;
    await editor.edit((edit) => edit.replace(fullRange, newContent));
    ansiDecorationProvider.updateDecorations(editor);
    return;
  }

  // Replace everything from the blank line before status to the end
  // This preserves the command text and replaces status + output sections
  const statusResult = terminal.status();
  const outputResult = terminal.output();
  const newContent = "\n" + statusResult.text + "\n\n" + outputResult.text;

  // Replace from the blank line before status to end of document
  // This is equivalent to the original logic: splitLine - 1
  const statusLineIndex = ranges.status.start.line;
  const replaceStart = new vscode.Position(statusLineIndex - 1, 0);
  const replaceRange = new vscode.Range(
    replaceStart,
    document.positionAt(document.getText().length),
  );
  await editor.edit((edit) => edit.replace(replaceRange, newContent));
  ansiDecorationProvider.updateDecorations(editor);
}

async function reveal() {
  // Check if terminal editor already exists and is visible
  const existingEditor = visibleTerminal();

  if (existingEditor) {
    await sync(existingEditor);
    return;
  }

  // Assert that there's zero or one terminal editors
  const allEditors = vscode.workspace.textDocuments.filter((doc) =>
    doc.uri.scheme === "terminal-editor"
  );
  if (allEditors.length > 1) {
    throw new Error("More than one terminal editor found");
  }

  // Create new terminal editor
  const uri = vscode.Uri.parse("terminal-editor:///terminal.terminal");
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(
    document,
    vscode.ViewColumn.Two,
  );

  await sync(editor);

  // Set cursor to first line
  const position = new vscode.Position(0, 0);
  editor.selection = new vscode.Selection(position, position);
}

async function run() {
  const editor = visibleTerminal();
  if (!editor) {
    vscode.window.showErrorMessage("Terminal Editor: No terminal editor found");
    return;
  }

  const ranges = findInput(editor);
  if (!ranges) {
    vscode.window.showErrorMessage("Terminal Editor: No command to run");
    return;
  }

  const command = editor.document.getText(ranges.command).trim();
  if (!command) {
    vscode.window.showErrorMessage("Terminal Editor: No command to run");
    return;
  }

  // Start the process
  terminal.run(command);

  // Save history to VS Code state
  saveHistory();

  // Immediately sync to clear old result
  await sync(editor);
}

async function dwim() {
  // Check if terminal editor already exists and is visible
  const editor = visibleTerminal();

  if (editor) {
    await run();
  } else {
    // Terminal is not revealed, reveal it
    await reveal();
  }
}

async function toggleFold() {
  const editor = visibleTerminal();
  if (!editor) {
    vscode.window.showErrorMessage("Terminal Editor: No terminal editor found");
    return;
  }

  terminal.toggleFold();
}

async function handleTab() {
  const editor = visibleTerminal();
  if (!editor) {
    await vscode.commands.executeCommand("tab");
    return;
  }

  // Check if cursor is on the status line and status contains "..."
  if (shouldToggleFoldOnTab(editor)) {
    terminal.toggleFold();
  } else {
    // Execute default tab behavior
    await vscode.commands.executeCommand("tab");
  }
}

function shouldToggleFoldOnTab(editor: vscode.TextEditor): boolean {
  const position = editor.selection.active;
  const document = editor.document;
  const line = document.lineAt(position.line);

  // Check if current line is the status line (starts with "=" and contains status)
  const isStatusLine = line.text.startsWith("=") && line.text.includes("time:");

  // Check if the actual status line in the document contains "..." (indicating truncated output)
  const hasEllipsis = line.text.includes("...");

  return isStatusLine && hasEllipsis;
}

async function clearHistory() {
  terminal.clearHistory();
  saveHistory();
  vscode.window.showInformationMessage("Terminal Editor: History cleared");
}

export const testing = {
  reset,
  sync: waitForAsyncWork,
  snapshot,
};

async function reset(): Promise<void> {
  // Wait for any ongoing operations to complete
  await waitForAsyncWork();

  // Close any open terminal editors
  const terminalEditors = vscode.workspace.textDocuments.filter(doc =>
    doc.uri.scheme === "terminal-editor"
  );

  for (const doc of terminalEditors) {
    const editor = vscode.window.visibleTextEditors.find(e => e.document === doc);
    if (editor) {
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    }
  }

  // Reset sync state
  syncRunning = false;
  syncPending = false;
  syncCompletionResolvers = [];

  // Recreate decoration provider
  if (ansiDecorationProvider) {
    ansiDecorationProvider.dispose();
  }

  // Clear history in VS Code global state
  if (extensionContext) {
    extensionContext.globalState.update("terminal-editor.history", []);
  }

  // Create new terminal instance with empty history
  const fakeTime = new FakeTimeProvider();
  terminal = new Terminal(
    new VSCodeTerminalSettings(),
    createTerminalEvents(),
    [],
    fakeTime
  );

  ansiDecorationProvider = new AnsiDecorationProvider();
}

async function waitForAsyncWork(): Promise<void> {
  // First wait for any running processes to complete
  if (terminal) {
    await terminal.waitForCompletion();
  }
  
  if (!syncRunning && !syncPending) {
    return;
  }

  return new Promise<void>((resolve) => {
    syncCompletionResolvers.push(resolve);
  });
}

function snapshot(want: string): void {
  const got = captureExtensionState();

  if (got.trim() !== want.trim()) {
    throw new Error(`Snapshot mismatch:\n\nActual:\n${got}\n\nExpected:\n${want}`);
  }
}

function captureExtensionState(): string {
  const editor = visibleTerminal();
  const parts: string[] = [];
  
  // Start with blank line for readability
  parts.push("");
  
  // Editor document text (without prefix)
  if (editor) {
    const documentText = editor.document.getText();
    parts.push(documentText);
  } else {
    parts.push("null");
  }

  // Process status - check if we have a current process and its state
  if (terminal.isRunning()) {
    parts.push(`process: running`);
  } else {
    parts.push(`process: stopped`);
  }

  // Settings values
  const settings = new VSCodeTerminalSettings();
  parts.push(`maxOutputLines: ${settings.maxOutputLines()}`);

  // Command history (last field, one item per line)
  const history = terminal.getHistory();
  if (history.length > 0) {
    for (const command of history) {
      parts.push(`history: ${command}`);
    }
  } else {
    parts.push(`history: (empty)`);
  }

  return parts.join('\n');
}
