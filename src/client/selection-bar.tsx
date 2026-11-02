// The popover over a chat selection: the slot dsh hands the pick-time draft to, the composer it
// writes through, the question box it opens, and the helpers they run through. The entry mounts
// the slot; the popover itself is portalled to the body and placed next to the selection.
import { t, useLocale } from "./i18n.js";
import type { CSSProperties } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ROUTE,
  T,
  btn,
  inputStyle,
  btnPrimary,
  DOCK_ATTR,
  panelSurface,
  useActiveClaude,
  type ClientCtx,
} from "./shared.js";
import {
  askBody,
  chatSelection,
  clampQuote,
  popoverPlacement,
  previewOf,
  QUOTE_MAX,
  quoteInsertion,
  type Placement,
  type Rect,
} from "./selection.js";
import { useHintFlag } from "./hints.js";
import { iconBtn } from "./cards.js";
import { attachTip } from "./tooltip.js";

/** dsh's pick-time draft span (`TokenSpan`, dsh-client-ui-conversation `contract/draft-editor.d.ts`). */
type TokenSpan = { readonly start: number; readonly end: number; readonly draftRev: number };
/** The part of dsh's `InputActions` the selection bar calls. `insertText` returns false while a send
 *  is in flight or when the draft moved under the span. Both calls arrived with dsh 0.1.7, the same
 *  release that put `data-chat-flow-kind` on chat nodes; an older dsh has neither, so no bar. */
type ComposerInsert = {
  captureInsertion?: () => TokenSpan;
  insertText?: (text: string, span: TokenSpan) => boolean;
};
/** The slice of dsh's `InputState` the bar reads: the send phase, and the draft with what tells
 *  whether its text lines up with the insertion span (no chips, no command claim). */
type InputSlice = {
  phase?: "plain" | "adjudicating" | "claimed" | "submitting";
  draft?: string;
  occurrences?: readonly unknown[];
  claim?: unknown;
};

/** Off-screen but read by screen readers: the bar's one-shot announcement. */
const visuallyHidden: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
};

/** The question box grows with its lines up to about six, then scrolls. */
const FIELD_MAX_HEIGHT = 128;
/** The popover's width where the chat has room; a narrower chat (a phone) narrows it. */
const POPOVER_WIDTH = 420;

/** Slot wrapper for the selection bar: off on the box-wide switch, on anything but the active Claude
 *  session, and on a dsh older than 0.1.7, whose composer has no `insertText` for Quote to call. */
export function SelectionSlot({
  sessionId,
  ctx,
  inputActions,
  useInput,
}: {
  sessionId?: string;
  ctx: ClientCtx;
  inputActions?: ComposerInsert;
  useInput?: <T>(select: (state: InputSlice) => T) => T;
}) {
  const sending =
    useInput?.((state) => state.phase === "adjudicating" || state.phase === "submitting") ?? false;
  const draft = useInput?.((state) => state.draft);
  const chipped =
    useInput?.((state) => (state.occurrences?.length ?? 0) > 0 || state.claim !== undefined) ??
    false;
  const [off] = useHintFlag("selectionOff");
  const mine = useActiveClaude(ctx, sessionId ?? "");
  const capture = inputActions?.captureInsertion;
  const insert = inputActions?.insertText;
  if (off || !mine || sessionId === undefined || capture === undefined || insert === undefined)
    return null;
  return (
    <SelectionBar
      key={sessionId}
      sessionId={sessionId}
      sending={sending}
      draft={chipped ? undefined : draft}
      capture={capture}
      insert={insert}
    />
  );
}

/** The composer of the conversation `anchor` sits in, or null when dsh renamed the hooks. */
const composerOf = (anchor: Element | null): HTMLElement | null =>
  anchor
    ?.closest("[data-conversation-scroll]")
    ?.querySelector<HTMLElement>("[data-composer-input]") ?? null;

/** The part of the conversation on screen: the scroller's box above the composer. */
function visibleChat(anchor: Element | null): Rect | null {
  const scroller = anchor?.closest("[data-conversation-scroll]");
  if (!scroller) return null;
  const box = scroller.getBoundingClientRect();
  const composerTop = composerOf(anchor)?.getBoundingClientRect().top ?? box.bottom;
  return {
    left: box.left,
    top: box.top,
    right: box.right,
    bottom: Math.min(box.bottom, composerTop),
  };
}

/** Wrappers that already carry the Quote hint; a ref callback runs on every render. */
const tipped = new WeakSet<HTMLElement>();
/** Hint for Quote while it waits for a question. A disabled button gets no pointer events, so the
 *  hint hangs on a wrapper the button lets them through to while it is disabled. */
function quoteTip(el: HTMLSpanElement | null): void {
  if (el === null || tipped.has(el)) return;
  tipped.add(el);
  attachTip(el, () =>
    el.querySelector("[data-omc-needs-question]") ? t("main.selection.quoteNeedsQuestion") : "",
  );
}

/** How long a selection rests before the popover reads it, by pointer or by keyboard. Short: the
 *  popover floats beside the passage and moves nothing, so a triple click's third click still
 *  lands on the line it aimed at; the popover only moves to the paragraph's end once it does. */
const SELECTION_SETTLE_MS = 150;

/**
 * The selection popover: select text in the chat and it opens next to the passage with a question
 * box, Quote and Ask. Quote needs a question: it writes the passage as a Markdown quote and the
 * question under it into the draft where the composer's caret was, then breaks the line the way
 * Shift+Enter does, so the caret waits on the next line. Ask sends the passage as an aside, so the
 * answer lands in the aside card and the transcript gains nothing. Hides when the selection
 * collapses unless the person is using the popover. Reads dsh's `data-chat-flow-kind` markup
 * through `chatSelection`, which is not a dsh contract. Always renders a hidden anchor in the dock,
 * so it can find its own conversation while hidden.
 */
function SelectionBar({
  sessionId,
  sending,
  draft,
  capture,
  insert,
}: {
  sessionId: string;
  sending: boolean;
  /** The draft text, or undefined when it does not line up with the insertion span. */
  draft: string | undefined;
  capture: () => TokenSpan;
  insert: (text: string, span: TokenSpan) => boolean;
}) {
  useLocale();
  const [picked, setPicked] = useState<{ text: string; trimmed: boolean } | null>(null);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [justShown, setJustShown] = useState(false);
  const [place, setPlace] = useState<Placement | null>(null);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const barRef = useRef<HTMLElement>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  // The selection as it was picked: a cloned range still measures after the page selection
  // collapses, which it does as soon as the question box takes focus.
  const rangeRef = useRef<Range | null>(null);
  // The listener is added once, so it reads these through refs rather than stale closures.
  const holdRef = useRef(false);
  const questionRef = useRef(question);
  questionRef.current = question;
  const askingRef = useRef(asking);
  askingRef.current = asking;
  const shownRef = useRef(false);
  // Set when a keyboard selection is picked: the popover sits at the end of the body, fifteen tab
  // stops past the composer, so a keyboard person is taken into its question box instead.
  const focusFieldRef = useRef(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let release: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      const scroller = anchorRef.current?.closest("[data-conversation-scroll]") ?? null;
      const selection = document.getSelection();
      const text = chatSelection(selection, scroller ?? document.body);
      const inBar = barRef.current?.contains(document.activeElement) === true;
      if (text !== null) {
        // A streaming re-render can shift a live range without collapsing it; the quote must not
        // change under someone typing their question. A new selection takes focus out first.
        if (inBar) return;
        rangeRef.current = selection?.getRangeAt(0).cloneRange() ?? null;
        focusFieldRef.current = byKeys && !shiftHeld;
        setPicked(clampQuote(text));
        setNote("");
        return;
      }
      if (holdRef.current || askingRef.current || inBar || questionRef.current.trim() !== "")
        return;
      setPicked(null);
    };
    // A pointer selection is read once the pointer is released, not while a drag is still
    // moving or paused mid-way. Keyboard selection (Shift+arrows, no pointer down) is read as
    // it rests.
    let pointerDown = false;
    // A keyboard selection is done when Shift comes up; taking focus while Shift is held would
    // end a selection still being extended.
    let byKeys = false;
    let shiftHeld = false;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Shift") shiftHeld = true;
      if (e.shiftKey) byKeys = true;
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== "Shift") return;
      shiftHeld = false;
      if (!byKeys) return;
      clearTimeout(timer);
      timer = setTimeout(read, SELECTION_SETTLE_MS);
    };
    const onChange = () => {
      clearTimeout(timer);
      if (pointerDown) return;
      timer = setTimeout(read, SELECTION_SETTLE_MS);
    };
    const onDown = () => {
      pointerDown = true;
      byKeys = false;
      clearTimeout(timer);
    };
    // A tap collapses the page selection before its click fires, and a mobile browser may send that
    // click in a later task than pointerup, so the hold lasts until the click (or 400 ms without one).
    const onClick = () => {
      clearTimeout(release);
      release = setTimeout(() => (holdRef.current = false), 0);
    };
    const onUp = () => {
      clearTimeout(release);
      release = setTimeout(() => (holdRef.current = false), 400);
      pointerDown = false;
      clearTimeout(timer);
      // A plain click with nothing selected and no bar up has nothing to read.
      if (document.getSelection()?.isCollapsed !== false && !shownRef.current) return;
      timer = setTimeout(read, SELECTION_SETTLE_MS);
    };
    document.addEventListener("selectionchange", onChange);
    window.addEventListener("click", onClick, true);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      clearTimeout(timer);
      clearTimeout(release);
      document.removeEventListener("selectionchange", onChange);
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, []);

  // Announce once per appearance.
  const shown = picked !== null;
  useLayoutEffect(() => {
    if (shown === shownRef.current) return;
    shownRef.current = shown;
    if (!shown) {
      setJustShown(false); // so the next appearance is announced again
      setPlace(null);
      return;
    }
    setJustShown(true);
    const off = setTimeout(() => setJustShown(false), 1000);
    return () => clearTimeout(off);
  }, [shown]);

  // Follow the passage: placed before paint, again on a scroll of the chat, a resize, or the
  // popover changing size (the question box growing, a note appearing). A passage scrolled out of
  // the chat pins the popover to the nearest edge; a range a re-render emptied measures as zero
  // and keeps the last place. An unchanged place sets no state, so a scroll does not re-render.
  useLayoutEffect(() => {
    if (picked === null) return;
    const scroller = anchorRef.current?.closest("[data-conversation-scroll]");
    let frame = 0;
    const update = () => {
      frame = 0;
      const bar = barRef.current;
      // A flat rect is a boundary, not a line: a triple click's range ends on one at the composer.
      const lines = [...(rangeRef.current?.getClientRects() ?? [])].filter((r) => r.height > 0);
      const first = lines[0];
      const last = lines[lines.length - 1];
      const visible = visibleChat(anchorRef.current);
      if (!bar || !first || !last || !visible) return;
      const next = popoverPlacement(
        { first, last },
        { width: POPOVER_WIDTH, height: bar.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
        visible,
      );
      setPlace((was) =>
        was !== null &&
        was.left === next.left &&
        was.top === next.top &&
        was.width === next.width &&
        was.side === next.side &&
        was.pinned === next.pinned
          ? was
          : next,
      );
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(update);
    };
    update();
    scroller?.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const sized = new ResizeObserver(schedule);
    if (barRef.current) sized.observe(barRef.current);
    return () => {
      cancelAnimationFrame(frame);
      scroller?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      sized.disconnect();
    };
  }, [picked]);

  // Keep the passage lit while the popover is open: typing in the question box collapses the page
  // selection, and without this the person loses sight of what they picked.
  useEffect(() => {
    const range = rangeRef.current;
    if (picked === null || range === null || !("highlights" in CSS)) return;
    CSS.highlights.set("omc-selection", new Highlight(range));
    return () => {
      CSS.highlights.delete("omc-selection");
    };
  }, [picked]);

  useEffect(() => {
    if (picked === null || !focusFieldRef.current) return;
    focusFieldRef.current = false;
    fieldRef.current?.focus({ preventScroll: true });
  }, [picked]);

  // The question box grows with its lines, as the composer does, up to FIELD_MAX_HEIGHT.
  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    field.style.height = "auto";
    // scrollHeight leaves out the border, which a border-box height has to hold too.
    const border = field.offsetHeight - field.clientHeight;
    field.style.height = `${Math.min(field.scrollHeight + border, FIELD_MAX_HEIGHT)}px`;
  }, [question, picked]);

  const close = () => {
    rangeRef.current = null;
    setPicked(null);
    setQuestion("");
    setNote("");
  };
  // Close or Escape also lets go of the page selection: the close button keeps it (its mousedown
  // is held back, as every button here), and left in place it would open the popover again.
  const dismiss = () => {
    document.getSelection()?.removeAllRanges();
    close();
  };

  const quote = () => {
    if (picked === null || question.trim() === "") return;
    const s = capture();
    // Collapsed to the end of whatever the composer had selected, so selected text is never replaced.
    const at = { ...s, start: s.end };
    const before = at.end === 0 ? "" : draft === undefined ? null : draft.slice(0, at.end);
    const composer = composerOf(anchorRef.current);
    // dsh leaves the caret alone on an edit made while the composer is unfocused, and focusing it
    // afterwards drops the caret at the draft's start, so focus first and the edit places the caret.
    composer?.focus({ preventScroll: true });
    if (!insert(quoteInsertion(picked.text, question, before), at)) {
      setNote(t("main.selection.quoteBusy"));
      return;
    }
    // The line break is dsh's own Shift+Enter: a newline written into the text would leave the
    // caret after a raw trailing "\n", which the browser draws on either line. Unhandled, the
    // caret simply stays after the question.
    composer?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    close();
  };

  const ask = async () => {
    if (picked === null || asking) return;
    setAsking(true);
    setNote("");
    try {
      const r = await fetch(`${ROUTE}/side-questions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(askBody(sessionId, question, picked.text)),
      });
      if (r.ok) {
        document.getSelection()?.removeAllRanges();
        close();
      } else {
        setNote(t(r.status === 409 ? "main.selection.noProcess" : "main.selection.askFailed"));
      }
    } catch {
      setNote(t("main.selection.askFailed"));
    } finally {
      setAsking(false);
    }
  };

  // The composer's keys: Enter sends (here, Ask), Shift+Enter breaks the line, and Enter while an
  // input method is composing only commits the candidate.
  const onFieldKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    void ask();
  };

  const noQuestion = question.trim() === "";
  const quoteOff = noQuestion || asking || sending;

  return (
    <>
      <span ref={anchorRef} hidden data-omc-selection-anchor="" />
      <span aria-live="polite" style={visuallyHidden}>
        {justShown ? t("main.selection.ready") : ""}
      </span>
      {picked === null
        ? null
        : createPortal(
            // The dock scope, as the aside card has, so the controls take the panel's hover,
            // disabled and focus rules.
            // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- catches Escape from the field and buttons inside and holds the popover through a tap; every action is a real button inside
            <section
              {...{ [DOCK_ATTR]: "1" }}
              ref={barRef}
              aria-label={t("main.selection.region")}
              data-omc-selection-bar=""
              data-side={place?.side}
              data-pinned={place?.pinned === true ? "" : undefined}
              onPointerDown={() => (holdRef.current = true)}
              onMouseDown={(e) => e.target instanceof HTMLButtonElement && e.preventDefault()}
              onKeyDown={(e) => e.key === "Escape" && !e.nativeEvent.isComposing && dismiss()}
              style={{
                ...panelSurface,
                position: "fixed",
                left: place?.left ?? 0,
                top: place?.top ?? 0,
                visibility: place === null ? "hidden" : "visible",
                zIndex: 100,
                boxSizing: "border-box",
                width: place?.width ?? `min(${POPOVER_WIDTH}px, calc(100vw - 24px))`,
                borderRadius: 12,
                padding: 8,
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              {place?.pinned === true ? (
                // Pinned, the passage and its highlight are off screen: name it here instead.
                <div
                  data-omc-selection-preview=""
                  title={picked.text}
                  style={{
                    color: T.muted,
                    fontSize: 12,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {previewOf(picked.text)}
                </div>
              ) : null}
              <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
                <textarea
                  ref={fieldRef}
                  data-omc-selection-question=""
                  rows={1}
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={onFieldKey}
                  aria-label={t("main.selection.questionAria")}
                  placeholder={t("main.selection.questionPlaceholder")}
                  disabled={asking}
                  style={{
                    ...inputStyle,
                    flex: "1 1 auto",
                    height: "auto",
                    padding: "5px 10px",
                    resize: "none",
                    overflowY: "auto",
                  }}
                />
                <button
                  type="button"
                  data-omc-selection-close=""
                  onClick={dismiss}
                  aria-label={t("main.selection.closeAria")}
                  style={{ ...iconBtn, color: T.muted, fontSize: 12, padding: "8px 4px" }}
                >
                  ✕
                </button>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <span style={{ color: T.faint, fontSize: 11, flex: "1 1 auto", minWidth: 0 }}>
                  {picked.trimmed ? t("main.selection.trimmed", { max: String(QUOTE_MAX) }) : ""}
                </span>
                <span ref={quoteTip}>
                  <button
                    type="button"
                    data-omc-selection-quote=""
                    data-omc-needs-question={noQuestion ? "" : undefined}
                    onClick={quote}
                    disabled={quoteOff}
                    style={{ ...btn, pointerEvents: quoteOff ? "none" : undefined }}
                  >
                    {t("main.selection.quote")}
                  </button>
                </span>
                <button
                  type="button"
                  data-omc-selection-ask=""
                  onClick={() => void ask()}
                  disabled={asking}
                  style={btnPrimary}
                >
                  {asking ? t("main.selection.asking") : t("main.selection.ask")}
                </button>
              </div>
              {note !== "" ? (
                <div role="alert" data-omc-selection-note="" style={{ color: T.err, fontSize: 12 }}>
                  {note}
                </div>
              ) : null}
            </section>,
            document.body,
          )}
    </>
  );
}
