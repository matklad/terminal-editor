import * as vscode from 'vscode';
import { strict as assert } from 'assert';
import { testing, visibleTerminal } from './extension';

// Simple hello world test using node -e
suite("Hello World Test", () => {
    setup(async () => {
        await testing.reset();
    });

    teardown(async () => {
        await testing.reset();
    });

    test("hello world", async () => {
        // Open terminal editor
        await vscode.commands.executeCommand("terminal-editor.reveal");
        await testing.sync();

        // Get the editor and insert hello world command
        const editor = visibleTerminal();
        assert.ok(editor, "Terminal editor should be visible");

        await editor.edit(editBuilder => {
            editBuilder.insert(new vscode.Position(0, 0), 'node -e "console.log(\'hello world\')"');
        });

        // Execute the command
        await vscode.commands.executeCommand("terminal-editor.run");
        await testing.sync();

        // Verify the result using snapshot with raw editor content (no JSON.stringify)
        testing.snapshot(`
node -e "console.log('hello world')"

= time: 0s status: 0 =

hello world

process: stopped
history: ["node -e \\"console.log('hello world')\\""]
folded: true
maxOutputLines: 40`);
    });
});
