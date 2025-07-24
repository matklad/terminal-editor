import * as vscode from 'vscode';
import { spawn } from 'child_process';

let terminalProvider: TerminalFileSystemProvider | undefined;
let promptDecorationType: vscode.TextEditorDecorationType | undefined;
let autosuggestionDecorationType: vscode.TextEditorDecorationType | undefined;
let commandHistory: string[] = [];

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
					// Process output lines - look for timing, error patterns, and general paths
					// Check if this line matches timing patterns first to avoid conflicts
					if (this.isTimingLine(line)) {
						this.highlightTimingInLine(line, lineNumber, tokensBuilder);
					} else {
						// First highlight general paths in the line
						this.highlightPathsInLine(line, lineNumber, tokensBuilder, workspaceRoot);
						// Then highlight error patterns (which may overlap but will take precedence)
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
	
	private highlightPathsInLine(line: string, lineNumber: number, tokensBuilder: vscode.SemanticTokensBuilder, workspaceRoot?: string): void {
		// Look for any path-like strings in the line
		const fs = require('fs');
		const path = require('path');
		
		// Pattern to match potential file paths with optional line:column syntax
		const pathPatterns = [
			// Absolute paths like /path/to/file.ext:123:45 or /path/to/file.ext
			/([\/\\][\w\-\.\/\\]+\.[a-zA-Z0-9]+)(?::(\d+)(?::(\d+))?)?/g,
			// Relative paths like ./path/to/file.ext:123:45 or src/file.ext:123
			/(\.[\/\\][\w\-\.\/\\]*\.[a-zA-Z0-9]+|[\w\-]+[\/\\][\w\-\.\/\\]*\.[a-zA-Z0-9]+)(?::(\d+)(?::(\d+))?)?/g,
			// Simple filenames with extensions like file.ext:123:45
			/([\w\-]+\.[a-zA-Z0-9]+)(?::(\d+)(?::(\d+))?)?/g
		];
		
		for (const pattern of pathPatterns) {
			let match;
			pattern.lastIndex = 0; // Reset regex state
			
			while ((match = pattern.exec(line)) !== null) {
				const pathStr = match[1];
				const lineNum = match[2];
				const colNum = match[3];
				const startPos = match.index;
				const fullMatchLength = match[0].length;
				
				if (pathStr && pathStr.length > 2) { // Avoid very short matches
					// Check if this looks like a real file path
					if (this.looksLikePath(pathStr)) {
						let tokenType = 1; // Default to variable (existing path)
						
						// Try to determine if the path exists
						if (workspaceRoot) {
							try {
								let fullPath = pathStr;
								if (!path.isAbsolute(pathStr)) {
									fullPath = path.join(workspaceRoot, pathStr);
								}
								
								if (!fs.existsSync(fullPath)) {
									tokenType = 2; // String type for non-existing path
								}
							} catch (error) {
								tokenType = 2; // Treat as non-existing if we can't check
							}
						}
						
						// Highlight the path part
						tokensBuilder.push(lineNumber, startPos, pathStr.length, tokenType, 0);
						
						// Highlight line/column numbers if present
						if (lineNum) {
							const lineNumStart = startPos + pathStr.length + 1; // +1 for the colon
							tokensBuilder.push(lineNumber, lineNumStart, lineNum.length, 0, 0); // function type for line number
							
							if (colNum) {
								const colNumStart = lineNumStart + lineNum.length + 1; // +1 for the colon
								tokensBuilder.push(lineNumber, colNumStart, colNum.length, 0, 0); // function type for column number
							}
						}
					}
				}
			}
		}
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
			// Pattern: time + status (e.g., "3s ok", "5m 30s !2")
			/^((?:\d+h\s*)?(?:\d+m\s*)?(?:\d+s))\s+(ok|!\d+)$/,
			// Pattern: just time (e.g., "1h 2m 3s", "5m 30s", "42s")
			/^((?:\d+h\s*)?(?:\d+m\s*)?(?:\d+s))$/,
			// Pattern: "Running..."
			/^(Running\.\.\.)$/
		];
		
		return timingPatterns.some(pattern => pattern.test(trimmedLine));
	}

	private highlightTimingInLine(line: string, lineNumber: number, tokensBuilder: vscode.SemanticTokensBuilder): void {
		// Look for timing patterns like: "3s ok", "5m 30s !2", "1h 2m 3s", "Running..."
		
		const timingPatterns = [
			// Pattern: time + status (e.g., "3s ok", "5m 30s !2")
			/^((?:\d+h\s*)?(?:\d+m\s*)?(?:\d+s))\s+(ok|!\d+)$/,
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
						// Time + status pattern (e.g., "3s ok", "5m 30s !2")
						const timeStr = match[1];
						const statusStr = match[2];
						const timeStart = startPos + line.substring(startPos).indexOf(timeStr);
						const statusStart = startPos + line.substring(startPos).indexOf(statusStr);
						
						// Highlight time as string with italic
						tokensBuilder.push(lineNumber, timeStart, timeStr.length, 2, 2); // string type with italic modifier
						// Highlight status as function (ok) or keyword (!code)
						const tokenType = statusStr === 'ok' ? 0 : 5; // function for ok, keyword for error codes
						tokensBuilder.push(lineNumber, statusStart, statusStr.length, tokenType, 0);
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
		
		// Get the current line and check if we're in command section
		const text = document.getText();
		const lines = text.split('\n');
		let inCommandSection = true;
		for (let i = 0; i < position.line; i++) {
			if (lines[i].trim() === '') {
				inCommandSection = false;
				break;
			}
		}
		
		// Only provide suggestions in command section
		if (!inCommandSection) {
			return completions;
		}
		
		// Get the current line and word being typed
		const line = document.lineAt(position.line);
		const wordRange = document.getWordRangeAtPosition(position, /[^\s]+/);
		const word = wordRange ? document.getText(wordRange) : '';
		const lineStart = line.text.substring(0, position.character);
		const parts = lineStart.trim().split(/\s+/);
		
		// If we're at the beginning of a line (first word), provide command history suggestions
		if (parts.length <= 1 || (parts.length === 1 && word === parts[0])) {
			// Get history suggestions
			const currentInput = parts[0] || '';
			for (const historyCommand of commandHistory.slice().reverse()) { // Most recent first
				if (historyCommand !== currentInput && historyCommand.startsWith(currentInput)) {
					const completion = new vscode.CompletionItem(
						historyCommand,
						vscode.CompletionItemKind.Text
					);
					completion.detail = 'from history';
					completions.push(completion);
					
					// Limit to top 10 history suggestions
					if (completions.length >= 10) {
						break;
					}
				}
			}
			
			// If this is just the first word being typed, return only history completions
			if (parts.length <= 1) {
				return completions;
			}
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
		
		// First check if we're in an error message with file path (with line/col info)
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
					const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
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
		
		// If no error pattern matched, check for any general path under cursor
		const fs = require('fs');
		const path = require('path');
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
		
		// Look for path patterns around the cursor position with optional line:column syntax
		const pathPatterns = [
			// Absolute paths like /path/to/file.ext:123:45 or /path/to/file.ext
			/([\/\\][\w\-\.\/\\]+\.[a-zA-Z0-9]+)(?::(\d+)(?::(\d+))?)?/g,
			// Relative paths like ./path/to/file.ext:123:45 or src/file.ext:123
			/(\.[\/\\][\w\-\.\/\\]*\.[a-zA-Z0-9]+|[\w\-]+[\/\\][\w\-\.\/\\]*\.[a-zA-Z0-9]+)(?::(\d+)(?::(\d+))?)?/g,
			// Simple filenames with extensions like file.ext:123:45
			/([\w\-]+\.[a-zA-Z0-9]+)(?::(\d+)(?::(\d+))?)?/g
		];
		
		for (const pattern of pathPatterns) {
			let match;
			pattern.lastIndex = 0;
			
			while ((match = pattern.exec(lineText)) !== null) {
				const pathStr = match[1];
				const lineNum = match[2];
				const colNum = match[3];
				const startPos = match.index;
				const endPos = startPos + match[0].length;
				
				// Check if cursor is within this path (including line:column part)
				if (position.character >= startPos && position.character <= endPos) {
					if (pathStr && pathStr.length > 2) {
						let fullPath = pathStr;
						
						// Handle relative paths
						if (!path.isAbsolute(pathStr)) {
							fullPath = path.join(workspaceRoot, pathStr);
						}
						
						try {
							if (fs.existsSync(fullPath)) {
								const targetUri = vscode.Uri.file(fullPath);
								
								// Use line:column info if available
								let targetLine = 0;
								let targetCol = 0;
								
								if (lineNum) {
									targetLine = Math.max(0, parseInt(lineNum, 10) - 1); // Convert to 0-based
								}
								if (colNum) {
									targetCol = Math.max(0, parseInt(colNum, 10) - 1); // Convert to 0-based
								}
								
								const targetPosition = new vscode.Position(targetLine, targetCol);
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

function findAutosuggestion(currentInput: string): string | undefined {
	if (!currentInput.trim()) {
		return undefined;
	}
	
	// Find the most recent command that starts with the current input
	for (const historyCommand of commandHistory.slice().reverse()) {
		if (historyCommand !== currentInput && historyCommand.startsWith(currentInput)) {
			return historyCommand.substring(currentInput.length);
		}
	}
	
	return undefined;
}

function updateAutosuggestionDecorations(editor: vscode.TextEditor) {
	if (!autosuggestionDecorationType || editor.document.uri.scheme !== 'terminal-editor') {
		return;
	}
	
	const decorations: vscode.DecorationOptions[] = [];
	const text = editor.document.getText();
	const lines = text.split('\n');
	
	// Only show autosuggestions in command section (before first blank line)
	let inCommandSection = true;
	let lineNumber = 0;
	
	for (const line of lines) {
		if (inCommandSection && line.trim() === '') {
			inCommandSection = false;
			break;
		}
		
		if (inCommandSection && lineNumber === editor.selection.active.line) {
			// Get current line up to cursor position
			const cursorPosition = editor.selection.active.character;
			const currentInput = line.substring(0, cursorPosition).trim();
			
			// Only suggest for complete words (not partial typing)
			if (currentInput && cursorPosition === line.length) {
				const suggestion = findAutosuggestion(currentInput);
				if (suggestion) {
					const startPos = new vscode.Position(lineNumber, cursorPosition);
					const endPos = new vscode.Position(lineNumber, cursorPosition);
					const range = new vscode.Range(startPos, endPos);
					
					decorations.push({
						range,
						renderOptions: {
							after: {
								contentText: suggestion,
								color: new vscode.ThemeColor('editorGhostText.foreground')
							}
						}
					});
				}
			}
		}
		
		lineNumber++;
	}
	
	editor.setDecorations(autosuggestionDecorationType, decorations);
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
		isWholeLine: true,
		// Disable any potential blinking/animation effects
		textDecoration: 'none'
	});
	
	// Create decoration type for autosuggestions
	autosuggestionDecorationType = vscode.window.createTextEditorDecorationType({
		// Decoration options are set per-decoration in updateAutosuggestionDecorations
		// Disable any potential blinking/animation effects
		textDecoration: 'none'
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
			updateAutosuggestionDecorations(editor);
		}
	});
	
	let disposableTextDocumentChange = vscode.workspace.onDidChangeTextDocument(event => {
		if (event.document.uri.scheme === 'terminal-editor') {
			const editor = vscode.window.visibleTextEditors.find(e => e.document === event.document);
			if (editor) {
				updatePromptDecorations(editor);
				updateAutosuggestionDecorations(editor);
			}
		}
	});
	
	// Listen for cursor position changes to update autosuggestions
	let disposableSelectionChange = vscode.window.onDidChangeTextEditorSelection(event => {
		if (event.textEditor.document.uri.scheme === 'terminal-editor') {
			updateAutosuggestionDecorations(event.textEditor);
		}
	});
	
	// Update decorations for any already open terminal editors
	vscode.window.visibleTextEditors.forEach(editor => {
		if (editor.document.uri.scheme === 'terminal-editor') {
			updatePromptDecorations(editor);
			updateAutosuggestionDecorations(editor);
		}
	});
	
	let disposable = vscode.commands.registerCommand('terminal-editor.reveal', async () => {
		const terminalUri = vscode.Uri.parse('terminal-editor:/terminal');
		
		// Check if the terminal is already open
		const existingEditor = vscode.window.visibleTextEditors.find(editor => 
			editor.document.uri.toString() === terminalUri.toString()
		);
		
		if (existingEditor) {
			// Terminal already open, focus it and re-run the last command
			await vscode.window.showTextDocument(existingEditor.document, existingEditor.viewColumn);
			
			// Execute the current command in the terminal
			await vscode.commands.executeCommand('terminal-editor.execute');
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
		
		// Update decorations for the newly opened terminal
		updatePromptDecorations(editor);
		updateAutosuggestionDecorations(editor);
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

		// Add command to history (avoid duplicates and empty commands)
		if (commandLine && (!commandHistory.length || commandHistory[commandHistory.length - 1] !== commandLine)) {
			commandHistory.push(commandLine);
			// Keep history limited to last 100 commands
			if (commandHistory.length > 100) {
				commandHistory.shift();
			}
		}

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
			let timingLineAdded = false;
			
			const childProcess = spawn(command, args, { 
				stdio: ['pipe', 'pipe', 'pipe'],
				shell: false,
				cwd: workspaceRoot
			});
			
			let stdoutBuffer = '';
			let stderrBuffer = '';
			let hasOutput = false;
			
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
			
			// Update timing display every 2 seconds to reduce visual noise
			timingInterval = setInterval(() => {
				const elapsed = Date.now() - startTime;
				const timeStr = formatElapsedTime(elapsed);
				
				if (!hasOutput) {
					// If no output yet, show timing where it will be at the end
					const currentContent = terminalProvider!.getContent();
					if (!timingLineAdded) {
						terminalProvider!.appendContent('\n' + timeStr + '\n');
						timingLineAdded = true;
					} else {
						// Update the timing line
						const lines = currentContent.split('\n');
						for (let i = lines.length - 1; i >= 0; i--) {
							if (/^\d+[hms]/.test(lines[i]) || lines[i].startsWith('Running...')) {
								lines[i] = timeStr;
								break;
							}
						}
						terminalProvider!.updateContent(lines.join('\n'));
					}
				}
			}, 2000);

			childProcess.stdout.on('data', (data: Buffer) => {
				stdoutBuffer += data.toString();
				hasOutput = true;
				
				// Remove timing line if it exists, we'll add it at the end
				if (timingLineAdded) {
					const currentContent = terminalProvider!.getContent();
					const lines = currentContent.split('\n');
					const filteredLines = lines.filter(line => 
						!/^\d+[hms]/.test(line) && !line.startsWith('Running...')
					);
					terminalProvider!.updateContent(filteredLines.join('\n'));
					timingLineAdded = false;
				}
				
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
				
				// Calculate final elapsed time and add exit code line at the very end
				const elapsed = Date.now() - startTime;
				const timeStr = formatElapsedTime(elapsed);
				const exitCode = code || 0;
				const exitLine = exitCode === 0 ? `${timeStr} ok` : `${timeStr} !${exitCode}`;
				
				// Always append the final timing as the last line
				terminalProvider!.appendContent('\n' + exitLine + '\n');
			});

			childProcess.on('error', (error) => {
				// Clear the timing interval on error
				if (timingInterval) {
					clearInterval(timingInterval);
				}
				
				terminalProvider!.appendContent(`Error: ${error.message}\n`);
				
				// Add error exit code at the very end
				const elapsed = Date.now() - startTime;
				const timeStr = formatElapsedTime(elapsed);
				const exitLine = `${timeStr} !1`;
				terminalProvider!.appendContent('\n' + exitLine + '\n');
			});
		}
	});

	let acceptSuggestionDisposable = vscode.commands.registerCommand('terminal-editor.acceptSuggestion', async () => {
		const activeEditor = vscode.window.activeTextEditor;
		if (!activeEditor || activeEditor.document.uri.scheme !== 'terminal-editor') {
			// Not in terminal editor, do default behavior
			await vscode.commands.executeCommand('cursorRight');
			return;
		}

		// Check if we're in command section
		const text = activeEditor.document.getText();
		const lines = text.split('\n');
		const currentLine = activeEditor.selection.active.line;
		
		let inCommandSection = true;
		for (let i = 0; i < currentLine; i++) {
			if (lines[i].trim() === '') {
				inCommandSection = false;
				break;
			}
		}

		if (!inCommandSection) {
			// Not in command section, do default behavior
			await vscode.commands.executeCommand('cursorRight');
			return;
		}

		// Get current line and cursor position
		const line = lines[currentLine];
		const cursorPosition = activeEditor.selection.active.character;
		
		// Only suggest if cursor is at end of line
		if (cursorPosition !== line.length) {
			await vscode.commands.executeCommand('cursorRight');
			return;
		}

		const currentInput = line.trim();
		
		// Find suggestion
		const suggestion = findAutosuggestion(currentInput);
		if (suggestion) {
			// Insert the suggestion
			const success = await activeEditor.edit(editBuilder => {
				const position = new vscode.Position(currentLine, cursorPosition);
				editBuilder.insert(position, suggestion);
			});
			
			if (success) {
				// Move cursor to end of inserted text
				const newPosition = new vscode.Position(currentLine, cursorPosition + suggestion.length);
				activeEditor.selection = new vscode.Selection(newPosition, newPosition);
			}
		} else {
			// No suggestion, do default behavior
			await vscode.commands.executeCommand('cursorRight');
		}
	});

	context.subscriptions.push(
		disposableProvider, 
		disposableSemanticProvider, 
		disposableCompletionProvider, 
		disposableDefinitionProvider, 
		disposableActiveEditorChange,
		disposableTextDocumentChange,
		disposableSelectionChange,
		disposable, 
		executeDisposable,
		acceptSuggestionDisposable
	);
}

export function deactivate() {
	if (promptDecorationType) {
		promptDecorationType.dispose();
		promptDecorationType = undefined;
	}
	if (autosuggestionDecorationType) {
		autosuggestionDecorationType.dispose();
		autosuggestionDecorationType = undefined;
	}
}