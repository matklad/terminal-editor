import * as vscode from 'vscode';
import { spawn } from 'child_process';

let terminalProvider: TerminalFileSystemProvider | undefined;
let promptDecorationType: vscode.TextEditorDecorationType | undefined;

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
	
	getContent(): string {
		return this.content;
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
		let inCommandSection = true;
		
		for (const line of lines) {
			if (inCommandSection && line.trim() === '') {
				inCommandSection = false; // Switch to output section after first blank line
				lineNumber++;
				continue;
			}
			
			if (line.trim().length > 0) {
				if (inCommandSection) {
					// Process command lines
					const parts = line.trim().split(/\s+/);
					let charOffset = 0;
					
					// Find the start of the first non-whitespace character
					const leadingWhitespace = line.match(/^\s*/)?.[0]?.length || 0;
					charOffset = leadingWhitespace;
					
					for (let i = 0; i < parts.length; i++) {
						const part = parts[i];
						
						if (i === 0) {
							// First part is the command - highlight as function with bold modifier
							tokensBuilder.push(lineNumber, charOffset, part.length, 0, 1); // token type 0 = function, modifier 1 = bold
						} else {
							// Check if this argument looks like a path
							if (this.looksLikePath(part)) {
								let tokenType = 1; // token type 1 = variable (existing path)
								
								// Check if path exists
								if (workspaceRoot) {
									try {
										let fullPath = part;
										if (!path.isAbsolute(part)) {
											fullPath = path.join(workspaceRoot, part);
										}
										
										if (!fs.existsSync(fullPath)) {
											tokenType = 2; // token type 2 = string (non-existing path)
										}
									} catch (error) {
										tokenType = 2; // Treat as non-existing if we can't check
									}
								}
								
								tokensBuilder.push(lineNumber, charOffset, part.length, tokenType, 0);
							} else {
								// Regular argument - highlight as parameter
								tokensBuilder.push(lineNumber, charOffset, part.length, 3, 0); // token type 3 = parameter
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
				} else {
					// Process output lines - look for error patterns first, then timing information
					// Check if this line matches timing patterns first to avoid conflicts
					if (this.isTimingLine(line)) {
						this.highlightTimingInLine(line, lineNumber, tokensBuilder);
					} else {
						this.highlightErrorsInLine(line, lineNumber, tokensBuilder, workspaceRoot);
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
	
	private highlightErrorsInLine(line: string, lineNumber: number, tokensBuilder: vscode.SemanticTokensBuilder, workspaceRoot?: string): void {
		// Look for error patterns like: /path/to/file.ext:line:col: error: message
		// Also handle patterns like: file.ext:line:col: error: message  
		// And: Error in file.ext at line line, column col
		
		const errorPatterns = [
			// Pattern: /path/to/file.ext:123:45: error: message
			/([^\s:]+\.[a-zA-Z0-9]+):(\d+):(\d+):\s*(error|warning|note):/g,
			// Pattern: file.ext:123:45: error: message (relative path)
			/([a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+):(\d+):(\d+):\s*(error|warning|note):/g,
			// Pattern: Error in file.ext
			/(Error|WARNING|Note)\s+in\s+([^\s:]+\.[a-zA-Z0-9]+)/g
		];
		
		for (const pattern of errorPatterns) {
			let match;
			pattern.lastIndex = 0; // Reset regex state
			
			while ((match = pattern.exec(line)) !== null) {
				const fullMatch = match[0];
				const filePath = match[1] || match[2]; // Different capture groups for different patterns
				const startPos = match.index;
				
				if (filePath) {
					// Highlight the file path part as property with bold modifier
					const filePathStart = line.indexOf(filePath, startPos);
					if (filePathStart !== -1) {
						tokensBuilder.push(lineNumber, filePathStart, filePath.length, 4, 1); // token type 4 = property, modifier 1 = bold
					}
					
					// Highlight the error keyword as keyword with italic modifier
					const errorKeywords = ['error', 'warning', 'note', 'Error', 'WARNING', 'Note'];
					for (const keyword of errorKeywords) {
						const keywordIndex = line.indexOf(keyword, startPos);
						if (keywordIndex !== -1 && keywordIndex < startPos + fullMatch.length) {
							tokensBuilder.push(lineNumber, keywordIndex, keyword.length, 5, 2); // token type 5 = keyword, modifier 2 = italic
							break;
						}
					}
				}
			}
		}
	}
	
	private isTimingLine(line: string): boolean {
		const trimmedLine = line.trim();
		const timingPatterns = [
			// Pattern: exit code + time (e.g., "0 3s", "1 1m 30s")
			/^(\d+)\s+((?:\d+h\s*)?(?:\d+m\s*)?(?:\d+s))$/,
			// Pattern: just time (e.g., "1h 2m 3s", "5m 30s", "42s")
			/^((?:\d+h\s*)?(?:\d+m\s*)?(?:\d+s))$/,
			// Pattern: "Running..."
			/^(Running\.\.\.)$/
		];
		
		return timingPatterns.some(pattern => pattern.test(trimmedLine));
	}

	private highlightTimingInLine(line: string, lineNumber: number, tokensBuilder: vscode.SemanticTokensBuilder): void {
		// Look for timing patterns like: "1h 2m 3s", "5m 30s", "42s", "Running..."
		// And exit code patterns like: "0 3s", "1 1m 30s"
		
		const timingPatterns = [
			// Pattern: exit code + time (e.g., "0 3s", "1 1m 30s")
			/^(\d+)\s+((?:\d+h\s*)?(?:\d+m\s*)?(?:\d+s))$/,
			// Pattern: just time (e.g., "1h 2m 3s", "5m 30s", "42s")
			/^((?:\d+h\s*)?(?:\d+m\s*)?(?:\d+s))$/,
			// Pattern: "Running..."
			/^(Running\.\.\.)$/
		];
		
		for (const pattern of timingPatterns) {
			const match = pattern.exec(line.trim());
			if (match) {
				const fullMatch = match[0];
				const startPos = line.indexOf(fullMatch);
				
				if (startPos !== -1) {
					if (match[2]) {
						// Exit code + time pattern
						const exitCode = match[1];
						const timeStr = match[2];
						const exitCodeStart = startPos + line.substring(startPos).indexOf(exitCode);
						const timeStart = startPos + line.substring(startPos).indexOf(timeStr);
						
						// Highlight exit code as number
						tokensBuilder.push(lineNumber, exitCodeStart, exitCode.length, 0, 0); // function type for exit code
						// Highlight time as string with italic
						tokensBuilder.push(lineNumber, timeStart, timeStr.length, 2, 2); // string type with italic modifier
					} else if (match[1].includes('h') || match[1].includes('m') || match[1].includes('s')) {
						// Time-only pattern
						const timeStr = match[1];
						const timeStart = startPos + line.substring(startPos).indexOf(timeStr);
						tokensBuilder.push(lineNumber, timeStart, timeStr.length, 2, 2); // string type with italic modifier
					} else if (match[1] === 'Running...') {
						// Running status
						const runningStr = match[1];
						const runningStart = startPos + line.substring(startPos).indexOf(runningStr);
						tokensBuilder.push(lineNumber, runningStart, runningStr.length, 5, 2); // keyword type with italic modifier
					}
				}
				break; // Only match the first pattern
			}
		}
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

class TerminalDefinitionProvider implements vscode.DefinitionProvider {
	provideDefinition(
		document: vscode.TextDocument,
		position: vscode.Position,
		token: vscode.CancellationToken
	): vscode.ProviderResult<vscode.Definition> {
		const line = document.lineAt(position.line);
		const lineText = line.text;
		
		// Check if we're in an error message with file path
		const errorPatterns = [
			// Pattern: /path/to/file.ext:123:45: error: message
			/([^\s:]+\.[a-zA-Z0-9]+):(\d+):(\d+):\s*(error|warning|note):/g,
			// Pattern: file.ext:123:45: error: message (relative path)
			/([a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+):(\d+):(\d+):\s*(error|warning|note):/g,
			// Pattern: Error in file.ext
			/(Error|WARNING|Note)\s+in\s+([^\s:]+\.[a-zA-Z0-9]+)/g
		];
		
		for (const pattern of errorPatterns) {
			let match;
			pattern.lastIndex = 0; // Reset regex state
			
			while ((match = pattern.exec(lineText)) !== null) {
				let filePath: string;
				let lineNum = 1;
				let colNum = 1;
				
				// Handle different pattern types
				if (match[2] && !isNaN(parseInt(match[2], 10))) {
					// Patterns with line:col format
					filePath = match[1];
					lineNum = parseInt(match[2], 10);
					colNum = match[3] ? parseInt(match[3], 10) : 1;
				} else {
					// "Error in file.ext" pattern
					filePath = match[2] || match[1];
				}
				
				const startPos = match.index;
				const endPos = startPos + match[0].length;
				
				// Check if the cursor is within this error message
				if (position.character >= startPos && position.character <= endPos) {
					const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
					if (workspaceRoot) {
						const path = require('path');
						let fullPath = filePath;
						
						// Handle relative paths
						if (!path.isAbsolute(filePath)) {
							fullPath = path.join(workspaceRoot, filePath);
						}
						
						try {
							const fs = require('fs');
							if (fs.existsSync(fullPath)) {
								const targetUri = vscode.Uri.file(fullPath);
								const targetPosition = new vscode.Position(Math.max(0, lineNum - 1), Math.max(0, colNum - 1));
								return new vscode.Location(targetUri, targetPosition);
							}
						} catch (error) {
							// File doesn't exist or can't be accessed
						}
					}
				}
			}
		}
		
		return undefined;
	}
}

function updatePromptDecorations(editor: vscode.TextEditor) {
	if (!promptDecorationType || editor.document.uri.scheme !== 'terminal-editor') {
		return;
	}
	
	const decorations: vscode.DecorationOptions[] = [];
	const text = editor.document.getText();
	const lines = text.split('\n');
	
	// Find command lines (before first blank line)
	let lineNumber = 0;
	for (const line of lines) {
		if (line.trim() === '') {
			break; // Stop at first blank line
		}
		
		// Add decoration for this command line
		const range = new vscode.Range(lineNumber, 0, lineNumber, line.length);
		decorations.push({ range });
		lineNumber++;
	}
	
	// If no command lines but the document is empty or has only one line, highlight the first line
	if (decorations.length === 0 && lines.length <= 2) {
		const range = new vscode.Range(0, 0, 0, lines[0]?.length || 0);
		decorations.push({ range });
	}
	
	editor.setDecorations(promptDecorationType, decorations);
}

export function activate(context: vscode.ExtensionContext) {
	terminalProvider = new TerminalFileSystemProvider();
	
	// Create decoration type for prompt background highlighting
	promptDecorationType = vscode.window.createTextEditorDecorationType({
		backgroundColor: new vscode.ThemeColor('editor.lineHighlightBackground'),
		isWholeLine: true
	});
	
	// Register the file system provider to enable editing
	let disposableProvider = vscode.workspace.registerFileSystemProvider('terminal-editor', terminalProvider);
	
	// Register semantic tokens provider for syntax highlighting
	// Using standard semantic token types that work well with most themes
	const legend = new vscode.SemanticTokensLegend(
		['function', 'variable', 'string', 'parameter', 'property', 'keyword'], 
		['bold', 'italic']
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
	
	// Register definition provider for goto definition on error paths
	const definitionProvider = new TerminalDefinitionProvider();
	let disposableDefinitionProvider = vscode.languages.registerDefinitionProvider(
		{ scheme: 'terminal-editor' },
		definitionProvider
	);
	
	// Register event listeners for prompt highlighting
	let disposableActiveEditorChange = vscode.window.onDidChangeActiveTextEditor(editor => {
		if (editor) {
			updatePromptDecorations(editor);
		}
	});
	
	let disposableTextDocumentChange = vscode.workspace.onDidChangeTextDocument(event => {
		if (event.document.uri.scheme === 'terminal-editor') {
			const editor = vscode.window.visibleTextEditors.find(e => e.document === event.document);
			if (editor) {
				updatePromptDecorations(editor);
			}
		}
	});
	
	// Update decorations for any already open terminal editors
	vscode.window.visibleTextEditors.forEach(editor => {
		if (editor.document.uri.scheme === 'terminal-editor') {
			updatePromptDecorations(editor);
		}
	});
	
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
		
		if (activeEditor && activeEditor.viewColumn === vscode.ViewColumn.One) {
			// Move the active editor to the right pane to make room for terminal on the left
			await vscode.window.showTextDocument(activeEditor.document, {
				viewColumn: vscode.ViewColumn.Two,
				preserveFocus: true
			});
		}
		
		// Always open terminal in the left pane (column one)
		const doc = await vscode.workspace.openTextDocument(terminalUri);
		const editor = await vscode.window.showTextDocument(doc, {
			viewColumn: vscode.ViewColumn.One,
			preserveFocus: false
		});
		
		// Update prompt decorations for the newly opened terminal
		updatePromptDecorations(editor);
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
			
			// Use workspace root as current working directory, fallback to process.cwd() for tests
			const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
			
			// Track timing for the command execution
			const startTime = Date.now();
			let timingInterval: NodeJS.Timeout | undefined;
			
			// Add initial timing line
			terminalProvider.appendContent('\nRunning...\n');
			
			const childProcess = spawn(command, args, { 
				stdio: ['pipe', 'pipe', 'pipe'],
				shell: false,
				cwd: workspaceRoot
			});
			
			let stdoutBuffer = '';
			let stderrBuffer = '';
			
			// Function to format elapsed time
			const formatElapsedTime = (milliseconds: number): string => {
				const seconds = Math.floor(milliseconds / 1000);
				const minutes = Math.floor(seconds / 60);
				const hours = Math.floor(minutes / 60);
				
				const s = seconds % 60;
				const m = minutes % 60;
				const h = hours;
				
				if (h > 0) {
					return `${h}h ${m}m ${s}s`;
				} else if (m > 0) {
					return `${m}m ${s}s`;
				} else {
					return `${s}s`;
				}
			};
			
			// Update timing every second
			timingInterval = setInterval(() => {
				const elapsed = Date.now() - startTime;
				const timeStr = formatElapsedTime(elapsed);
				
				// Update the last line with current timing
				const currentContent = terminalProvider!.getContent();
				const lines = currentContent.split('\n');
				
				// Find and replace the "Running..." line or the last timing line
				for (let i = lines.length - 1; i >= 0; i--) {
					if (lines[i].startsWith('Running...') || /^\d+[hms]/.test(lines[i])) {
						lines[i] = timeStr;
						break;
					}
				}
				
				terminalProvider!.updateContent(lines.join('\n'));
			}, 1000);

			childProcess.stdout.on('data', (data: Buffer) => {
				stdoutBuffer += data.toString();
				terminalProvider!.appendContent(data.toString());
			});

			childProcess.stderr.on('data', (data: Buffer) => {
				stderrBuffer += data.toString();
			});

			childProcess.on('close', (code) => {
				// Clear the timing interval
				if (timingInterval) {
					clearInterval(timingInterval);
				}
				
				// Add stderr output if any
				if (stderrBuffer) {
					terminalProvider!.appendContent(stderrBuffer);
				}
				
				// Calculate final elapsed time and add exit code line
				const elapsed = Date.now() - startTime;
				const timeStr = formatElapsedTime(elapsed);
				const exitLine = `${code || 0} ${timeStr}\n`;
				
				// Replace the last timing line with the final exit code and time
				const currentContent = terminalProvider!.getContent();
				const lines = currentContent.split('\n');
				
				// Find and replace the last timing line
				for (let i = lines.length - 1; i >= 0; i--) {
					if (/^\d+[hms]/.test(lines[i]) || lines[i].startsWith('Running...')) {
						lines[i] = exitLine.trim();
						break;
					}
				}
				
				terminalProvider!.updateContent(lines.join('\n'));
			});

			childProcess.on('error', (error) => {
				// Clear the timing interval on error
				if (timingInterval) {
					clearInterval(timingInterval);
				}
				
				terminalProvider!.appendContent(`Error: ${error.message}\n`);
				
				// Add error exit code
				const elapsed = Date.now() - startTime;
				const timeStr = formatElapsedTime(elapsed);
				const exitLine = `1 ${timeStr}\n`;
				terminalProvider!.appendContent(exitLine);
			});
		}
	});

	context.subscriptions.push(
		disposableProvider, 
		disposableSemanticProvider, 
		disposableCompletionProvider, 
		disposableDefinitionProvider, 
		disposableActiveEditorChange,
		disposableTextDocumentChange,
		disposable, 
		executeDisposable
	);
}

export function deactivate() {
	if (promptDecorationType) {
		promptDecorationType.dispose();
		promptDecorationType = undefined;
	}
}