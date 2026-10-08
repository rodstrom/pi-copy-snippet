// Pure helpers for pi-copy-snippet: no pi imports, so they can be tested with plain node.

/** Largest payload (raw bytes) we dare to send in one OSC 52 escape. See README. */
export const MAX_BYTES = 1024;

export type Category = "code" | "inline" | "message";
/** Tab order and default: the first non-empty one wins (code, else message, else inline). */
export const CATEGORIES: Category[] = ["code", "message", "inline"];

export interface Target {
  /** Short one-line description shown in the picker. */
  label: string;
  /** Exact text that gets copied. */
  text: string;
}

export type Targets = Record<Category, Target[]>;

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;

function oneLine(s: string, max = 60): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Split markdown into fenced code blocks and the prose around them. */
function splitFences(markdown: string): { code: Target[]; prose: string } {
  const code: Target[] = [];
  const prose: string[] = [];
  let fence: { marker: string; lang: string; lines: string[] } | undefined;

  const closeFence = () => {
    if (!fence) return;
    const text = fence.lines.join("\n");
    const lang = fence.lang || "text";
    code.push({ label: `${lang} · ${oneLine(fence.lines.find((l) => l.trim()) ?? "")}`, text });
    fence = undefined;
  };

  for (const line of markdown.split("\n")) {
    if (!fence) {
      const open = FENCE_OPEN.exec(line);
      if (open) fence = { marker: open[1]!, lang: open[2] ?? "", lines: [] };
      else prose.push(line);
      continue;
    }
    const isClose =
      line.trim().startsWith(fence.marker[0]!.repeat(fence.marker.length)) &&
      line.trim().replace(new RegExp(`^\\${fence.marker[0]}+`), "").trim() === "";
    if (isClose) closeFence();
    else fence.lines.push(line);
  }
  closeFence(); // unclosed fence (message cut off): keep what we have
  return { code, prose: prose.join("\n") };
}

export function extractTargets(markdown: string): Targets {
  const { code, prose } = splitFences(markdown);

  const seen = new Set<string>();
  const inline: Target[] = [];
  for (const match of prose.matchAll(/`([^`\n]+)`/g)) {
    const text = match[1]!;
    if (seen.has(text)) continue;
    seen.add(text);
    inline.push({ label: oneLine(text), text });
  }

  const message: Target[] = prose
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => ({ label: oneLine(p), text: p }));

  return { code, inline, message };
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** OSC 52 "set clipboard" escape. Terminal must allow clipboard access (iTerm2: Settings > General > Selection). */
export function osc52(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
}

/** Join selected line indexes (ascending) into the copied text. */
export function joinLines(lines: string[], selected: Set<number>): string {
  return lines.filter((_, i) => selected.has(i)).join("\n");
}
