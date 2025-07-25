import * as vscode from 'vscode';
import { existsSync } from 'fs';
import { join, isAbsolute } from 'path';

export class TerminalSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {
	async provideDocumentSemanticTokens(document: vscode.TextDocument): Promise<vscode.SemanticTokens> {
		const tokensBuilder = new vscode.SemanticTokensBuilder();

		const text = document.getText();
		const lines = text.split('\n');

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
								// Always use string token type for paths as requested
								const tokenType = 2; // token type 2 = string (all paths)

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

		// Pattern to match potential file paths with optional line:column syntax
		const pathPatterns = [
			// Absolute paths like /path/to/file.ext:123:45 or /path-to/file.ext
			/([\/\\][\w\.\/-]+\.[a-zA-Z0-9]+)(?::(\d+)(?::(\d+))?)?/g,
			// Relative paths like ./path/to/file.ext:123:45 or src/file.ext:123
			/(\.[\/\\][\w\.\/-]*\.[a-zA-Z0-9]+|[\w-]+[\/\\][\w\.\/-]*\.[a-zA-Z0-9]+)(?::(\d+)(?::(\d+))?)?/g,
			// Simple filenames with extensions like file.ext:123:45
			/([\w-]+\.[a-zA-Z0-9]+)(?::(\d+)(?::(\d+))?)?/g
		];

		for (const pattern of pathPatterns) {
			let match;
			pattern.lastIndex = 0; // Reset regex state

			while ((match = pattern.exec(line)) !== null) {
				const pathStr = match[1];
				const lineNum = match[2];
				const colNum = match[3];
				const startPos = match.index;

				if (pathStr && pathStr.length > 2) { // Avoid very short matches
					// Check if this looks like a real file path
					if (this.looksLikePath(pathStr)) {
						// Always use string token type for paths as requested
						const tokenType = 2; // String type for all paths

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