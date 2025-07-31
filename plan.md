# Plan

terminal-editor is a VS Code extension that implements simple terminal in the text buffer. That is,
instead of using built-in terminal GUI, a user opens a (virtual) file, types commands into the text
file, presses enter, and sees the output in the same text file.

The terminal output looks roughly like this:

```
./zig/zig build test
   -Dtest-filter="foo"

= time: 3s status: 1 =

src/test.zig:69:28: error: unused function parameter
```

That is, potentially multiline command entered by the user, a blank like, and the content generated
by the extension: status line enclosed in `=` and the actual output of the command.

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
  `reveal`, `run`, and `dwim`.
  Implementation notes: each command is top-level function. They are after `activate`, because the
  code is read top-down.
- [X] Add `Terminal` class to `model.ts` which will hold _logical_ state of the terminal, but which
  won't directly display it. Terminal will have `status` and `output` methods to return status line
  and the output text respectively. They will return a `{ text: string }` object to allow for
  extensibility (we'll return highlights in the future). Use `= =` for status and `"hello world"`
  for output for now.
