// The actions dsh's own selection popover shows: its Quote, redrawn here, and Ask. dsh opens one
// plugin's surface per selection, so Ask cannot sit beside Quote as a second entry; this entry
// shadows `message-quotes` in the same cell instead, and dsh's admission still decides when it opens.
import { useEffect, useRef, useState } from "react";
import { t, useLocale } from "./i18n.js";
import {
  ROUTE,
  T,
  DOCK_ATTR,
  inputStyle,
  panelSurface,
  useActiveClaude,
  type ClientCtx,
} from "./shared.js";
import { askBody, QUOTE_MAX } from "./selection.js";
import { useHintFlag } from "./hints.js";

/** The marker the stylesheet (turn-status.tsx) paints dsh's floating pill and the accent on. */
const ACTION_ATTR = "data-omc-selection-action";

/** dsh's `TextInteractionSurface` plus the standard props this entry reads. */
export interface SelectionActionsProps {
  ctx: ClientCtx;
  sessionId?: string;
  readText?: () => string | null;
  dismiss?: () => void;
  clearSelection?: () => void;
  inputActions?: { insertQuote?: (text: string) => boolean };
  useSession?: <V>(
    select: (s: { removed: boolean; subagent: null | { address: { mode: string } } }) => V,
  ) => V;
  /** dsh's `messageQuotes` dictionary, so Quote reads exactly as dsh's own button. */
  t?: (key: string) => string;
}

/** Keeps focus where it is on a press: moving it out of the chat collapses the selection Quote
 *  reads, and Safari, which focuses no button on click, would drop the question box's to the body. */
const keepSelection = (e: React.PointerEvent) => e.preventDefault();

/**
 * Quote does what dsh's button does: dsh's quote chip goes into the composer. Ask, in a Claude
 * session while the switch is on, turns the popover into a question box; Enter sends the passage
 * as an aside, a blank question asks Claude to explain it, and Esc (dsh's) closes the popover.
 */
export function SelectionActions(props: SelectionActionsProps) {
  useLocale();
  const { ctx, sessionId = "", readText, dismiss, clearSelection, inputActions } = props;
  const enabled =
    props.useSession?.(
      (s) => !s.removed && (s.subagent === null || s.subagent.address.mode === "continuable"),
    ) ?? true;
  const claude = useActiveClaude(ctx, sessionId);
  const [off] = useHintFlag("selectionOff");
  const [passage, setPassage] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const fieldRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!enabled) dismiss?.();
  }, [enabled, dismiss]);
  useEffect(() => {
    if (passage !== null) fieldRef.current?.focus();
  }, [passage]);

  const quoteLabel = props.t;
  if (!enabled || readText === undefined || dismiss === undefined || quoteLabel === undefined)
    return null;

  const close = () => {
    clearSelection?.();
    dismiss();
  };

  const quote = () => {
    const text = readText();
    if (text === null) return dismiss();
    if (inputActions?.insertQuote?.(text) !== true) return;
    close();
  };

  const openAsk = () => {
    const text = readText();
    if (text === null) return dismiss();
    setPassage(text.slice(0, QUOTE_MAX));
  };

  const ask = async () => {
    if (passage === null || asking) return;
    setAsking(true);
    setNote("");
    try {
      const r = await fetch(`${ROUTE}/side-questions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(askBody(sessionId, question, passage)),
      });
      if (r.ok) return close();
      setNote(t(r.status === 409 ? "main.selection.noProcess" : "main.selection.askFailed"));
    } catch {
      setNote(t("main.selection.askFailed"));
    } finally {
      setAsking(false);
    }
  };

  // The composer's keys: Enter sends, Shift+Enter breaks the line, and Enter while an input method
  // is composing only commits the candidate. Escape mid-composition only drops the candidate, so
  // it is kept from dsh's document keydown, which would close the popover and lose the question.
  const onFieldKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape" && e.nativeEvent.isComposing) {
      e.stopPropagation();
      return;
    }
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    void ask();
  };

  if (passage === null) {
    return (
      <div style={{ display: "flex", gap: 6 }}>
        <button
          type="button"
          {...{ [ACTION_ATTR]: "quote" }}
          onPointerDown={keepSelection}
          onClick={quote}
        >
          {quoteLabel("quote.add")}
        </button>
        {claude && !off ? (
          <button
            type="button"
            {...{ [ACTION_ATTR]: "ask" }}
            onPointerDown={keepSelection}
            onClick={openAsk}
          >
            {t("main.selection.ask")}
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div
      {...{ [DOCK_ATTR]: "1" }}
      data-omc-selection-ask-panel=""
      style={{
        ...panelSurface,
        boxSizing: "border-box",
        width: 320,
        maxWidth: "100%",
        borderRadius: 12,
        padding: 8,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div
        data-omc-selection-preview=""
        title={passage}
        style={{
          color: T.muted,
          fontSize: 12,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {passage.replace(/\s+/g, " ").trim()}
      </div>
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
          readOnly={asking}
          style={{
            ...inputStyle,
            flex: "1 1 auto",
            height: "auto",
            // Grows with its lines, as the composer does, up to about six, then scrolls.
            fieldSizing: "content",
            maxHeight: 128,
            padding: "5px 10px",
            resize: "none",
            overflowY: "auto",
          }}
        />
        <button
          type="button"
          {...{ [ACTION_ATTR]: "send" }}
          onPointerDown={keepSelection}
          onClick={() => void ask()}
          // Not `disabled`: that moves focus out of dsh's surface, which then closes on the next
          // selectionchange. `ask` already ignores a second press while one is in flight.
          aria-disabled={asking}
        >
          {asking ? t("main.selection.asking") : t("main.selection.ask")}
        </button>
      </div>
      {note !== "" ? (
        <div role="alert" data-omc-selection-note="" style={{ color: T.err, fontSize: 12 }}>
          {note}
        </div>
      ) : null}
    </div>
  );
}
