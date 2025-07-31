import * as vscode from 'vscode';
import { Terminal } from './model';

let terminal: Terminal;
let terminalEditor: vscode.TextEditor | undefined;

// Test helper function to reset state
export function resetForTesting() {
	terminal = new Terminal();
	terminalEditor = undefined;
}

export function activate(context: vscode.ExtensionContext) {

	console.log('Congratulations, your extension "terminal-editor" is now active!');

	terminal = new Terminal();

	const fileSystemProvider = new EphemeralFileSystem();
	context.subscriptions.push(
		vscode.workspace.registerFileSystemProvider('terminal-editor', fileSystemProvider)
	);

	const revealCommand = vscode.commands.registerCommand('terminal-editor.reveal', reveal);
	const runCommand = vscode.commands.registerCommand('terminal-editor.run', run);
	const dwimCommand = vscode.commands.registerCommand('terminal-editor.dwim', dwim);

	context.subscriptions.push(revealCommand, runCommand, dwimCommand);
}

export function deactivate() { }

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

async function sync() {
	if (!terminalEditor) {
		return;
	}

	const document = terminalEditor.document;
	const text = document.getText();

	// Find where user input ends (look for blank line or end of document)
	const lines = text.split('\n');
	let userInputEnd = 0;

	for (let i = 0; i < lines.length; i++) {
		if (lines[i].trim() === '') {
			userInputEnd = i;
			break;
		}
	}

	// If document is empty, start with blank line as user input
	if (text.trim() === '') {
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

	const startLine = userInputEnd + 1;
	const edit = new vscode.WorkspaceEdit();
	const uri = document.uri;
	const range = new vscode.Range(startLine, 0, document.lineCount, 0);
	edit.replace(uri, range, '\n' + newContent);
	await vscode.workspace.applyEdit(edit);
}

async function reveal() {
	// Check if terminal editor already exists and is visible
	const visibleEditors = vscode.window.visibleTextEditors;
	const existingEditor = visibleEditors.find(editor =>
		editor.document.uri.scheme === 'terminal-editor'
	);

	if (existingEditor) {
		terminalEditor = existingEditor;
		await sync();
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
	terminalEditor = await vscode.window.showTextDocument(document);

	await sync();
}

function run() {
	vscode.window.showInformationMessage('Terminal Editor: Run command executed!');
}

function dwim() {
	vscode.window.showInformationMessage('Terminal Editor: Do What I Mean command executed!');
}
