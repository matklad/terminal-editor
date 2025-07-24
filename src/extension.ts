import * as vscode from 'vscode';
import { spawn } from 'child_process';

let terminalProvider: TerminalFileSystemProvider | undefined;

class TerminalFileSystemProvider implements vscode.FileSystemProvider {
	private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;

	private content = '';

	watch(uri: vscode.Uri, options: { readonly recursive: boolean; readonly excludes: readonly string[]; }): vscode.Disposable {
		return new vscode.Disposable(() => {});
	}

	stat(uri: vscode.Uri): vscode.FileStat {
		if (uri.path === '/terminal') {
			return {
				type: vscode.FileType.File,
				ctime: Date.now(),
				mtime: Date.now(),
				size: Buffer.byteLength(this.content, 'utf8')
			};
		}
		throw vscode.FileSystemError.FileNotFound(uri);
	}

	readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
		return [];
	}

	createDirectory(uri: vscode.Uri): void {
		// Not implemented
	}

	readFile(uri: vscode.Uri): Uint8Array {
		if (uri.path === '/terminal') {
			return Buffer.from(this.content, 'utf8');
		}
		throw vscode.FileSystemError.FileNotFound(uri);
	}

	writeFile(uri: vscode.Uri, content: Uint8Array, options: { readonly create: boolean; readonly overwrite: boolean; }): void {
		if (uri.path === '/terminal') {
			this.content = Buffer.from(content).toString('utf8');
			this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
		} else {
			throw vscode.FileSystemError.FileNotFound(uri);
		}
	}

	delete(uri: vscode.Uri): void {
		// Not implemented
	}

	rename(oldUri: vscode.Uri, newUri: vscode.Uri): void {
		// Not implemented
	}
	
	appendContent(newContent: string) {
		this.content += newContent;
		const uri = vscode.Uri.parse('terminal-editor:/terminal');
		this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
	}
	
	updateContent(newContent: string) {
		this.content = newContent;
		const uri = vscode.Uri.parse('terminal-editor:/terminal');
		this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
	}
}

class TerminalSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {
	async provideDocumentSemanticTokens(document: vscode.TextDocument): Promise<vscode.SemanticTokens> {
		const tokensBuilder = new vscode.SemanticTokensBuilder();
		
		const text = document.getText();
		const lines = text.split('\n');
		
		const fs = require('fs');
		const path = require('path');
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		
		let lineNumber = 0;
		for (const line of lines) {
			if (line.trim() === '') {
				break; // Stop at first blank line
			}
			
			if (line.trim().length > 0) {
				const parts = line.trim().split(/\s+/);
				let charOffset = 0;
				
				// Find the start of the first non-whitespace character
				const leadingWhitespace = line.match(/^\s*/)?.[0]?.length || 0;
				charOffset = leadingWhitespace;
				
				for (let i = 0; i < parts.length; i++) {
					const part = parts[i];
					
					if (i === 0) {
						// First part is the command - highlight as command
						tokensBuilder.push(lineNumber, charOffset, part.length, 0, 0); // token type 0 = command
					} else {
						// Check if this argument looks like a path
						if (this.looksLikePath(part)) {
							let tokenType = 1; // token type 1 = existing path
							
							// Check if path exists
							if (workspaceRoot) {
								try {
									let fullPath = part;
									if (!path.isAbsolute(part)) {
										fullPath = path.join(workspaceRoot, part);
									}
									
									if (!fs.existsSync(fullPath)) {
										tokenType = 2; // token type 2 = non-existing path
									}
								} catch (error) {
									tokenType = 2; // Treat as non-existing if we can't check
								}
							}
							
							tokensBuilder.push(lineNumber, charOffset, part.length, tokenType, 0);
						} else {
							// Regular argument
							tokensBuilder.push(lineNumber, charOffset, part.length, 3, 0); // token type 3 = argument
						}
					}
					
					charOffset += part.length;
					
					// Skip whitespace to next part
					if (i < parts.length - 1) {
						const remainingLine = line.substring(charOffset);
						const nextWhitespace = remainingLine.match(/^\s+/)?.[0]?.length || 0;
						charOffset += nextWhitespace;
					}
				}
			}
			lineNumber++;
		}
		
		return tokensBuilder.build();
	}
	
	private looksLikePath(arg: string): boolean {
		// Consider something a path if it:
		// - Contains a slash
		// - Starts with . or ..
		// - Ends with common file extensions
		// - Contains path-like patterns
		return arg.includes('/') || 
			   arg.startsWith('.') || 
			   /\.(js|ts|json|md|txt|py|java|c|cpp|h|html|css|xml|yml|yaml)$/i.test(arg) ||
			   arg.includes('\\'); // Windows paths
	}
}

class TerminalCompletionProvider implements vscode.CompletionItemProvider {
	async provideCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		token: vscode.CancellationToken,
		context: vscode.CompletionContext
	): Promise<vscode.CompletionItem[]> {
		const completions: vscode.CompletionItem[] = [];
		
		// Get the current line and word being typed
		const line = document.lineAt(position.line);
		const wordRange = document.getWordRangeAtPosition(position, /[^\s]+/);
		const word = wordRange ? document.getText(wordRange) : '';
		
		// Only provide completions for command arguments (not the first word)
		const lineStart = line.text.substring(0, position.character);
		const parts = lineStart.trim().split(/\s+/);
		if (parts.length <= 1) {
			return completions; // Don't complete the command itself
		}
		
		try {
			const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			if (!workspaceRoot) {
				return completions;
			}
			
			const fs = require('fs');
			const path = require('path');
			
			// Determine the directory to search in
			let searchDir = workspaceRoot;
			let prefix = word;
			
			if (word.includes('/')) {
				const lastSlash = word.lastIndexOf('/');
				const dirPart = word.substring(0, lastSlash);
				prefix = word.substring(lastSlash + 1);
				
				// Handle relative paths
				if (dirPart.startsWith('./')) {
					searchDir = path.join(workspaceRoot, dirPart.substring(2));
				} else if (dirPart.startsWith('/')) {
					searchDir = dirPart;
				} else {
					searchDir = path.join(workspaceRoot, dirPart);
				}
			}
			
			// Check if directory exists
			if (!fs.existsSync(searchDir)) {
				return completions;
			}
			
			// Read directory contents
			const entries = fs.readdirSync(searchDir, { withFileTypes: true });
			
			for (const entry of entries) {
				if (entry.name.startsWith(prefix) || prefix === '') {
					const completion = new vscode.CompletionItem(
						entry.name,
						entry.isDirectory() ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.File
					);
					
					// For directories, add trailing slash
					if (entry.isDirectory()) {
						completion.insertText = entry.name + '/';
					}
					
					completions.push(completion);
				}
			}
		} catch (error) {
			// Ignore errors and return empty completions
		}
		
		return completions;
	}
}

export function activate(context: vscode.ExtensionContext) {
	terminalProvider = new TerminalFileSystemProvider();
	
	// Register the file system provider to enable editing
	let disposableProvider = vscode.workspace.registerFileSystemProvider('terminal-editor', terminalProvider);
	
	// Register semantic tokens provider for syntax highlighting
	const legend = new vscode.SemanticTokensLegend(
		['command', 'existingPath', 'nonExistingPath', 'argument'], 
		['bold']
	);
	const semanticProvider = new TerminalSemanticTokensProvider();
	let disposableSemanticProvider = vscode.languages.registerDocumentSemanticTokensProvider(
		{ scheme: 'terminal-editor' }, 
		semanticProvider, 
		legend
	);
	
	// Register completion provider for path completion
	const completionProvider = new TerminalCompletionProvider();
	let disposableCompletionProvider = vscode.languages.registerCompletionItemProvider(
		{ scheme: 'terminal-editor' },
		completionProvider,
		'/', '.' // Trigger completion on / and .
	);
	
	let disposable = vscode.commands.registerCommand('terminal-editor.reveal', async () => {
		const terminalUri = vscode.Uri.parse('terminal-editor:/terminal');
		
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
		const terminalUri = vscode.Uri.parse('terminal-editor:/terminal');
		if (activeEditor.document.uri.toString() !== terminalUri.toString()) {
			vscode.window.showErrorMessage('Execute command can only be run from terminal editor');
			return;
		}

		const content = activeEditor.document.getText();
		const lines = content.split('\n');
		
		// Find the first blank line to determine command boundary
		let commandLines: string[] = [];
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].trim() === '') {
				break;
			}
			commandLines.push(lines[i]);
		}
		
		if (commandLines.length === 0 || commandLines.join('').trim() === '') {
			vscode.window.showErrorMessage('No command to execute');
			return;
		}

		// Join all command lines with spaces (multiline commands)
		const commandLine = commandLines.join(' ').trim();
		const commandParts = commandLine.split(/\s+/);
		const command = commandParts[0];
		const args = commandParts.slice(1);

		// Clear any previous output and prepare for new command execution
		if (terminalProvider) {
			// Clear everything after the command lines, keeping only the command
			const newContent = commandLines.join('\n') + '\n\n';
			terminalProvider.updateContent(newContent);
			
			// Use workspace root as current working directory
			const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			
			const process = spawn(command, args, { 
				stdio: ['pipe', 'pipe', 'pipe'],
				shell: false,
				cwd: workspaceRoot
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

	context.subscriptions.push(disposableProvider, disposableSemanticProvider, disposableCompletionProvider, disposable, executeDisposable);
}

export function deactivate() {}