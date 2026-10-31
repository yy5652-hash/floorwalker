import { useEffect, useRef, useState, type CSSProperties } from "react";
import { isFilm } from "../auth";
import "./assistant.css";

type Turn = { role: "user" | "assistant"; content: string };
type Props = { workspaceId?: string; shared?: boolean; demo?: boolean };
const publicQuestions = ["How does it stop a bad refund?", "What does it cost?", "How do I connect my own agent?"];
const workspaceQuestions = ["Why was the last request blocked?", "What needs me today?", "How can I get fewer approvals?"];

export default function Assistant({ workspaceId, shared = false, demo = false }: Props) {
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [contextShared, setContextShared] = useState(shared);
  const [viewport, setViewport] = useState<CSSProperties>({});
  const pending = useRef<AbortController | null>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const publicMode = !workspaceId;
  useEffect(() => {
    const controller = new AbortController();
    // The film shim answers status without touching a model or the server.
    void fetch("/api/assistant/status", { signal: controller.signal }).then(r => r.ok ? r.json() : null).then(s => {
      const film = (window as Window & { __film?: { responses?: { assistant?: string } } }).__film;
      setEnabled(Boolean(s?.enabled) && (!isFilm() || typeof film?.responses?.assistant === "string"));
    }).catch(() => {});
    return () => { controller.abort(); pending.current?.abort(); };
  }, []);
  useEffect(() => {
    const vv = window.visualViewport;
    const update = () => setViewport({ top: vv?.offsetTop ?? 0, height: vv?.height ?? window.innerHeight });
    update(); vv?.addEventListener("resize", update); vv?.addEventListener("scroll", update);
    return () => { vv?.removeEventListener("resize", update); vv?.removeEventListener("scroll", update); };
  }, []);
  useEffect(() => { if (open) input.current?.focus({ preventScroll: true }); }, [open]);
  useEffect(() => { const box = transcript.current; if (box) box.scrollTop = box.scrollHeight; }, [messages, notice]);

  function close() { pending.current?.abort(); setOpen(false); launcher.current?.focus(); }
  async function ask(question: string) {
    const message = question.trim();
    if (!message || message.length > 1000 || pending.current) return;
    const controller = new AbortController(); pending.current = controller;
    const history = messages.filter(m => m.content).slice(-9).map(m => ({ ...m, content: m.content.slice(0, 1000) }));
    setMessages([...history, { role: "user", content: message }, { role: "assistant", content: "" }]);
    setDraft(""); setNotice(""); setBusy(true);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetch(publicMode ? "/api/assistant/public" : "/api/assistant", {
        method: "POST", signal: controller.signal,
        headers: { "Content-Type": "application/json", ...(workspaceId && workspaceId !== "film" ? { "x-workspace": workspaceId } : {}) },
        body: JSON.stringify({ message, history }),
      });
      if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || "The assistant is unavailable. Please try again."); }
      if (!response.body) throw new Error("No response arrived. Please try again.");
      reader = response.body.getReader();
      const decoder = new TextDecoder(); let buffer = "", completed = false;
      while (!completed) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        let n: number;
        while ((n = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, n); buffer = buffer.slice(n + 1);
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (event.type === "token" && typeof event.text === "string") setMessages(current => current.map((m, i) => i === current.length - 1 ? { ...m, content: m.content + event.text } : m));
          if (event.type === "context") setContextShared(event.shared === true);
          if (event.type === "error") throw new Error(event.message);
          if (event.type === "done") completed = true;
        }
        if (done && !completed) throw new Error("The reply was interrupted. Please try again.");
      }
    } catch (error) {
      setNotice(controller.signal.aborted ? "Reply stopped." : error instanceof Error ? error.message : "Please try again.");
    } finally {
      await reader?.cancel().catch(() => {});
      if (pending.current === controller) { pending.current = null; setBusy(false); }
    }
  }
  if (!enabled) return null;
  return (
    <aside className="assistant-shell" style={viewport} aria-label="Ask Floorwalker">
      {open && <section className="assistant-panel" id="assistant-panel" role="dialog" aria-label="Ask Floorwalker" onKeyDown={e => { if (e.key === "Escape") { e.stopPropagation(); close(); } }}>
        <header className="assistant-header"><h2>Ask Floorwalker</h2><button type="button" onClick={close} aria-label="Close assistant">Close</button></header>
        <p className="assistant-disclosure">Answers from DeepSeek. {publicMode || !contextShared ? "Sends chat + product facts." : `Sends chat + ${demo ? "demo" : "workspace"} activity.`}<span className="assistant-disclosure-detail"> {publicMode || !contextShared ? "No workspace activity is sent." : "Includes rules, agents, recent checks, incidents and learning summaries."} Read-only; cannot move money or approve requests.</span></p>
        {!publicMode && <a className="assistant-privacy" href="/app#settings/general" onClick={close}>Privacy settings</a>}
        <div className="assistant-transcript" ref={transcript} role="log" aria-label="Conversation" aria-live="polite" aria-busy={busy}>
          {!messages.length && <div className="assistant-suggestions"><p>What would you like to know?</p>{(publicMode ? publicQuestions : workspaceQuestions).map(q => <button type="button" key={q} onClick={() => void ask(q)}>{q}</button>)}</div>}
          {messages.map((message, index) => <div className={`assistant-message ${message.role}`} key={index}><strong>{message.role === "user" ? "You" : "Floorwalker"}</strong><p>{message.content || (busy ? "Thinking…" : "No reply yet.")}</p></div>)}
        </div>
        {notice && <p className="assistant-notice" role="status">{notice}</p>}
        <form className="assistant-compose" onSubmit={e => { e.preventDefault(); void ask(draft); }}>
          <label htmlFor="assistant-question">Your question</label>
          <textarea ref={input} id="assistant-question" value={draft} maxLength={1000} rows={2} placeholder="Ask about Floorwalker…" onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void ask(draft); } }} />
          <div><span>{draft.length}/1000</span>{busy ? <button type="button" onClick={() => pending.current?.abort()}>Stop</button> : <button type="submit" disabled={!draft.trim()}>Send</button>}</div>
        </form>
      </section>}
      <button type="button" className="assistant-launcher" ref={launcher} aria-expanded={open} aria-controls="assistant-panel" onClick={() => open ? close() : setOpen(true)}>Ask Floorwalker</button>
    </aside>
  );
}
