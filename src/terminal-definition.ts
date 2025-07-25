import * as vscode from 'vscode';
import { existsSync } from 'fs';
import { join, isAbsolute } from 'path';

export class TerminalDefinitionProvider implements vscode.DefinitionProvider {
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
					let fullPath = filePath;

					// Handle relative paths
					if (!isAbsolute(filePath)) {
						fullPath = join(workspaceRoot, filePath);
					}

					try {
						if (existsSync(fullPath)) {
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
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();

		// Look for path patterns around the cursor position with optional line:column syntax
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
						if (!isAbsolute(pathStr)) {
							fullPath = join(workspaceRoot, pathStr);
						}

						try {
							if (existsSync(fullPath)) {
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