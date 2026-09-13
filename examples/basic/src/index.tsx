/* @refresh reload */
import { render } from "solid-js/web";
import { createSignal, For, Show, Suspense, onCleanup, createEffect } from "solid-js";
import { QueryClientProvider, useQuery, useMutation, useQueryClient } from "@tanstack/solid-query";
import { queryClient } from "./queryClient";

interface Note { id: string; title: string; done: boolean; createdAt: string }

const api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
};

function NotesList() {
  const notes = useQuery(() => ({ queryKey: ["notes"], queryFn: () => api<{ items: Note[] }>("/api/notes") }));
  const client = useQueryClient();
  const toggle = useMutation(() => ({
    mutationFn: (n: Note) => api<Note>(`/api/notes/${n.id}`, { method: "PATCH", body: JSON.stringify({ done: !n.done }) }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["notes"] }),
  }));
  const remove = useMutation(() => ({
    mutationFn: (id: string) => api<void>(`/api/notes/${id}`, { method: "DELETE" }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["notes"] }),
  }));
  return (
    <ul data-testid="notes">
      <For each={notes.data?.items ?? []}>
        {(n) => (
          <li class="row" data-note-id={n.id} classList={{ done: n.done }}>
            <label><input type="checkbox" checked={n.done} onChange={() => toggle.mutate(n)} /> {n.title}</label>
            <button onClick={() => remove.mutate(n.id)} aria-label={`delete ${n.title}`}>✕</button>
          </li>
        )}
      </For>
    </ul>
  );
}

function NotesCount() {
  // A second observer of the same query: pulse reports it as "sharing", not "initiating".
  const notes = useQuery(() => ({ queryKey: ["notes"], queryFn: () => api<{ items: Note[] }>("/api/notes") }));
  return <h3 data-testid="notes-count">{notes.data?.items.length ?? "…"} notes</h3>;
}

function NewNote() {
  const client = useQueryClient();
  const [title, setTitle] = createSignal("");
  const create = useMutation(() => ({
    mutationFn: (t: string) => api<Note>("/api/notes", { method: "POST", body: JSON.stringify({ title: t }) }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["notes"] }),
  }));
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (title()) { create.mutate(title()); setTitle(""); } }}>
      <input data-testid="new-note" placeholder="New note" value={title()} onInput={(e) => setTitle(e.currentTarget.value)} />
      <button type="submit">Add</button>
    </form>
  );
}

/** Live feed over the simulator's WebSocket chat protocol (chat-v1) with resume on reconnect. */
function Chat() {
  const [lines, setLines] = createSignal<{ id: string; text: string }[]>([]);
  const [status, setStatus] = createSignal("connecting");
  const [draft, setDraft] = createSignal("");
  let socket: WebSocket | null = null;
  let lastEventID = "";
  let attempts = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const topic = "chat:lobby";

  const connect = () => {
    const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/api/chat/ws`, ["chat-v1"]);
    socket = ws;
    ws.onopen = () => {
      attempts = 0;
      setStatus("open");
      ws.send(JSON.stringify({ type: "subscribe", topic, sinceEventID: lastEventID || undefined }));
    };
    ws.onmessage = (e) => {
      const f = JSON.parse(String(e.data)) as Record<string, string>;
      if (f.eventID) lastEventID = f.eventID;
      if (f.type === "message") setLines((l) => [...l, { id: f.id!, text: `${f.role}: ${f.content}` }]);
      else if (f.type === "chat.content") setLines((l) => {
        const last = l[l.length - 1];
        return last && last.id === f.streamID ? [...l.slice(0, -1), { id: last.id, text: last.text + f.content }] : [...l, { id: f.streamID!, text: f.content! }];
      });
      else if (f.type === "stream.done") setLines((l) => l.filter((x) => x.id !== f.streamID));
      else if (f.type === "resume.miss") setLines((l) => [...l, { id: `miss-${Date.now()}`, text: "⚠ missed events — resync" }]);
    };
    ws.onclose = (e) => {
      setStatus(`closed ${e.code}${e.wasClean ? "" : " (dropped)"} — reconnecting`);
      timer = setTimeout(connect, Math.min(5000, 300 * 2 ** attempts++));
    };
  };
  connect();
  onCleanup(() => { if (timer) clearTimeout(timer); socket?.close(); });

  let feed!: HTMLDivElement;
  createEffect(() => { lines(); queueMicrotask(() => { feed.scrollTop = feed.scrollHeight; }); });

  return (
    <main>
      <div class="feed" ref={feed} data-testid="chat-feed">
        <For each={lines()}>{(l) => <div class="row" data-line-id={l.id}>{l.text}</div>}</For>
      </div>
      <form onSubmit={(e) => { e.preventDefault(); if (draft() && socket?.readyState === 1) { socket.send(JSON.stringify({ type: "send", topic, clientMessageID: String(Date.now()), content: draft() })); setDraft(""); } }}>
        <input data-testid="chat-input" placeholder={`say something (${status()})`} value={draft()} onInput={(e) => setDraft(e.currentTarget.value)} />
        <button type="submit">Send</button>
      </form>
    </main>
  );
}

function App() {
  const [showList, setShowList] = createSignal(true);
  return (
    <QueryClientProvider client={queryClient}>
      <aside>
        <NotesCount />
        <button data-testid="toggle-list" onClick={() => setShowList((v) => !v)}>toggle list (remount)</button>
        <Show when={showList()}>
          <Suspense fallback={<p>loading…</p>}>
            <NotesList />
          </Suspense>
        </Show>
        <NewNote />
      </aside>
      <Chat />
    </QueryClientProvider>
  );
}

render(() => <App />, document.getElementById("root")!);
