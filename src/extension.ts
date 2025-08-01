import * as vscode from "vscode";
import {
  HighlightRange,
  Terminal,
  TerminalEvents,
  TerminalSettings,
} from "./model";

let terminal: Terminal;
let syncRunning = false;
export let syncPending = false;
let syncCompletionResolvers: (() => void)[] = [];

class VSCodeTerminalSettings implements TerminalSettings {
  maxOutputLines(): number {
    const config = vscode.workspace.getConfiguration("terminal-editor");
    return config.get<number>("maxOutputLines", 40);
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
  terminal = new Terminal(
    new VSCodeTerminalSettings(),
    createTerminalEvents(),
    getWorkspaceRoot(),
  );
}

// Test helper function to get terminal instance
export function getTerminalForTesting(): Terminal {
  return terminal;
}

// Test helper function to wait for sync to complete
export async function waitForSync(): Promise<void> {
  if (!syncRunning && !syncPending) {
    return;
  }

  return new Promise<void>((resolve) => {
    syncCompletionResolvers.push(resolve);
  });
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

export function activate(context: vscode.ExtensionContext) {
  console.log(
    'Congratulations, your extension "terminal-editor" is now active!',
  );

  terminal = new Terminal(
    new VSCodeTerminalSettings(),
    createTerminalEvents(),
    getWorkspaceRoot(),
  );

  const fileSystemProvider = new EphemeralFileSystem();
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(
      "terminal-editor",
      fileSystemProvider,
    ),
  );

  const semanticTokensProvider = new TerminalSemanticTokensProvider();
  context.subscriptions.push(
    vscode.languages.registerDocumentSemanticTokensProvider(
      { scheme: "terminal-editor" },
      semanticTokensProvider,
      TerminalSemanticTokensProvider.getLegend(),
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

  context.subscriptions.push(
    revealCommand,
    runCommand,
    dwimCommand,
    toggleFoldCommand,
    tabCommand,
  );
}

export function deactivate() {}

export class TerminalSemanticTokensProvider
  implements vscode.DocumentSemanticTokensProvider {
  private static readonly legend = new vscode.SemanticTokensLegend([
    "keyword",
    "operator",
    "string",
    "number",
    "property",
    "variable",
  ]);

  static getLegend(): vscode.SemanticTokensLegend {
    return TerminalSemanticTokensProvider.legend;
  }

  provideDocumentSemanticTokens(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.SemanticTokens> {
    const { splitLine } = findInput({ document } as vscode.TextEditor);
    const statusResult = terminal.status();
    const outputResult = terminal.output();

    const builder = new vscode.SemanticTokensBuilder(
      TerminalSemanticTokensProvider.legend,
    );

    // Add tokens for status line - status starts at splitLine (the line with "=")
    const statusStartOffset = this.getLineStartOffset(document, splitLine);
    this.addTokensFromRanges(
      builder,
      document,
      statusResult.ranges,
      statusStartOffset,
    );

    // Add tokens for output - output starts at splitLine + 2 (status + blank + output)
    const outputStartOffset = this.getLineStartOffset(document, splitLine + 2);
    this.addTokensFromRanges(
      builder,
      document,
      outputResult.ranges,
      outputStartOffset,
    );

    return builder.build();
  }

  private getLineStartOffset(
    document: vscode.TextDocument,
    lineNumber: number,
  ): number {
    if (lineNumber >= document.lineCount) {
      return document.getText().length;
    }
    return document.offsetAt(new vscode.Position(lineNumber, 0));
  }

  private addTokensFromRanges(
    builder: vscode.SemanticTokensBuilder,
    document: vscode.TextDocument,
    ranges: HighlightRange[],
    textStartOffset: number,
  ) {
    for (const range of ranges) {
      // Convert relative range offsets to absolute document offsets
      const absoluteStart = textStartOffset + range.start;
      const absoluteEnd = textStartOffset + range.end;

      // Convert to positions
      const startPos = document.positionAt(absoluteStart);
      const length = range.end - range.start;

      const tokenType = this.mapTagToTokenType(range.tag);
      if (tokenType !== undefined) {
        builder.push(startPos.line, startPos.character, length, tokenType);
      }
    }
  }

  private mapTagToTokenType(tag: string): number | undefined {
    switch (tag) {
      case "keyword":
        return 0; // keyword
      case "punctuation":
        return 1; // operator
      case "time":
        return 3; // number
      case "status_ok":
        return 3; // number
      case "status_err":
        return 3; // number
      case "path":
        return 2; // string
      case "error":
        return 4; // property
      default:
        return undefined;
    }
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

function findInput(
  editor: vscode.TextEditor,
): { command: string; splitLine: number } {
  const document = editor.document;
  const text = document.getText();
  const lines = text.split("\n");

  // Handle completely empty input
  if (text.trim() === "") {
    return { command: "", splitLine: 0 };
  }

  // Find the first line that starts with '=' character
  let splitLine = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("=")) {
      splitLine = i;
      break;
    }
  }

  // Extract user command (everything before the first non-user-input line)
  const userLines = lines.slice(0, splitLine);
  const command = userLines.join("\n").trim();

  return { command, splitLine };
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
  const { command, splitLine } = findInput(editor);

  // If document is empty, start with blank line as user input
  if (command === "") {
    const fullRange = new vscode.Range(0, 0, document.lineCount, 0);
    const newContent = "\n\n" + terminal.status().text + "\n\n" +
      terminal.output().text;
    await editor.edit((edit) => edit.replace(fullRange, newContent));
    return;
  }

  // Replace everything after user input
  const statusResult = terminal.status();
  const outputResult = terminal.output();
  const newContent = "\n" + statusResult.text + "\n\n" + outputResult.text;

  const range = new vscode.Range(
    new vscode.Position(splitLine - 1, 0),
    document.positionAt(document.getText().length),
  );
  await editor.edit((edit) => edit.replace(range, newContent));
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

  const { command } = findInput(editor);
  if (!command.trim()) {
    vscode.window.showErrorMessage("Terminal Editor: No command to run");
    return;
  }

  // Start the process
  terminal.run(command);

  // Immediately sync to clear old result
  await sync(editor);
}

async function dwim() {
  // Check if terminal editor already exists and is visible
  const editor = visibleTerminal();

  if (editor) {
    // Terminal is revealed, check if it's focused
    if (vscode.window.activeTextEditor === editor) {
      // Terminal is focused, run the current command
      await run();
    } else {
      // Terminal is visible but not focused, focus it
      await vscode.window.showTextDocument(
        editor.document,
        vscode.ViewColumn.Two,
      );
    }
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
