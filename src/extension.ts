import * as vscode from 'vscode';
import { spawn } from 'child_process';

let terminalProvider: TerminalProvider | undefined;

class TerminalProvider implements vscode.TextDocumentContentProvider {
	private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidChange = this._onDidChange.event;

	private content = 'echo hello world';

	provideTextDocumentContent(uri: vscode.Uri): string {
		return this.content;
	}

	updateContent(newContent: string) {
		this.content = newContent;
		this._onDidChange.fire(vscode.Uri.parse('terminal-editor:terminal'));
	}

	appendContent(newContent: string) {
		this.content += newContent;
		this._onDidChange.fire(vscode.Uri.parse('terminal-editor:terminal'));
	}
}

export function activate(context: vscode.ExtensionContext) {
	terminalProvider = new TerminalProvider();
	
	let disposableProvider = vscode.workspace.registerTextDocumentContentProvider('terminal-editor', terminalProvider);
	
	let disposable = vscode.commands.registerCommand('terminal-editor.reveal', async () => {
		const terminalUri = vscode.Uri.parse('terminal-editor:terminal');
		
		// Check if the terminal is already open
		const existingEditor = vscode.window.visibleTextEditors.find(editor => 
			editor.document.uri.toString() === terminalUri.toString()
		);
		
		if (existingEditor) {
			// Terminal already open, just focus it
			await vscode.window.showTextDocument(existingEditor.document, existingEditor.viewColumn);
			return;
		}

		// Check if we have an active editor to determine splitting
		const activeEditor = vscode.window.activeTextEditor;
		let viewColumn = vscode.ViewColumn.Two;
		
		if (!activeEditor) {
			// No active editor, open in first column and then split
			viewColumn = vscode.ViewColumn.One;
		}
		
		// Open the terminal document
		const doc = await vscode.workspace.openTextDocument(terminalUri);
		await vscode.window.showTextDocument(doc, {
			viewColumn: viewColumn,
			preserveFocus: false
		});
	});

	let executeDisposable = vscode.commands.registerCommand('terminal-editor.execute', async () => {
		const activeEditor = vscode.window.activeTextEditor;
		if (!activeEditor) {
			vscode.window.showErrorMessage('No active editor');
			return;
		}

		// Check if this is the terminal editor
		const terminalUri = vscode.Uri.parse('terminal-editor:terminal');
		if (activeEditor.document.uri.toString() !== terminalUri.toString()) {
			vscode.window.showErrorMessage('Execute command can only be run from terminal editor');
			return;
		}

		const content = activeEditor.document.getText();
		const lines = content.split('\n');
		
		if (lines.length === 0 || !lines[0].trim()) {
			vscode.window.showErrorMessage('No command to execute');
			return;
		}

		const commandLine = lines[0].trim();
		const commandParts = commandLine.split(/\s+/);
		const command = commandParts[0];
		const args = commandParts.slice(1);

		// Append the command output to terminal
		if (terminalProvider) {
			terminalProvider.appendContent('\n\n');
			
			const process = spawn(command, args, { 
				stdio: ['pipe', 'pipe', 'pipe'],
				shell: false
			});

			let stdoutBuffer = '';
			let stderrBuffer = '';

			process.stdout.on('data', (data: Buffer) => {
				stdoutBuffer += data.toString();
				terminalProvider!.appendContent(data.toString());
			});

			process.stderr.on('data', (data: Buffer) => {
				stderrBuffer += data.toString();
			});

			process.on('close', (code) => {
				if (stderrBuffer) {
					terminalProvider!.appendContent(stderrBuffer);
				}
			});

			process.on('error', (error) => {
				terminalProvider!.appendContent(`Error: ${error.message}\n`);
			});
		}
	});

	context.subscriptions.push(disposableProvider, disposable, executeDisposable);
}

export function deactivate() {}