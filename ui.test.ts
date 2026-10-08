// UI-level tests: drive the real picker component with a fake pi context and raw key bytes.
// Needs @earendil-works/pi-tui resolvable; see "Testing" in README.md.
import assert from "node:assert/strict";
import { test } from "node:test";
import extension from "./index.ts";

// Raw terminal input as pi receives it.
const KEY = { esc: "\x1b", tab: "\t", up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", shiftUp: "\x1b[1;2A", shiftDown: "\x1b[1;2B" };

/**
 * Open the picker, feed it `keys`, and return what was written as OSC 52 (decoded) plus the
 * final screen. `markdown` is one assistant message, or several in conversation order.
 * Keys that never close the picker leave its promise pending, which is fine for a test.
 */
async function copyWith(
  markdown: string | string[],
  keys: string[],
): Promise<{ copied?: string; copies: string[]; notices: string[]; screen: string }> {
  const messages = Array.isArray(markdown) ? markdown : [markdown];
  let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
  extension({
    registerCommand: (_name: string, options: typeof command) => {
      command = options;
    },
    registerShortcut: () => {},
    on: () => {},
  } as never);

  let component: { handleInput(data: string): void; render(width: number): string[] } | undefined;
  const notices: string[] = [];
  const theme = { fg: (_color: string, s: string) => s, bold: (s: string) => s };
  const ctx = {
    mode: "tui",
    sessionManager: {
      getBranch: () =>
        messages.map((text) => ({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } })),
    },
    ui: {
      notify: (message: string) => notices.push(message),
      custom: (factory: (...args: unknown[]) => typeof component) =>
        new Promise((resolve) => {
          component = factory({ requestRender() {} }, theme, null, resolve);
        }),
    },
  };

  // The extension writes the OSC 52 escape straight to stdout; capture it instead.
  const realWrite = process.stdout.write;
  let written = "";
  process.stdout.write = ((chunk: string) => ((written += chunk), true)) as never;
  let screen = "";
  try {
    const done = command!.handler("", ctx);
    for (const key of keys) component!.handleInput(key);
    screen = component!.render(100).join("\n");
    if (keys.includes(KEY.esc) || keys.includes("\r")) await done;
  } finally {
    process.stdout.write = realWrite;
  }

  const copies = [...written.matchAll(/\x1b\]52;c;([^\x07]*)\x07/g)].map((m) => Buffer.from(m[1]!, "base64").toString("utf8"));
  return { copied: copies.at(-1), copies, notices, screen };
}

const FIVE = "```\na\nb\nc\nd\ne\n```\n";

test("Enter copies the whole first code block", async () => {
  const r = await copyWith("intro\n\n```sh\nls\npwd\n```\n", ["\r"]);
  assert.equal(r.copied, "ls\npwd");
});

test("line mode: Enter with nothing marked copies the line under the cursor", async () => {
  const r = await copyWith(FIVE, ["l", KEY.down, KEY.down, "\r"]);
  assert.equal(r.copied, "c");
});

test("Shift+Down marks a range", async () => {
  const r = await copyWith(FIVE, ["l", KEY.shiftDown, KEY.shiftDown, KEY.shiftDown, "\r"]);
  assert.equal(r.copied, "a\nb\nc\nd");
});

test("Shift+Up after marking shrinks the range (reversal)", async () => {
  const r = await copyWith(FIVE, ["l", ...Array(3).fill(KEY.shiftDown), KEY.shiftUp, KEY.shiftUp, "\r"]);
  assert.equal(r.copied, "a");
});

test("regression: marking works again after unmarking (no stuck state)", async () => {
  const keys = ["l", ...Array(3).fill(KEY.shiftDown), KEY.shiftUp, KEY.shiftUp, KEY.shiftDown, "\r"];
  assert.equal((await copyWith(FIVE, keys)).copied, "a\nb\nc");
});

test("'a' marks all, then Shift+Down from a marked line unmarks", async () => {
  const keys = ["l", "a", KEY.down, KEY.down, KEY.shiftDown, KEY.shiftDown, "\r"];
  assert.equal((await copyWith(FIVE, keys)).copied, "a\nb");
});

test("Shift+Down at the last line does not flip the mark", async () => {
  const r = await copyWith(FIVE, ["l", ...Array(7).fill(KEY.shiftDown), "\r"]);
  assert.equal(r.copied, "a\nb\nc\nd\ne");
});

test("over-cap selection is refused and the picker stays open", async () => {
  const big = `\`\`\`\n${"x".repeat(2000)}\n\`\`\`\n`;
  const r = await copyWith(big, ["\r", "\x1b"]); // Enter (refused), then Esc to close
  assert.equal(r.copied, undefined);
});

test("Esc cancels without copying", async () => {
  assert.equal((await copyWith(FIVE, ["\x1b"])).copied, undefined);
});

test("tab order: code first, then message, then inline", async () => {
  const md = "Run `x` now.\n\n```sh\nls\n```\n";
  const { screen } = await copyWith(md, []);
  assert.ok(screen.indexOf("Code 1") < screen.indexOf("Message 1"));
  assert.ok(screen.indexOf("Message 1") < screen.indexOf("Inline 1"));
});

test("without code blocks the message category is the default", async () => {
  const r = await copyWith("First paragraph.\n\nUse `npm test`.\n", ["\r"]);
  assert.equal(r.copied, "First paragraph.");
});

test("inline category does not offer line mode", async () => {
  const md = "Use `npm test`.\n";
  const onInline = await copyWith(md, [KEY.tab]);
  assert.ok(!onInline.screen.includes("lines"), "hint hidden on inline");
  const onMessage = await copyWith(md, []);
  assert.ok(onMessage.screen.includes("lines"), "hint shown on message");
  // Pressing l on inline must not open line mode: Enter still copies the whole span.
  assert.equal((await copyWith(md, [KEY.tab, "l", "\r"])).copied, "npm test");
});

test("c copies without closing and steps to the next target", async () => {
  const md = "```\none\n```\n\n```\ntwo\n```\n";
  const r = await copyWith(md, ["c", "c"]);
  assert.deepEqual(r.copies, ["one", "two"]);
  assert.match(r.screen, /Copied 3 B/);
});

test("Alt+Enter also copies and keeps the picker open", async () => {
  const r = await copyWith("```\nabc\n```\n", ["\x1b\r"]);
  assert.deepEqual(r.copies, ["abc"]);
});

test("line mode: c copies the cursor line and advances; marked lines are cleared after", async () => {
  const keys = ["l", "c", "c", KEY.shiftDown, "c"];
  const r = await copyWith(FIVE, keys);
  // a, b (cursor now on c), then shift+down marks c,d and c copies them.
  assert.deepEqual(r.copies, ["a", "b", "c\nd"]);
});

test("[ and ] switch between assistant messages", async () => {
  const msgs = ["```\nolder\n```\n", "```\nnewer\n```\n"]; // conversation order
  assert.equal((await copyWith(msgs, ["\r"])).copied, "newer");
  assert.equal((await copyWith(msgs, ["[", "\r"])).copied, "older");
  assert.equal((await copyWith(msgs, ["[", "]", "\r"])).copied, "newer");
  assert.match((await copyWith(msgs, [])).screen, /message 1\/2 \(latest\)/);
});

test("too big: refused after the keypress, with a hint, and row size shown beforehand", async () => {
  const big = `\`\`\`\n${"x".repeat(2000)}\n\`\`\`\n`;
  const before = await copyWith(big, []);
  assert.match(before.screen, /2000 B/); // size visible before pressing anything
  const after = await copyWith(big, ["c"]);
  assert.deepEqual(after.copies, []);
  assert.match(after.screen, /Too big: 2000 B > 1024 B\. Press → to pick lines\./);
});
