// Dev-only: drives the selection popover on a live dsh. Opens the Claude session PW_SESSION names
// (a sidebar row's text; pick an idle one, since Quote writes into its composer and the check
// clears it again), selects text in the newest reply and asserts the popover's rules: shows for a
// reply next to it, not for the composer, a trailing boundary at offset 0 still counts, Close and
// Escape hide it, Quote waits for a question, a keyboard selection hands focus to the question box
// once Shift is up, a triple click picks the paragraph, Shift+Enter breaks the question's line
// without asking, the popover pins to the chat's edge while the passage is scrolled away, and
// Quote writes the passage and the question with the caret on the line under them, one blank
// line between quotes however many are made, a reload in between included. Nothing is sent:
// Ask is never pressed.
// PLAYWRIGHT_ROOT names a project with Playwright; arg 1 is dsh's launch token; PW_WIDTH and
// PW_SCHEME pick the viewport (1280, dark by default). Screenshots go to /tmp/pw/.
import { dshUrl, launch, type Page } from "./pw.js";

const [token] = process.argv.slice(2);
const name = process.env.PW_SESSION;
const width = Number(process.env.PW_WIDTH ?? 1280);
const scheme = process.env.PW_SCHEME === "light" ? "light" : "dark";
const narrow = width < 600;
const tag = `${width}-${scheme}`;
let failed = 0;

/** Prints one check's line and counts it when it fails, so the run exits non-zero on any miss. */
const check = (label: string, ok: boolean, got: string | number | boolean) => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(got)}`);
};

/** Selects text in the page through the DOM, the way a drag or a long-press would leave it. */
const select = (p: Page, how: "reply" | "composer" | "trailing") =>
  p.evaluate((mode) => {
    const replies = document.querySelectorAll('[data-chat-flow-kind="assistant-step"] p');
    const last = replies[replies.length - 1];
    const composer = document.querySelector("[data-composer-input]");
    const sel = document.getSelection();
    if (sel === null) return "no selection api";
    sel.removeAllRanges();
    const range = document.createRange();
    if (mode === "composer") {
      if (composer === null) return "no composer";
      composer.textContent = "typed words in the box";
      range.selectNodeContents(composer);
    } else {
      if (last === undefined) return "no reply paragraph";
      range.setStart(last, 0);
      // A triple-click ends at offset 0 of the next block; the composer seat is the one after the
      // newest reply's last paragraph.
      if (mode === "trailing" && composer !== null) range.setEnd(composer, 0);
      else range.setEnd(last, last.childNodes.length);
    }
    sel.addRange(range);
    return sel.toString().slice(0, 60);
  }, how);

/** Selects the first few words of the reply paragraph `back` from the newest, one line of quote
 *  whose text the expected draft can spell out, and returns what was selected. */
const pickShort = (p: Page, back: number) =>
  p.evaluate((k) => {
    const replies = document.querySelectorAll('[data-chat-flow-kind="assistant-step"] p');
    const para = replies[replies.length - 1 - k];
    const text = para && document.createTreeWalker(para, NodeFilter.SHOW_TEXT).nextNode();
    const sel = document.getSelection();
    if (!(text instanceof Text) || sel === null) return "";
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, Math.min(8, text.length));
    sel.removeAllRanges();
    sel.addRange(range);
    return sel.toString().trim();
  }, back);

const b = await launch();
const ctx = await b.newContext({
  viewport: { width, height: narrow ? 844 : 800 },
  colorScheme: scheme,
  isMobile: narrow,
  hasTouch: narrow,
});
const p = await ctx.newPage();
let asked = 0;
p.on("request", (r) => {
  // The aside card polls the route with GET; asking is a POST.
  if (r.method() === "POST" && r.url().includes("/side-questions")) asked++;
});
if (!name) {
  console.log("set PW_SESSION to an idle Claude session's sidebar text");
  await b.close();
  process.exit(1);
}
/** Loads dsh and opens the session PW_SESSION names; returns how many sidebar rows matched. */
const openSession = async () => {
  await p.goto(dshUrl(token), { waitUntil: "networkidle" });
  await p.waitForTimeout(2500);
  // A phone keeps the tree behind dsh's "Open sidebar" button (打开侧边栏 in Chinese dsh).
  const sidebar = p.getByRole("button", { name: /Open sidebar|打开侧边栏/ });
  if (narrow && (await sidebar.count())) {
    await sidebar.first().click({ force: true });
    await p.waitForTimeout(800);
  }
  let row = p.locator('[role="treeitem"]').filter({ hasText: name }).first();
  if ((await row.count()) === 0) {
    const ws = p
      .locator('[role="treeitem"]')
      .filter({ hasText: process.env.PW_WORKSPACE ?? "oh-my-claude" })
      .first();
    if (await ws.count()) await ws.click({ force: true });
    await p.waitForTimeout(1500);
    row = p.locator('[role="treeitem"]').filter({ hasText: name }).first();
  }
  const found = await row.count();
  if (found === 0) return found;
  await row.click({ force: true });
  await p.waitForTimeout(4000);
  // Opened on a phone, dsh's sidebar stays docked and squeezes the chat; its own toggle folds it.
  const collapse = p.getByRole("button", { name: /Collapse sidebar|收起侧边栏/ });
  if (narrow && (await collapse.count())) {
    await collapse.first().click({ force: true });
    await p.waitForTimeout(800);
  }
  return found;
};
const found = await openSession();
check("session row found", found === 1, found);
const bar = p.locator("[data-omc-selection-bar]");
const field = p.locator("[data-omc-selection-question]");
const quoteButton = p.locator("[data-omc-selection-quote]");
const composer = p.locator("[data-composer-input]");
const replies = p.locator('[data-chat-flow-kind="assistant-step"]');
/** How many of the person's messages the chat shows: a check that grows it sent something. */
const sent = () => p.locator('[data-chat-flow-kind="user"]').count();
check("control: reply nodes on screen", (await replies.count()) > 0, await replies.count());
const sentAtStart = await sent();

/** The draft as dsh reads it: paragraphs joined by one newline, a `<br>` is a newline, and the
 *  break Lexical adds to show an empty last line is not text. `innerText` would count two newlines
 *  between paragraphs, which a draft restored after a reload is made of. */
const draftText = () =>
  p.evaluate(() => {
    const box = document.querySelector("[data-composer-input]");
    if (!box) return "";
    return [...box.children]
      .map((para) => {
        let text = "";
        const walk = document.createTreeWalker(
          para,
          NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
        );
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          if (n.nodeType === Node.TEXT_NODE) text += n.textContent ?? "";
          else if (n instanceof HTMLBRElement && !n.hasAttribute("data-lexical-managed-linebreak"))
            text += "\n";
        }
        return text;
      })
      .join("\n");
  });
/** Empties the composer, as the check found it. */
const clearComposer = async () => {
  await composer.click();
  await p.keyboard.press("ControlOrMeta+A");
  await p.keyboard.press("Backspace");
  await p.waitForTimeout(300);
};
/** Selects a short passage, writes `question` in the popover and presses Quote. */
const quoteWith = async (back: number, question: string) => {
  const passage = await pickShort(p, back);
  await p.waitForTimeout(800);
  await field.click();
  await p.keyboard.type(question);
  await quoteButton.click();
  await p.waitForTimeout(500);
  return passage;
};

const picked = await select(p, "reply");
await p.waitForTimeout(800);
check("popover shows for a reply selection", (await bar.count()) === 1, picked);
const gap = await p.evaluate(() => {
  const sel = document.getSelection();
  const lines = sel && sel.rangeCount > 0 ? [...sel.getRangeAt(0).getClientRects()] : [];
  const flat = lines.filter((r) => r.height > 0);
  const first = flat[0];
  const last = flat[flat.length - 1];
  const box = document.querySelector("[data-omc-selection-bar]")?.getBoundingClientRect();
  if (!first || !last || !box) return { off: -1, covers: true };
  const covers = flat.some((r) => r.bottom > box.top && r.top < box.bottom);
  const off = box.top >= last.bottom ? box.top - last.bottom : first.top - box.bottom;
  return { off: Math.round(off), covers };
});
check("the popover sits 8px off the passage", Math.abs(gap.off - 8) <= 1, gap.off);
check("the popover covers none of the passage", !gap.covers, gap.covers);
check(
  "Quote waits for a question",
  (await quoteButton.getAttribute("disabled")) !== null,
  (await quoteButton.getAttribute("disabled")) ?? "enabled",
);
await p.screenshot({ path: `/tmp/pw/selection-popover-${tag}.png` });

await p.evaluate(() => document.getSelection()?.removeAllRanges());
await p.waitForTimeout(500);
check("popover hides when the selection collapses", (await bar.count()) === 0, await bar.count());

await select(p, "trailing");
await p.waitForTimeout(800);
check("a trailing boundary at offset 0 still counts", (await bar.count()) === 1, await bar.count());
await p.locator("[data-omc-selection-close]").click();
await p.waitForTimeout(300);
check("Close hides the popover", (await bar.count()) === 0, await bar.count());

await select(p, "reply");
await p.waitForTimeout(800);
await field.click();
await p.keyboard.press("Escape");
await p.waitForTimeout(300);
check("Escape hides the popover", (await bar.count()) === 0, await bar.count());

// A keyboard selection takes focus into the question box once Shift comes up, since the popover
// is far down the tab order. Chromium extends a selection in static text from the keyboard only
// under caret browsing (F7), which a headless page cannot switch on, so Shift is held while the
// DOM makes the selection.
const newest = p.locator('[data-chat-flow-kind="assistant-step"] p').last();
await p.keyboard.down("Shift");
await select(p, "reply");
await p.waitForTimeout(400);
const heldOff = await p.evaluate(
  () => document.activeElement?.hasAttribute("data-omc-selection-question") !== true,
);
check("no focus taken while Shift is still held", heldOff, heldOff);
await p.keyboard.up("Shift");
await p.waitForTimeout(400);
const keyed = await p.evaluate(
  () => document.activeElement?.hasAttribute("data-omc-selection-question") === true,
);
check(
  "a keyboard selection takes focus into the question box",
  (await bar.count()) === 1 && keyed,
  keyed,
);
await p.keyboard.press("Escape");
await p.waitForTimeout(300);
check(
  "Escape from the question box hides the popover",
  (await bar.count()) === 0,
  await bar.count(),
);

// A real triple click picks the whole paragraph, and the popover keeps clear of it. The clicks
// come faster than a person's, so this checks where it lands, not how it moves in between.
await newest.click({ clickCount: 3 });
await p.waitForTimeout(600);
const tripled = await p.evaluate(() => {
  const ps = document.querySelectorAll('[data-chat-flow-kind="assistant-step"] p');
  const para = ps[ps.length - 1];
  const sel = document.getSelection();
  const box = document.querySelector("[data-omc-selection-bar]")?.getBoundingClientRect();
  const lines = sel && sel.rangeCount > 0 ? [...sel.getRangeAt(0).getClientRects()] : [];
  return {
    whole: (sel?.toString().trim() ?? "") === (para?.textContent ?? "").trim(),
    clear:
      box !== undefined &&
      !lines.some((r) => r.height > 0 && r.bottom > box.top && r.top < box.bottom),
  };
});
check(
  "a triple click picks the paragraph, clear of the popover",
  tripled.whole && tripled.clear,
  JSON.stringify(tripled),
);
await p.locator("[data-omc-selection-close]").click();
await p.waitForTimeout(300);

// The question box keeps the composer's keys: Shift+Enter breaks the line and asks nothing.
await select(p, "reply");
await p.waitForTimeout(800);
await field.click();
await p.keyboard.type("why");
await p.keyboard.press("Shift+Enter");
await p.keyboard.type("and how");
await p.waitForTimeout(200);
const question = await p.evaluate(
  () => document.querySelector<HTMLTextAreaElement>("[data-omc-selection-question]")?.value ?? "",
);
check("Shift+Enter breaks the question's line", question === "why\nand how", question);
check("Shift+Enter asks nothing", asked === 0 && (await bar.count()) === 1, asked);
check(
  "the popover stays while its question box has focus",
  (await bar.count()) === 1,
  await bar.count(),
);
/** Whether the passage is still painted while the page selection is gone. */
const lit = () => p.evaluate(() => CSS.highlights.has("omc-selection"));
check("the passage stays lit while the question is typed", await lit(), await lit());
// Scrolled away mid-question, the popover waits at the chat's edge with the passage named, and
// keeps the question and its focus; scrolled back, it returns to the passage.
/** Scrolls the chat by `dy` and reports the popover's state once it has followed. */
const scrollChat = async (dy: number) => {
  await p.evaluate((d) => {
    document.querySelector("[data-conversation-scroll]")?.scrollBy({ top: d });
  }, dy);
  await p.waitForTimeout(400);
  return p.evaluate(() => {
    const el = document.querySelector<HTMLElement>("[data-omc-selection-bar]");
    return {
      shown: el?.style.visibility === "visible",
      pinned: el?.hasAttribute("data-pinned") === true,
      preview: document.querySelector("[data-omc-selection-preview]") !== null,
      typing: document.activeElement?.hasAttribute("data-omc-selection-question") === true,
    };
  });
};
const away = await scrollChat(-600);
check(
  "scrolled away: pinned, named, still typing",
  away.shown && away.pinned && away.preview && away.typing,
  JSON.stringify(away),
);
await p.screenshot({ path: `/tmp/pw/selection-pinned-${tag}.png` });
const back = await scrollChat(600);
check(
  "scrolled back: beside the passage again",
  back.shown && !back.pinned && !back.preview && back.typing,
  JSON.stringify(back),
);
await p.screenshot({ path: `/tmp/pw/selection-question-${tag}.png` });
await quoteButton.click();
await p.waitForTimeout(500);
check("the popover is gone after Quote", (await bar.count()) === 0, await bar.count());
check("the passage is no longer lit after Quote", !(await lit()), await lit());
const focused = await p.evaluate(
  () => document.activeElement?.hasAttribute("data-composer-input") === true,
);
check("the composer has focus after Quote", focused, focused);
await p.keyboard.type("typed");
await p.waitForTimeout(300);
const one = await draftText();
check(
  "Quote writes the passage, then the question, with the caret on the next line",
  one.startsWith("> ") && one.endsWith("\n\nwhy\nand how\ntyped") && !one.includes("\n\n\n"),
  one.slice(-60),
);
await p.screenshot({ path: `/tmp/pw/selection-quoted-${tag}.png` });
await clearComposer();

// Quote after quote, with and without typing in between: one blank line between blocks, every
// time. Three runs, since the caret placement this guards used to change from run to run.
for (let run = 1; run <= 3; run++) {
  const a = await quoteWith(0, "Q1");
  const bText = await quoteWith(1, "Q2");
  await p.keyboard.type("typed");
  await p.waitForTimeout(300);
  const straight = await draftText();
  const want = `> ${a}\n\nQ1\n\n> ${bText}\n\nQ2\ntyped`;
  check(`run ${run}: two quotes in a row`, straight.trim() === want, straight);
  await clearComposer();

  const c = await quoteWith(0, "Q1");
  await p.keyboard.type("x");
  const d = await quoteWith(1, "Q2");
  await p.keyboard.type("y");
  await p.waitForTimeout(300);
  const typedBetween = await draftText();
  const wantBetween = `> ${c}\n\nQ1\nx\n\n> ${d}\n\nQ2\ny`;
  check(
    `run ${run}: quotes with typing between`,
    typedBetween.trim() === wantBetween,
    typedBetween,
  );
  await clearComposer();
}
// A draft dsh restores after a reload is built from paragraphs, not line breaks: the next quote
// still lands one blank line under it.
const beforeReload = await quoteWith(0, "Q1");
await p.waitForTimeout(1500);
await openSession();
const restored = (await draftText()).includes("Q1");
if (restored) {
  const afterReload = await quoteWith(1, "Q2");
  await p.keyboard.type("typed");
  await p.waitForTimeout(300);
  const reloaded = await draftText();
  check(
    "a quote after a reload",
    reloaded.trim() === `> ${beforeReload}\n\nQ1\n\n> ${afterReload}\n\nQ2\ntyped`,
    reloaded,
  );
} else console.log("skip a quote after a reload: dsh did not restore the draft");
await clearComposer();
check("nothing was sent or asked", (await sent()) === sentAtStart && asked === 0, asked);

// Last, since it writes into the composer's text directly.
await select(p, "composer");
await p.waitForTimeout(800);
check("no popover for text selected in the composer", (await bar.count()) === 0, await bar.count());
await p.keyboard.press("ControlOrMeta+A");
await p.keyboard.press("Backspace");

await b.close();
console.log(
  failed === 0 ? "selection popover: all checks passed" : `selection popover: ${failed} failed`,
);
process.exit(failed === 0 ? 0 : 1);
