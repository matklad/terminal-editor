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
- [X] Show the output of the Terminal:
  - Add `terminal-editor` language
  - In extension.ts, add EphemeralFileSystem, whose job is only to prevent VS Code from showing save
    dialog. Important: the source of truth for all the state is the `Terminal` in the `model.ts`,
    and active in-memory editor's state. FileSystem is a no-op, just to make sure that the document
    isn't dirty from VS Code's POV
  - Implement terminal singleton. In extension.ts, create a global variable holding an instance of
    the terminal.
  - Implement "editor" singleton. Add code to the `reveal` command to show an existing terminal
    editor, if there's one, or create new if there isn't. At the start, assert that there's zero or
    one terminal editors.
  - Add `sync` function to `extension.ts` which synchronizes the state of the editor with the
    logical state of the terminal. Refer to the example at the begging of the document. Key point:
    the command is typed by the user, it exists only in the editor's state and is not mirrored in
    the `Terminal`, user is the source of truth for the command. The status and output are managed
    by the `Terminal`. To synchronize, find where the user input ends, and use editor commands to
    replace the rest. Note that the document can be completely empty at the beginning, in that case,
    use blank line as the user input, and add another blank to separate the status line, for two
    blanks in total at the beginning of the file.
  - Call `sync` every time the editor is created/revealed.
  - Add a test that checks that `reveal` command creates a terminal, and that second revel command
    doesn't create a duplicate. Also test cases where the terminal exists, and not visible, and
    where terminal is created, closed, and re-created.
- [X] Reveal quality of life:
  - Reveal into the second colum.
  - If Reveal create a new terminal, the cursor should be on the first line
  - Implement the `dwim` command, which reveals the terminal if its not already revealed, and
    focuses it if it is revealed ant not focused.
