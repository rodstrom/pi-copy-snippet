// Run: npm test (or node --test) from the package folder.
import assert from "node:assert/strict";
import { test } from "node:test";
import { byteLength, extractTargets, joinLines, osc52 } from "./snippets.ts";

const SAMPLE = [
  "Run this first:",
  "",
  "```bash",
  "git status",
  "git log --oneline",
  "```",
  "",
  "Then use `npm test` or `npm run lint`, and `npm test` again.",
  "",
  "~~~json",
  '{"a": 1}',
  "~~~",
].join("\n");

test("extracts fenced code blocks in order", () => {
  const t = extractTargets(SAMPLE);
  assert.equal(t.code.length, 2);
  assert.equal(t.code[0]!.text, "git status\ngit log --oneline");
  assert.match(t.code[0]!.label, /^bash · git status/);
  assert.equal(t.code[1]!.text, '{"a": 1}');
});

test("inline code is deduplicated and excludes fenced content", () => {
  const t = extractTargets(SAMPLE);
  assert.deepEqual(
    t.inline.map((x) => x.text),
    ["npm test", "npm run lint"],
  );
});

test("message paragraphs exclude code fences", () => {
  const t = extractTargets(SAMPLE);
  assert.equal(t.message.length, 2);
  assert.equal(t.message[0]!.text, "Run this first:");
});

test("unclosed fence keeps content", () => {
  const t = extractTargets("```sh\necho hi\necho there");
  assert.equal(t.code[0]!.text, "echo hi\necho there");
});

test("osc52 round-trips and byteLength counts utf8 bytes", () => {
  const seq = osc52("héllo");
  const b64 = seq.slice("\x1b]52;c;".length, -1);
  assert.equal(Buffer.from(b64, "base64").toString("utf8"), "héllo");
  assert.equal(byteLength("héllo"), 6);
});

test("joinLines keeps order and skips unselected", () => {
  assert.equal(joinLines(["a", "b", "c"], new Set([2, 0])), "a\nc");
});
