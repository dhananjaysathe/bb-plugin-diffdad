import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract, Row } from "./server";

// The public (bb connect) URL only works when bb itself is opened through getbb.app; the desktop app reaches localhost.
const frameBase = (s: { url: string; publicUrl: string }) =>
  s.publicUrl && location.hostname.endsWith(".getbb.app") ? s.publicUrl : s.url;

// ponytail: the whole UI is Diff Dad's own, in an iframe. No re-render of narratives here.
function Frame({ path }: { path: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<{ url: string; publicUrl: string; up: boolean } | null>(null);
  useEffect(() => {
    rpc.call("daemon_url").then(setState);
  }, [rpc]);
  if (!state) return <p className="p-4 text-sm text-muted-foreground">Connecting to Diff Dad…</p>;
  if (!state.up)
    return (
      <p className="p-4 text-sm text-muted-foreground">
        No Diff Dad daemon at <code>{state.url}</code>. Start it with <code>dad daemon</code> (or{" "}
        <code>dad daemon install</code> to keep it running).
      </p>
    );
  return <iframe title="Diff Dad" src={frameBase(state) + path} className="h-full w-full border-0" />;
}

function ThreadReview({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [res, setRes] = useState<{ unitId: string | null; error: string | null } | null>(null);
  useEffect(() => {
    rpc.call("thread_unit", { threadId }).then(setRes);
  }, [rpc, threadId]);
  if (!res) return <p className="p-4 text-sm text-muted-foreground">Looking up this thread's PR…</p>;
  if (!res.unitId) return <p className="p-4 text-sm text-destructive">{res.error}</p>;
  return <Frame path={`/units/${res.unitId}`} />;
}

const VERDICT: Record<string, string> = { safe: "text-green-600", caution: "text-amber-600", risky: "text-red-600" };

function ago(iso: string | null): string {
  if (!iso) return "";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

/** One queue row, laid out like Diff Dad's own UnitRow: mark · repo · branch · title, then a meta line. */
function UnitRow({ u, onOpen }: { u: Row; onOpen: () => void }) {
  const approvals =
    u.changesRequested > 0
      ? `${u.changesRequested} requested changes`
      : u.approved === 0
        ? "nobody has approved"
        : `${u.approved} approval${u.approved > 1 ? "s" : ""} already`;
  const size = u.files === null ? null : `${u.files > 100 ? "over 100" : u.files} file${u.files === 1 ? "" : "s"} · +${u.additions ?? 0}/−${u.deletions ?? 0}`;
  return (
    <li>
      <button type="button" onClick={onOpen} className="flex w-full items-start gap-3 px-4 py-2.5 text-left hover:bg-accent/50">
        <span className={`mt-1 text-xs ${u.verdict ? VERDICT[u.verdict] ?? "" : "text-muted-foreground"}`} title={u.verdict ?? "not narrated yet"}>
          {u.verdict ? "▲" : "○"}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm leading-snug">
            <span className="text-muted-foreground">{u.repo}</span>
            {u.branch ? <span className="ml-1.5 font-mono text-xs text-muted-foreground">{u.branch}</span> : null}
            <span className="ml-1.5 font-medium">{u.title}</span>
            {u.draft ? <span className="ml-1.5 rounded border border-border px-1 text-[10px] text-muted-foreground">draft</span> : null}
            {u.author ? <span className="ml-1.5 text-xs text-muted-foreground">@{u.author}</span> : null}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            {u.tags.map((t) => (
              <span key={t} className="rounded bg-red-500/10 px-1.5 py-0.5 text-[11px] text-red-700 dark:text-red-400">{t}</span>
            ))}
            {size ? <span>{size}</span> : null}
            <span>· {approvals}</span>
            {u.verdict ? <span className={VERDICT[u.verdict] ?? ""}>· {u.verdict}{u.toResolve ? `, ${u.toResolve} to resolve` : ""}</span> : null}
            {u.updatedAt ? <span>· {ago(u.updatedAt)}</span> : null}
          </span>
        </span>
        {u.avatarUrl ? <img src={u.avatarUrl} alt="" className="mt-0.5 size-5 rounded-full" /> : null}
      </button>
    </li>
  );
}

const VERDICT_RANK: Record<string, number> = { risky: 3, caution: 2, safe: 1 };
const ms = (iso: string | null) => (iso ? Date.parse(iso) || 0 : 0);

/** Same partition and order as Diff Dad's groupUnits: lanes, then criticality → unapproved → verdict → oldest. */
function groupRows(rows: Row[]): { title: string; note?: string; rows: Row[] }[] {
  const lane = (l: string) => rows.filter((r) => r.lane === l);
  const needsYou = lane("needs-you").sort(
    (a, b) =>
      Number(b.tags.length > 0) - Number(a.tags.length > 0) ||
      Number(b.approved === 0) - Number(a.approved === 0) ||
      (VERDICT_RANK[b.verdict ?? ""] ?? 0) - (VERDICT_RANK[a.verdict ?? ""] ?? 0) ||
      ms(a.unitUpdatedAt) - ms(b.unitUpdatedAt),
  );
  const oldest = (a: Row, b: Row) => ms(a.unitUpdatedAt) - ms(b.unitUpdatedAt);
  const recent = (a: Row, b: Row) => ms(b.unitUpdatedAt) - ms(a.unitUpdatedAt);
  return [
    { title: "Needs you", note: "criticality first, then whether anyone else has approved", rows: needsYou },
    { title: "Probably not", note: "mechanical changes only", rows: lane("probably-not").sort(oldest) },
    { title: "In flight", rows: lane("in-flight").sort(recent) },
    { title: "Cleared", rows: lane("cleared").sort(recent) },
  ].filter((g) => g.rows.length > 0);
}

/** Diff Dad shows every review request, team ones included. This strip lists only the direct ones. */
function Queue() {
  const rpc = useRpc<typeof rpcContract>();
  const [mode, setMode] = useState<"all" | "mine">("mine");
  const [data, setData] = useState<Awaited<ReturnType<typeof rpc.call<"units_mine">>> | null>(null);
  const [unit, setUnit] = useState<string | null>(null);
  const [repo, setRepo] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const load = useCallback(
    (refresh: boolean) => {
      setRefreshing(true);
      rpc.call("units_mine", { refresh }).then(setData).finally(() => setRefreshing(false));
    },
    [rpc],
  );
  useEffect(() => {
    load(false);
  }, [load]);
  // Repo facets, counted on the unfiltered list so picking one never changes the numbers.
  const repos = data
    ? [...new Set(data.mine.map((r) => r.repo))]
        .map((name) => ({ name, needsYou: data.mine.filter((r) => r.repo === name && r.lane === "needs-you").length, total: data.mine.filter((r) => r.repo === name).length }))
        .sort((x, y) => y.needsYou - x.needsYou || x.name.localeCompare(y.name))
    : [];
  const visible = data ? data.mine.filter((r) => repo === null || r.repo === repo) : [];
  const tab = (m: typeof mode, label: string) => (
    <button
      type="button"
      onClick={() => { setMode(m); setUnit(null); }}
      className={`rounded px-2 py-0.5 text-xs ${mode === m ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground"}`}
    >
      {label}
    </button>
  );
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-border px-3 py-1.5">
        {tab("mine", `Needs my review${data ? ` (${data.mine.length})` : ""}`)}
        {tab("all", `All${data ? ` (${data.total})` : ""}`)}
        <span className="ml-auto flex items-center gap-2">
          {unit ? <button type="button" className="text-xs text-muted-foreground" onClick={() => setUnit(null)}>← back</button> : null}
          {mode === "mine" && !unit ? (
            <button type="button" disabled={refreshing} onClick={() => load(true)} className="rounded border border-border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50" title="Poll GitHub and reload">
              {refreshing ? "Refreshing…" : "↻ Refresh"}
            </button>
          ) : null}
        </span>
      </div>
      {mode === "all" || unit ? (
        <Frame path={unit ? `/units/${unit}` : "/"} />
      ) : !data ? (
        <p className="p-4 text-sm text-muted-foreground">Asking GitHub who asked you directly…</p>
      ) : data.error ? (
        <p className="p-4 text-sm text-destructive">{data.error}</p>
      ) : (
        <div className="overflow-y-auto">
          {repos.length > 1 ? (
            <div className="flex flex-wrap items-center gap-1 border-b border-border px-3 py-2">
              {[{ name: null as string | null, label: "All", needsYou: data.mine.filter((r) => r.lane === "needs-you").length }, ...repos.map((r) => ({ name: r.name, label: r.name.split("/").pop() ?? r.name, needsYou: r.needsYou }))].map((f) => (
                <button
                  key={f.name ?? "*"}
                  type="button"
                  onClick={() => setRepo(f.name)}
                  className={`rounded-full border px-2.5 py-0.5 text-xs ${repo === f.name ? "border-foreground/40 bg-accent text-accent-foreground" : "border-border text-muted-foreground hover:text-foreground"}`}
                >
                  {f.label} <span className="opacity-70">{f.needsYou}</span>
                </button>
              ))}
            </div>
          ) : null}
          {data.mine.length === 0 ? <p className="p-4 text-sm text-muted-foreground">Nothing asks for you personally.</p> : null}
          {groupRows(visible).map((g) => (
            <section key={g.title}>
              <h2 className="flex items-baseline gap-2 px-4 pb-1 pt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {g.title} <span className="font-normal">{g.rows.length}</span>
                {g.note ? <span className="font-normal normal-case tracking-normal">{g.note}</span> : null}
              </h2>
              <ul className="divide-y divide-border border-y border-border">
                {g.rows.map((u) => <UnitRow key={u.unitId} u={u} onOpen={() => setUnit(u.unitId)} />)}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "queue",
    title: "Diff Dad",
    icon: "BookOpen",
    path: "queue",
    component: Queue,
  });
  app.slots.threadPanelAction({
    id: "review",
    title: "Review PR in Diff Dad",
    layout: "flush",
    component: ({ threadId }) => <ThreadReview threadId={threadId} />,
  });
});
