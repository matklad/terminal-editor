# Plan

terminal-editor is a VS Code extension that implements simple terminal in the text buffer. That is,
instead of using built-in terminal GUI, a user opens a (virtual) file, types commands into the text
file, presses enter, and sees the output in the same text file.

The extension will use minimal amount of dependencies possible, ideally, zero besides VS Code basic
API.

The extension is just three files:

* `src/extension.ts` contains all the "glue" code for interfacing with VS Code APIs, it is the view.
* `src/model.ts` contains the business logic of the extension, which is mostly independent of the VS
  Code API.
* `src/extension.tests.ts` are the tests.

Here's a plan for creating extension step-by step. After each step is finished, run `npm run test`
and `npm run lint` to make sure there are no problems, mark the step as done with `[X]` in this
file, and optionally add short implementation notes next to the step for future readers.

- [X] Remove the scaffolding command, and add three new commands with `terminal-editor.` prefix:
  `reveal`, `run`, and `dwim`. *(Replaced helloWorld command with three new commands in package.json and extension.ts)*
