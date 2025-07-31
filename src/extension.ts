import * as vscode from 'vscode';
import { Terminal, TerminalSettings, TerminalEvents } from './model';

let terminal: Terminal;
let runtimeUpdateInterval: NodeJS.Timeout | undefined;

class VSCodeTerminalSettings implements TerminalSettings {
	maxOutputLines(): number {
		const config = vscode.workspace.getConfiguration('terminal-editor');
		return config.get<number>('maxOutputLines', 50);
	}
}

// Test helper function to reset state
export function resetForTesting() {
	if (runtimeUpdateInterval) {
		clearInterval(runtimeUpdateInterval);
		runtimeUpdateInterval = undefined;
	}
	terminal = new Terminal(new VSCodeTerminalSettings(), createTerminalEvents());
}

// Test helper function to get terminal instance
export function getTerminalForTesting(): Terminal {
	return terminal;
}

function createTerminalEvents(): TerminalEvents {
	return {
		onOutput: () => {
			const editor = visibleTerminal();
			if (editor) {
				sync(editor);
			}
		},
		onStateChange: () => {
			const editor = visibleTerminal();
			if (editor) {
				sync(editor);
			}
		}
	};
}

export function activate(context: vscode.ExtensionContext) {

	console.log('Congratulations, your extension "terminal-editor" is now active!');

	terminal = new Terminal(new VSCodeTerminalSettings(), createTerminalEvents());

	const fileSystemProvider = new EphemeralFileSystem();
	context.subscriptions.push(
		vscode.workspace.registerFileSystemProvider('terminal-editor', fileSystemProvider)
	);

	const revealCommand = vscode.commands.registerCommand('terminal-editor.reveal', reveal);
	const runCommand = vscode.commands.registerCommand('terminal-editor.run', run);
	const dwimCommand = vscode.commands.registerCommand('terminal-editor.dwim', dwim);

	context.subscriptions.push(revealCommand, runCommand, dwimCommand);
}

export function deactivate() {
	if (runtimeUpdateInterval) {
		clearInterval(runtimeUpdateInterval);
		runtimeUpdateInterval = undefined;
	}
}

class EphemeralFileSystem implements vscode.FileSystemProvider {
	readonly onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>().event;

	watch(): vscode.Disposable {
		return new vscode.Disposable(() => {});
	}

	stat(): vscode.FileStat {
		return {
			type: vscode.FileType.File,
			ctime: Date.now(),
			mtime: Date.now(),
			size: 0
		};
	}

	readDirectory(): [string, vscode.FileType][] {
		return [];
	}

	createDirectory(): void {}

	readFile(): Uint8Array {
		return new Uint8Array();
	}

	writeFile(): void {}

	delete(): void {}

	rename(): void {}
}

function visibleTerminal(): vscode.TextEditor | undefined {
	return vscode.window.visibleTextEditors.find(editor =>
		editor.document.uri.scheme === 'terminal-editor'
	);
}

function findInput(editor: vscode.TextEditor): { command: string; splitLine: number } {
	const document = editor.document;
	const text = document.getText();
	const lines = text.split('\n');

	// Handle completely empty input
	if (text.trim() === '') {
		return { command: '', splitLine: 0 };
	}

	// Find the first line that starts with '=' character
	let splitLine = lines.length;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].startsWith('=')) {
			splitLine = i;
			break;
		}
	}

	// Extract user command (everything before the first non-user-input line)
	const userLines = lines.slice(0, splitLine);
	const command = userLines.join('\n').trim();

	return { command, splitLine };
}

async function sync(editor: vscode.TextEditor) {
	const document = editor.document;
	const { command, splitLine } = findInput(editor);

	// If document is empty, start with blank line as user input
	if (command === '') {
		const edit = new vscode.WorkspaceEdit();
		const uri = document.uri;
		const fullRange = new vscode.Range(0, 0, document.lineCount, 0);
		const newContent = '\n\n' + terminal.status().text + '\n\n' + terminal.output().text;
		edit.replace(uri, fullRange, newContent);
		await vscode.workspace.applyEdit(edit);
		return;
	}

	// Replace everything after user input
	const statusText = terminal.status().text;
	const outputText = terminal.output().text;
	const newContent = statusText + '\n\n' + outputText;

	const edit = new vscode.WorkspaceEdit();
	const uri = document.uri;
	const range = new vscode.Range(splitLine, 0, document.lineCount, 0);
	edit.replace(uri, range, '\n' + newContent);
	await vscode.workspace.applyEdit(edit);
}

async function reveal() {
	// Check if terminal editor already exists and is visible
	const existingEditor = visibleTerminal();

	if (existingEditor) {
		await sync(existingEditor);
		return;
	}

	// Assert that there's zero or one terminal editors
	const allEditors = vscode.workspace.textDocuments.filter(doc =>
		doc.uri.scheme === 'terminal-editor'
	);
	if (allEditors.length > 1) {
		throw new Error('More than one terminal editor found');
	}

	// Create new terminal editor
	const uri = vscode.Uri.parse('terminal-editor:///terminal.terminal');
	const document = await vscode.workspace.openTextDocument(uri);
	const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.Two);

	await sync(editor);

	// Set cursor to first line
	const position = new vscode.Position(0, 0);
	editor.selection = new vscode.Selection(position, position);
}

async function run() {
	const editor = visibleTerminal();
	if (!editor) {
		vscode.window.showErrorMessage('Terminal Editor: No terminal editor found');
		return;
	}

	const { command } = findInput(editor);
	if (!command.trim()) {
		vscode.window.showErrorMessage('Terminal Editor: No command to run');
		return;
	}

	// Clear runtime update interval if running
	if (runtimeUpdateInterval) {
		clearInterval(runtimeUpdateInterval);
		runtimeUpdateInterval = undefined;
	}

	// Start the process
	terminal.run(command);

	// Immediately sync to clear old result
	await sync(editor);

	// Set up runtime update interval while command is running
	runtimeUpdateInterval = setInterval(async () => {
		if (!terminal.isRunning()) {
			if (runtimeUpdateInterval) {
				clearInterval(runtimeUpdateInterval);
				runtimeUpdateInterval = undefined;
			}
			return;
		}

		const currentEditor = visibleTerminal();
		if (currentEditor) {
			await sync(currentEditor);
		}
	}, 1000);
}

async function dwim() {
	// Check if terminal editor already exists and is visible
	const editor = visibleTerminal();

	if (editor) {
		// Terminal is revealed, focus it if not already focused
		if (vscode.window.activeTextEditor !== editor) {
			await vscode.window.showTextDocument(editor.document, vscode.ViewColumn.Two);
		}
	} else {
		// Terminal is not revealed, reveal it
		await reveal();
	}
}
