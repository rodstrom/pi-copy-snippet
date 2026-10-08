# pi-copy-snippet

A [pi](https://pi.dev) extension: pick a code block, inline code span, paragraph, or individual
lines from an assistant message and copy the original source text to the clipboard via OSC 52.
Open it with `/snip` or `ctrl+shift+x`.

## Why this exists

Two separate problems, one fix.

1. **Copying works at all inside a sandbox.** Under
   [ai-jail](https://github.com/akitaonrails/ai-jail) on macOS (`sandbox-exec`/Seatbelt), pi's
   built-in copy (`ctrl+x`, `/copy`) fails with `Clipboard unavailable`: the native clipboard and
   `pbcopy` are both denied inside the jail. OSC 52, an escape sequence the terminal acts on, needs
   no sandbox permission, only terminal passthrough (see Requirements).
2. **Copying a part of a message, cleanly.** In pi's regular (non-fullscreen) mode the terminal owns
   selection, and pi hard-wraps its output at the current width. Mouse-selecting a command or a few
   lines therefore pastes extra newlines and padding at every wrap, which breaks multi-line shell
   commands. Pi's built-in copy takes the whole message. This picks just the code block, the one
   command, or the lines you want, from the original text and with no mouse involved.

It works anywhere pi runs, sandboxed or not. If you only have problem 2, you still need a terminal
that accepts OSC 52 writes.

## Use

`/snip` or `ctrl+shift+x` (also shown in the footer). `ctrl+x` stays pi's own copy.

| View | Keys |
|---|---|
| Targets | `↑↓` move · `Enter` copy and close · `c` / `Alt+Enter` copy and keep open · `→`/`l` pick lines (not for Inline) · `Tab`/`Shift+Tab` category · `[` `]` older/newer message · `Esc` cancel |
| Lines | `↑↓` move · `Space` mark · `Shift+↑↓` range (marks, or unmarks if the line you step onto is marked) · `a` all/none · `Enter` copy marked (or current line) and close · `c` / `Alt+Enter` same but keep open · `←`/`h` back · `Esc` cancel |

Categories, in tab order: **Code** (fenced blocks), **Message** (paragraphs: blocks of
consecutive non-blank lines outside code fences), **Inline** (`` `spans` ``). The first non-empty
one is selected, so a message without code blocks opens on Message. Inline spans are single lines,
so line mode is not offered there.

**Copy and keep open** (`c`): copies, shows `Copied N B` in the footer, and steps to the next
target (or next line in line mode), so pressing `c` repeatedly walks down a list of commands while
you paste each one elsewhere. `c` works in every terminal; `Alt+Enter` depends on the terminal
sending it (some, such as WezTerm, Alacritty and Windows Terminal, swallow it by default).

**Other messages:** `[` goes to the previous assistant message on the current branch and `]`
back towards the latest. The header shows `message 2/7`.

The picker owns the keyboard while open, so none of these keys collide with pi's own bindings.
Only `ctrl+shift+x` (the opener) is registered with pi; it is not used by any default binding.

## Size cap

`MAX_BYTES = 1024` in `snippets.ts`. A single OSC 52 escape larger than this leaks base64 as
text and leaves the clipboard empty in the author's setup (iTerm2 + ai-jail; 911 chars worked, ~1.8k failed; the exact
limit is not measured). Raise the constant if you measure a higher limit.

What you see: every row in the target list shows its size, in red when it is over the cap, before
you select anything. Pressing `Enter` or `c` on an over-cap target does not copy; the footer says
`Too big: N B > 1024 B` with a hint (`Press → to pick lines`, or `Mark fewer lines` in line mode),
and the picker stays open. In line mode the header shows `N marked · size B`, red when over. The cap itself is only
spelled out in that refusal message.

## Requirements

1. pi with extension support, and Node 22.19+ (pi's own requirement).
2. A terminal that accepts OSC 52 clipboard writes. iTerm2: Settings > General > Selection >
   "Applications in terminal may access clipboard". Other terminals have a similar switch.
3. Only if you run pi inside ai-jail: terminal passthrough enabled for pi, for example
   `terminal_passthrough = true` under `[commands.pi]` in the global ai-jail config, or
   `--terminal-passthrough`. Otherwise its PTY proxy strips OSC 52. Running the sequence by hand
   is a quick check: `printf '\e]52;c;%s\a' "$(printf hello | base64)"` in a real shell inside the
   jail, then paste.
4. Optional, only for pi's own `ctrl+x`/`/copy` inside ai-jail: launch with
   `--env SSH_CONNECTION=local`. Pi only emits OSC 52 for sessions it thinks are remote. This
   extension does not need it, since it emits the escape itself.

## Files

- `index.ts`: command, shortcut, picker UI.
- `snippets.ts`: pure parsing/encoding (`extractTargets`, `osc52`, `MAX_BYTES`).
- `snippets.test.ts`: unit tests for the pure helpers.
- `ui.test.ts`: drives the real picker with a fake context (see Testing).
- `package.json`: pi package manifest (`pi.extensions`), peer dependencies, `npm test`.
- `.gitignore`: `node_modules/`, `package-lock.json`.
- `LICENSE`: MIT.

## Testing

`npm test` (same as `node --test`) runs everything. Node strips the TypeScript types itself, so
there is no build step.

- **Unit tests** (`snippets.test.ts`) need nothing else.
- **UI tests** (`ui.test.ts`) import `index.ts`, which needs `@earendil-works/pi-tui` at runtime.
  `npm install` provides it (npm 7+ installs peer dependencies). Where npm or the network is
  unavailable (for example inside ai-jail), symlink pi's own copy instead:
  `mkdir -p node_modules && ln -s <pi install>/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works node_modules/@earendil-works`
  (find `<pi install>` with `readlink -f "$(which pi)"`).

How the UI tests work, so you can add cases without a real terminal:

1. `copyWith(markdown, keys)` registers the extension against a fake `pi`, runs the `/snip` handler
   and gets the picker component through a fake `ctx.ui.custom`.
2. It feeds the component the raw bytes a terminal would send (`\x1b[B` is Down, `\x1b[1;2B` is
   Shift+Down, `\r` is Enter) and lets it finish.
3. `process.stdout.write` is intercepted, so the OSC 52 escape the extension emits is decoded from
   base64 and compared with the expected text. This checks the whole path except the terminal.

When fixing a picker bug, first add a failing test that replays the keys that triggered it
(see the "no stuck state" test), then fix. Not covered: how it looks, and whether iTerm2 and
ai-jail actually deliver the escape. Check those by hand with a real `/snip`, then paste.

## Install

Pick one. Afterwards start pi (or run `/reload`) and check that `/snip` exists and that `/snip ctrl+shift+x`
shows in the footer.

**From GitHub (normal use):**

```
pi install git:github.com/rodstrom/pi-copy-snippet@v0.1.0
```

Pi clones the repo and pins the tag, then loads `./index.ts` from the `pi.extensions` entry in
`package.json`. The declaration is written to `~/.pi/agent/settings.json`. Upgrade by installing a
newer tag, or `pi update --extensions`. Remove with `pi remove git:github.com/rodstrom/pi-copy-snippet`.

**From a local checkout:**

```
git clone https://github.com/rodstrom/pi-copy-snippet
pi install ./pi-copy-snippet
```

Local packages load from that path without copying, so edits apply after `/reload`.

**Without the package system:** copy or symlink this folder to
`~/.pi/agent/extensions/pi-copy-snippet/`. Pi loads any subfolder there that has an `index.ts`.

**Try it once without installing:** `pi -e ./index.ts` from this folder.

Inside ai-jail the folder (or the path your settings point to) must be readable by pi in the jail,
which for `~/.pi` is normally already the case.

## Development

```
git clone https://github.com/rodstrom/pi-copy-snippet && cd pi-copy-snippet
npm install
npm test
```

Day to day:

1. Edit `index.ts` (UI, keys) or `snippets.ts` (parsing, cap, encoding).
2. Add or adjust a test first (see Testing), then `npm test`.
3. Try it in pi: `pi -e ./index.ts`, or with a local install run `/reload` after each change.
   Then do the manual check that tests cannot do: `/snip`, copy something, paste it.

Guidelines: keep it one dependency-free package. Keep `snippets.ts` free of pi imports so it stays
testable with plain Node. Keep the picker cheap: parse only the message on screen, and never
block on I/O in a key handler.

Release:

1. Update `version` in `package.json`.
2. `git tag vX.Y.Z && git push --tags` (a standalone push, after committing).
3. Users move to it with `pi install git:github.com/rodstrom/pi-copy-snippet@vX.Y.Z`.

The parsing and picker behaviour are documented in Use above; the reasoning behind the cap is in
Size cap.

## License

MIT, see `LICENSE`.
