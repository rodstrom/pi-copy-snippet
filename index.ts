/**
 * pi-copy-snippet: pick a code block / inline code / paragraph (or single lines) from the
 * last assistant message and copy its *source text* via OSC 52. See README.md.
 *
 * Why: native terminal selection copies pi's hard-wrapped rows, and pi's own copy path
 * is blocked inside ai-jail on macOS. OSC 52 only needs terminal passthrough.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import {
  byteLength,
  CATEGORIES,
  type Category,
  extractTargets,
  joinLines,
  MAX_BYTES,
  osc52,
  type Target,
  type Targets,
} from "./snippets.ts";

const SHORTCUT = Key.ctrlShift("x"); // pi's own copy is ctrl+x
const COMMAND = "snip";
const MAX_ROWS = 12;

const CATEGORY_TITLE: Record<Category, string> = { code: "Code", inline: "Inline", message: "Message" };

/** Text of every assistant message on the current branch, newest first. */
function assistantTexts(ctx: ExtensionContext): string[] {
  const texts: string[] = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message" || !("role" in entry.message) || entry.message.role !== "assistant") continue;
    const text = entry.message.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    if (text.trim()) texts.push(text);
  }
  return texts.reverse();
}

function copyToTerminal(text: string) {
  process.stdout.write(osc52(text));
}

async function pickSnippet(ctx: ExtensionContext): Promise<string | null> {
  const messages = assistantTexts(ctx);
  if (messages.length === 0) {
    ctx.ui.notify("No assistant message to copy from", "warning");
    return null;
  }

  return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    let msgIdx = 0; // 0 = latest message, higher = older
    let targets: Targets = extractTargets(messages[0]!);
    let cats = CATEGORIES.filter((c) => targets[c].length > 0);
    let catIdx = 0; // index into cats
    const cursor: Record<Category, number> = { code: 0, inline: 0, message: 0 };
    let mode: "targets" | "lines" = "targets";
    let lines: string[] = [];
    let lineCursor = 0;
    let marked = new Set<number>();
    let notice = "";
    let noticeOk = false;

    const cat = () => cats[catIdx]!;
    const current = (): Target => targets[cat()][cursor[cat()]]!;
    const redraw = () => tui.requestRender();

    const canPickLines = () => cat() !== "inline"; // inline spans are single lines

    function loadMessage(idx: number) {
      msgIdx = idx;
      targets = extractTargets(messages[idx]!);
      cats = CATEGORIES.filter((c) => targets[c].length > 0);
      catIdx = 0;
      cursor.code = cursor.inline = cursor.message = 0;
    }

    /**
     * Copy `text` unless it is over the cap (the picker stays open then). With `stay` the
     * text is sent right away and the picker stays open too; otherwise it closes and the
     * caller sends it. Returns true when the copy went through.
     */
    const tryCopy = (text: string, stay: boolean): boolean => {
      const size = byteLength(text);
      if (size > MAX_BYTES) {
        const hint = mode === "targets" ? (canPickLines() ? " Press → to pick lines." : "") : " Mark fewer lines.";
        notice = `Too big: ${size} B > ${MAX_BYTES} B.${hint}`;
        noticeOk = false;
        redraw();
        return false;
      }
      if (!stay) {
        done(text);
        return true;
      }
      copyToTerminal(text);
      notice = `Copied ${size} B`;
      noticeOk = true;
      redraw();
      return true;
    };

    const isCopyStay = (data: string) => matchesKey(data, "alt+enter") || matchesKey(data, "c");

    const move = (delta: number, count: number, index: number) => Math.max(0, Math.min(count - 1, index + delta));

    function onTargetsKey(data: string) {
      const list: Target[] = targets[cat()];
      if (matchesKey(data, Key.up)) cursor[cat()] = move(-1, list.length, cursor[cat()]);
      else if (matchesKey(data, Key.down)) cursor[cat()] = move(1, list.length, cursor[cat()]);
      else if (matchesKey(data, Key.tab)) catIdx = (catIdx + 1) % cats.length;
      else if (matchesKey(data, "shift+tab")) catIdx = (catIdx - 1 + cats.length) % cats.length;
      else if (matchesKey(data, Key.leftbracket) && msgIdx < messages.length - 1) loadMessage(msgIdx + 1);
      else if (matchesKey(data, Key.rightbracket) && msgIdx > 0) loadMessage(msgIdx - 1);
      else if (matchesKey(data, Key.enter)) return void tryCopy(current().text, false);
      else if (isCopyStay(data)) {
        // Copy, then step to the next target so repeated presses walk down the list.
        if (tryCopy(current().text, true)) cursor[cat()] = move(1, list.length, cursor[cat()]);
        return;
      } else if ((matchesKey(data, Key.right) || matchesKey(data, "l")) && canPickLines()) {
        mode = "lines";
        lines = current().text.split("\n");
        lineCursor = 0;
        marked = new Set();
      } else return;
      notice = "";
      redraw();
    }

    function onLinesKey(data: string) {
      if (matchesKey(data, Key.up)) lineCursor = move(-1, lines.length, lineCursor);
      else if (matchesKey(data, Key.down)) lineCursor = move(1, lines.length, lineCursor);
      else if (matchesKey(data, "shift+up") || matchesKey(data, "shift+down")) {
        // Stateless (terminals send no key-release, so there is no "run" to remember):
        // paint the line we step onto, and the one we leave, with the opposite of the
        // destination's state. Over unmarked lines this marks, over marked lines it unmarks.
        const dest = move(matchesKey(data, "shift+up") ? -1 : 1, lines.length, lineCursor);
        if (dest === lineCursor) return; // already at the first/last line
        const paint = !marked.has(dest);
        for (const i of [lineCursor, dest]) {
          if (paint) marked.add(i);
          else marked.delete(i);
        }
        lineCursor = dest;
      } else if (matchesKey(data, Key.space)) {
        if (!marked.delete(lineCursor)) marked.add(lineCursor);
        lineCursor = move(1, lines.length, lineCursor);
      } else if (matchesKey(data, "a")) {
        marked = marked.size === lines.length ? new Set() : new Set(lines.keys());
      } else if (matchesKey(data, Key.enter)) {
        // Nothing marked -> copy just the line under the cursor.
        return void tryCopy(joinLines(lines, marked.size ? marked : new Set([lineCursor])), false);
      } else if (isCopyStay(data)) {
        const single = marked.size === 0;
        if (tryCopy(joinLines(lines, single ? new Set([lineCursor]) : marked), true)) {
          // One line copied -> step to the next one; a marked set is cleared for the next pick.
          marked = new Set();
          if (single) lineCursor = move(1, lines.length, lineCursor);
        }
        return;
      } else if (matchesKey(data, Key.left) || matchesKey(data, "h")) mode = "targets";
      else return;
      notice = "";
      redraw();
    }

    /** Show a scrolling window of rows around the cursor. */
    function windowed(rows: string[], at: number): string[] {
      const start = Math.max(0, Math.min(at - Math.floor(MAX_ROWS / 2), rows.length - MAX_ROWS));
      return rows.slice(start, start + MAX_ROWS);
    }

    function render(width: number): string[] {
      const rule = theme.fg("accent", "─".repeat(Math.max(1, width)));
      const fit = (s: string) => truncateToWidth(s, Math.max(1, width));
      const out: string[] = [rule];

      if (mode === "targets") {
        const tabs = cats
          .map((c, i) => {
            const label = `${CATEGORY_TITLE[c]} ${targets[c].length}`;
            return i === catIdx ? theme.fg("accent", theme.bold(`[${label}]`)) : theme.fg("muted", ` ${label} `);
          })
          .join(" ");
        const where =
          messages.length > 1 ? `message ${msgIdx + 1}/${messages.length}${msgIdx === 0 ? " (latest)" : ""}` : "";
        out.push(fit(` ${tabs}${where ? `   ${theme.fg("dim", where)}` : ""}`));
        const list = targets[cat()];
        const rows = list.map((t, i) => {
          const size = byteLength(t.text);
          const sizeText = size > MAX_BYTES ? theme.fg("error", `${size} B`) : theme.fg("dim", `${size} B`);
          const prefix = i === cursor[cat()] ? theme.fg("accent", "> ") : "  ";
          const label = i === cursor[cat()] ? theme.fg("accent", t.label) : t.label;
          return fit(`${prefix}${i + 1}. ${label}  ${sizeText}`);
        });
        out.push(...windowed(rows, cursor[cat()]));
        out.push(fit(theme.fg("dim", " ↑↓ · Enter copy+close · c/Alt+Enter copy, keep open · Tab category")));
        const more = [canPickLines() && "→/l lines", messages.length > 1 && "[ ] older/newer message", "Esc"];
        out.push(fit(theme.fg("dim", ` ${more.filter(Boolean).join(" · ")}`)));
      } else {
        const picked = marked.size ? joinLines(lines, marked) : (lines[lineCursor] ?? "");
        const size = byteLength(picked);
        const sizeText = size > MAX_BYTES ? theme.fg("error", `${size}`) : `${size}`;
        out.push(fit(` ${theme.fg("accent", current().label)}  ${theme.fg("dim", `${marked.size} marked · ${sizeText} B`)}`));
        const rows = lines.map((l, i) => {
          const box = marked.has(i) ? theme.fg("success", "[x]") : "[ ]";
          const prefix = i === lineCursor ? theme.fg("accent", ">") : " ";
          const num = String(i + 1).padStart(3);
          const body = i === lineCursor ? theme.fg("accent", l) : l;
          return fit(`${prefix}${box} ${theme.fg("dim", num)} ${body}`);
        });
        out.push(...windowed(rows, lineCursor));
        out.push(fit(theme.fg("dim", " ↑↓ · Space mark · Shift+↑↓ range · a all/none · ←/h back")));
        out.push(fit(theme.fg("dim", " Enter copy+close · c/Alt+Enter copy, keep open · Esc")));
      }

      if (notice) out.push(fit(` ${theme.fg(noticeOk ? "success" : "warning", notice)}`));
      out.push(rule);
      return out;
    }

    return {
      render,
      invalidate: () => {},
      handleInput(data: string) {
        if (matchesKey(data, Key.escape)) return done(null);
        if (mode === "targets") onTargetsKey(data);
        else onLinesKey(data);
      },
    };
  });
}

async function run(ctx: ExtensionContext) {
  if (ctx.mode !== "tui") return;
  const text = await pickSnippet(ctx);
  if (text === null) return;
  copyToTerminal(text);
  ctx.ui.notify(`Copied ${byteLength(text)} B`, "info");
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand(COMMAND, {
    description: `Copy a snippet from the last message (${SHORTCUT})`,
    handler: async (_args, ctx) => run(ctx),
  });

  pi.registerShortcut(SHORTCUT, {
    description: "Copy snippet from last assistant message",
    handler: (ctx) => run(ctx),
  });
}
