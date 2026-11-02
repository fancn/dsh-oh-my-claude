import assert from "node:assert/strict";
import {
  askBody,
  clampQuote,
  popoverPlacement,
  previewOf,
  QUOTE_MAX,
  quoteInsertion,
  quoteMarkdown,
  quoteSpans,
  quotedLines,
  unquote,
} from "./selection.js";

assert.equal(quoteMarkdown("one"), "> one\n\n");
assert.equal(quoteMarkdown("a\r\n\r\nb"), "> a\n>\n> b\n\n");
assert.equal(quoteMarkdown("  x\n\t\n"), ">   x\n>\n>\n\n");
assert.deepEqual(clampQuote("abc"), { text: "abc", trimmed: false });
const long = "z".repeat(QUOTE_MAX + 5);
assert.deepEqual(clampQuote(long), { text: "z".repeat(4000), trimmed: true });
// Quote insertion: one blank line between the passage and what came before, none doubled.
assert.equal(quoteInsertion("p", " why? ", ""), "> p\n\nwhy?", "an empty draft takes no prefix");
assert.equal(quoteInsertion("p", "q", "\n\n"), "> p\n\nq", "a draft of blank lines takes none");
assert.equal(quoteInsertion("p", "q", "Q1"), "\n\n> p\n\nq");
assert.equal(quoteInsertion("p", "q", "Q1\n"), "\n> p\n\nq", "the caret's own line counts");
assert.equal(quoteInsertion("p", "q", "Q1\n\n"), "> p\n\nq");
assert.equal(quoteInsertion("p", "q", "Q1\n\n\n"), "> p\n\nq", "extra blank lines are left alone");
assert.equal(quoteInsertion("p", "q", null), "\n\n> p\n\nq", "chips hide the draft: assume text");
assert.equal(
  quoteInsertion("a\n\nb", "line one\nline two", ""),
  "> a\n>\n> b\n\nline one\nline two",
  "a multi-line passage and question keep their lines",
);
assert.equal(previewOf(" a\n\n  b\tc "), "a b c");
// Popover placement: under the selection's last line, above it when there is no room.
const view = { width: 1000, height: 800 };
const all = { left: 0, top: 0, right: 1000, bottom: 800 };
const box = { width: 300, height: 100 };
const rect = (top: number, left = 400, right = 600) => ({ left, top, right, bottom: top + 20 });
/** A one-line passage: its first and last lines are the same. */
const line = (top: number, left?: number, right?: number) => {
  const r = rect(top, left, right);
  return { first: r, last: r };
};
assert.deepEqual(popoverPlacement(line(100), box, view, all), {
  left: 350,
  top: 128,
  width: 300,
  side: "bottom",
  pinned: false,
});
assert.deepEqual(popoverPlacement(line(700), box, view, all), {
  left: 350,
  top: 592,
  width: 300,
  side: "top",
  pinned: false,
});
assert.deepEqual(
  popoverPlacement(line(100, 0, 40), box, view, all),
  { left: 12, top: 128, width: 300, side: "bottom", pinned: false },
  "kept 12px off the left edge",
);
assert.deepEqual(
  popoverPlacement(line(100, 950, 1000), box, view, all),
  { left: 688, top: 128, width: 300, side: "bottom", pinned: false },
  "kept 12px off the right edge",
);
assert.deepEqual(
  popoverPlacement(line(60), { width: 300, height: 780 }, view, all),
  { left: 350, top: 12, width: 300, side: "bottom", pinned: false },
  "no room either way: pinned inside the viewport",
);
assert.deepEqual(
  popoverPlacement(line(100, 300, 340), box, view, { left: 280, top: 0, right: 1000, bottom: 800 }),
  { left: 292, top: 128, width: 300, side: "bottom", pinned: false },
  "kept 12px inside the chat, off the sidebar",
);
assert.deepEqual(
  popoverPlacement(
    line(700, 72, 367),
    { width: 420, height: 88 },
    { width: 390, height: 844 },
    {
      left: 56,
      top: 76,
      right: 388,
      bottom: 723,
    },
  ),
  { left: 68, top: 604, width: 308, side: "top", pinned: false },
  "a phone's chat narrower than the popover: it narrows to fit, 12px in on both sides",
);
const chat = { left: 0, top: 50, right: 1000, bottom: 650 };
assert.deepEqual(
  popoverPlacement({ first: rect(300, 100, 900), last: rect(580) }, box, view, chat),
  { left: 350, top: 192, width: 300, side: "top", pinned: false },
  "no room under a long passage: over its first line, not over the passage",
);
assert.deepEqual(
  popoverPlacement(line(600), box, view, chat),
  { left: 350, top: 492, width: 300, side: "top", pinned: false },
  "a passage just above the composer: above it, so the composer stays clear",
);
assert.deepEqual(
  popoverPlacement(line(10), box, view, chat),
  { left: 350, top: 62, width: 300, side: "bottom", pinned: true },
  "scrolled above the chat: pinned to its top",
);
assert.deepEqual(
  popoverPlacement(line(660), box, view, chat),
  { left: 350, top: 538, width: 300, side: "top", pinned: true },
  "scrolled under the composer: pinned just above it",
);
assert.deepEqual(askBody("s1", "  why?  ", "> x"), {
  session: "s1",
  question: "why?",
  quote: "> x",
});
assert.deepEqual(askBody("s1", "", "p"), { session: "s1", question: "", quote: "p" });
// Quote lines: `> ` at a line's start is a quote, `>` elsewhere is not, and fenced code is skipped.
const one = (text: string) => quoteSpans([{ text, newLine: true }]);
assert.deepEqual(one("> Ask\nTest"), [
  { seg: 0, start: 0, end: 1, mark: true },
  { seg: 0, start: 1, end: 5, mark: false },
]);
assert.deepEqual(one("a > b\nx >= 5\n->"), [], "a > mid-line is not a quote");
assert.deepEqual(one(">5 items"), [], "no space after the marker: plain");
assert.deepEqual(
  one(">\n"),
  [{ seg: 0, start: 0, end: 1, mark: true }],
  "a bare > line is part of a quote",
);
assert.deepEqual(one("```\n> npm test\n```\n> real"), [
  { seg: 0, start: 19, end: 20, mark: true },
  { seg: 0, start: 20, end: 25, mark: false },
]);
assert.deepEqual(
  quoteSpans([
    { text: "> one ", newLine: true },
    { text: "two\n", newLine: false },
    { text: "> three", newLine: false },
  ]),
  [
    { seg: 0, start: 0, end: 1, mark: true },
    { seg: 0, start: 1, end: 6, mark: false },
    { seg: 1, start: 0, end: 3, mark: false },
    { seg: 2, start: 0, end: 1, mark: true },
    { seg: 2, start: 1, end: 7, mark: false },
  ],
  "a line carries across segments, and a segment ending on a newline starts the next line",
);
assert.deepEqual(
  quoteSpans([
    { text: "> a", newLine: true },
    { text: "b", newLine: true },
  ]),
  [
    { seg: 0, start: 0, end: 1, mark: true },
    { seg: 0, start: 1, end: 3, mark: false },
  ],
  "a new paragraph ends the quote line",
);
assert.deepEqual(quotedLines(["> Ask", "Test"]), [true, false]);
assert.deepEqual(quotedLines(["hi", "", "> a", ">", "> b", "after"]), [
  false,
  false,
  true,
  true,
  true,
  false,
]);
assert.deepEqual(
  quotedLines(["```", "> x", "```"]),
  [false, false, false],
  "fenced code is not quoted",
);
assert.deepEqual(quotedLines(["a > b"]), [false]);
assert.deepEqual(
  quotedLines(["> then /ship when happy.", "Test"]),
  [true, false],
  "a chip's text inside a quoted line keeps it quoted",
);
assert.equal(unquote("> Ask"), "Ask");
assert.equal(unquote("  >"), "");
assert.equal(unquote(">  two spaces"), " two spaces", "only the one space after the marker goes");
console.log("selection ok");
