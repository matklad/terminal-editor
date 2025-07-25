import * as vscode from 'vscode';

export class TerminalFileSystemProvider implements vscode.FileSystemProvider {
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