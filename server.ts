// bb-plugin-diffdad — wraps a running Diff Dad daemon (https://github.com/nicknisi/diffdad).
// The daemon is loopback-only with no CORS, so the frontend never talks to it
// directly. Everything goes through this backend (Node fetch sends no Origin).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

// ponytail: only the fields we read. The daemon's own zod contracts are the source of truth.
const unitSchema = z.looseObject({
  unitId: z.string(),
  repo: z.string(),
  prNumber: z.number().optional(),
  prUrl: z.string().optional(),
  taskLabel: z.string(),
  status: z.string(),
  lane: z.string().optional(),
  updatedAt: z.string().optional(),
  verdict: z.string().optional(),
  toResolve: z.number().optional(),
  prAuthor: z.string().optional(),
  metadata: z
    .looseObject({
      branch: z.string().optional(),
      draft: z.boolean().optional(),
      additions: z.number().optional(),
      deletions: z.number().optional(),
      changedFiles: z.number().optional(),
      updatedAt: z.string().optional(),
      author: z.looseObject({ avatarUrl: z.string().optional() }).optional(),
    })
    .optional(),
  triage: z.looseObject({ criticality: z.array(z.string()).optional(), truncated: z.boolean().optional() }).optional(),
  reviewRollup: z.looseObject({ approved: z.number().optional(), changesRequested: z.number().optional() }).optional(),
  review: z
    .looseObject({
      narrative: z
        .looseObject({
          verdict: z.string().optional(),
          tldr: z.string().optional(),
          concerns: z.array(z.looseObject({ title: z.string().optional(), question: z.string().optional() })).optional(),
        })
        .optional(),
    })
    .optional(),
});
type Unit = z.infer<typeof unitSchema>;

const rowSchema = z.object({
  unitId: z.string(),
  repo: z.string(),
  prNumber: z.number().nullable(),
  prUrl: z.string().nullable(),
  title: z.string(),
  branch: z.string().nullable(),
  author: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  draft: z.boolean(),
  tags: z.array(z.string()),
  files: z.number().nullable(),
  additions: z.number().nullable(),
  deletions: z.number().nullable(),
  approved: z.number(),
  changesRequested: z.number(),
  verdict: z.string().nullable(),
  toResolve: z.number().nullable(),
  lane: z.string().nullable(),
  updatedAt: z.string().nullable(),
  unitUpdatedAt: z.string().nullable(),
});
export type Row = z.infer<typeof rowSchema>;

export const rpcContract = defineRpcContract({
  daemon_url: { input: z.null(), output: z.object({ url: z.string(), up: z.boolean() }) },
  units_mine: {
    input: z.object({ refresh: z.boolean() }).nullable(),
    output: z.object({
      total: z.number(),
      mine: z.array(rowSchema),
      error: z.string().nullable(),
    }),
  },
  thread_unit: {
    input: z.object({ threadId: z.string() }),
    output: z.object({ unitId: z.string().nullable(), pr: z.string().nullable(), error: z.string().nullable() }),
  },
});

export default async function plugin(bb: BbPluginApi) {
  let unitsCache: { at: number; units: Unit[] } | null = null;
  const settings = bb.settings.define({
    daemonUrl: {
      type: "string",
      label: "Diff Dad daemon URL",
      description: "Where `dad daemon` listens. Default port is 4319; change it if you started the daemon with --port.",
      default: "http://localhost:4319",
    },
    publicUrl: {
      type: "string",
      label: "Diff Dad public URL",
      description:
        "Optional. URL the embedded page loads, for viewing bb from another device (e.g. from `bb connect expose 4319`). The plugin itself still talks to the daemon URL.",
      default: "",
    },
  });
  const normalize = (url: string) => url.trim().replace(/\/$/, "") || "http://localhost:4319";
  let base = normalize((await settings.get()).daemonUrl);
  let publicBase = (await settings.get()).publicUrl.trim().replace(/\/$/, "");
  settings.onChange((next) => {
    base = normalize(next.daemonUrl);
    publicBase = next.publicUrl.trim().replace(/\/$/, "");
    unitsCache = null;
    bb.log.info(`daemon url changed to ${base}`);
  });

  async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(base + path, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
    if (!res.ok) throw new Error(`Diff Dad ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as T;
  }
  async function up(): Promise<boolean> {
    try {
      await api("/api/units");
      return true;
    } catch {
      return false;
    }
  }
  // ponytail: 30s cache so panel renders don't hit the daemon; `add` and a URL change invalidate it.
  async function listUnits(): Promise<Unit[]> {
    if (unitsCache && Date.now() - unitsCache.at < 30_000) return unitsCache.units;
    const { units } = await api<{ units: unknown[] }>("/api/units");
    unitsCache = { at: Date.now(), units: units.map((u) => unitSchema.parse(u)) };
    return unitsCache.units;
  }
  /** Add (or find) a PR in the queue. Accepts a GitHub URL or owner/repo#n. */
  async function addUnit(pr: string): Promise<Unit> {
    const { unit } = await api<{ unit: unknown }>("/api/units", { method: "POST", body: JSON.stringify({ pr }) });
    unitsCache = null;
    return unitSchema.parse(unit);
  }
  /** The PR URL behind a thread's environment, or null. */
  async function threadPr(threadId: string): Promise<string | null> {
    const thread = await bb.sdk.threads.get({ threadId });
    if (!thread.environmentId) return null;
    const result = await bb.sdk.environments.pullRequest({ environmentId: thread.environmentId });
    return result.outcome === "available" ? result.pullRequest.url : null;
  }

  /**
   * PR URLs where *you* (not a team you belong to) are a requested reviewer. Diff Dad's own poll uses
   * `review-requested:@me`, which includes team requests; GitHub's `user-review-requested:@me` doesn't.
   * ponytail: shells out to `gh` like Diff Dad's token lookup does; a 60s cache keeps it off the rate limit.
   */
  let mineCache: { at: number; urls: Set<string> } | null = null;
  async function directlyRequestedUrls(): Promise<Set<string>> {
    if (mineCache && Date.now() - mineCache.at < 60_000) return mineCache.urls;
    const { stdout } = await promisify(execFile)("gh", [
      "api", "-X", "GET", "search/issues", "--paginate",
      "-f", "q=is:open is:pr user-review-requested:@me", "-f", "per_page=100",
      "-q", ".items[].html_url",
    ]);
    mineCache = { at: Date.now(), urls: new Set(stdout.split("\n").filter(Boolean)) };
    return mineCache.urls;
  }
  async function mineUnits(): Promise<{ total: number; mine: Unit[] }> {
    const [units, urls] = await Promise.all([listUnits(), directlyRequestedUrls()]);
    return { total: units.length, mine: units.filter((u) => u.prUrl && urls.has(u.prUrl)) };
  }

  function toRow(u: Unit): Row {
    const m = u.metadata;
    return {
      unitId: u.unitId,
      repo: u.repo,
      prNumber: u.prNumber ?? null,
      prUrl: u.prUrl ?? null,
      title: u.taskLabel,
      branch: m?.branch ?? null,
      author: u.prAuthor ?? null,
      avatarUrl: m?.author?.avatarUrl ?? null,
      draft: m?.draft ?? false,
      tags: [...(u.triage?.criticality ?? []), ...(u.triage?.truncated ? ["truncated"] : [])],
      files: m?.changedFiles ?? null,
      additions: m?.additions ?? null,
      deletions: m?.deletions ?? null,
      approved: u.reviewRollup?.approved ?? 0,
      changesRequested: u.reviewRollup?.changesRequested ?? 0,
      verdict: u.verdict ?? u.review?.narrative?.verdict ?? null,
      toResolve: u.toResolve ?? null,
      lane: u.lane ?? null,
      updatedAt: m?.updatedAt ?? null,
      unitUpdatedAt: u.updatedAt ?? null,
    };
  }

  function summary(u: Unit): string {
    const n = u.review?.narrative;
    const lines = [
      `${u.repo}#${u.prNumber ?? "?"} — ${u.taskLabel} [${u.status}${u.toResolve ? `, ${u.toResolve} to resolve` : ""}]`,
      `  ${base}/units/${u.unitId}`,
    ];
    if (n?.verdict) lines.push(`  verdict: ${n.verdict}${n.tldr ? ` — ${n.tldr}` : ""}`);
    for (const c of n?.concerns ?? []) lines.push(`  - ${c.title ?? c.question ?? ""}`);
    return lines.join("\n");
  }

  bb.rpc.register(rpcContract, {
    daemon_url: async () => ({ url: publicBase || base, up: await up() }),
    units_mine: async (input) => {
      try {
        if (input?.refresh) {
          unitsCache = null;
          mineCache = null;
          // Same as Diff Dad's own ↻ button, but not awaited: a poll takes about a minute
          // (it re-checks every PR), so we reload from the daemon's current state now and
          // let the poll land for the next refresh.
          void api("/api/poll", { method: "POST", body: "{}" }).catch(() => undefined);
        }
        const { total, mine } = await mineUnits();
        return {
          total,
          error: null,
          mine: mine.map(toRow),
        };
      } catch (e) {
        return { total: 0, mine: [], error: e instanceof Error ? e.message : String(e) };
      }
    },
    thread_unit: async ({ threadId }) => {
      try {
        const pr = await threadPr(threadId);
        if (!pr) return { unitId: null, pr: null, error: "This thread has no pull request yet." };
        const unit = await addUnit(pr);
        return { unitId: unit.unitId, pr, error: null };
      } catch (e) {
        return { unitId: null, pr: null, error: e instanceof Error ? e.message : String(e) };
      }
    },
  });

  bb.agents.registerTool({
    name: "diffdad_review",
    description:
      "Get Diff Dad's narrated review of a GitHub pull request: verdict, TL;DR and reviewer concerns. Pass a PR URL or owner/repo#123, or omit it to use this thread's PR. Narration is generated lazily; if the result has no verdict yet, wait a bit and call again.",
    parameters: z.object({ pr: z.string().optional() }),
    presentation: { label: { pending: "Asking Diff Dad", completed: "Asked Diff Dad" } },
    async execute({ pr }, { threadId }) {
      const ref = pr ?? (await threadPr(threadId));
      if (!ref) return "No PR given and this thread has no pull request.";
      const unit = await addUnit(ref);
      if (!unit.review?.narrative) {
        // Trigger lazy narration the way the UI does, then report what we have.
        await api(`/api/units/${unit.unitId}/hydrate`, { method: "POST", body: "{}" }).catch(() => undefined);
      }
      const fresh = (await listUnits()).find((u) => u.unitId === unit.unitId) ?? unit;
      return summary(fresh).slice(0, 8000);
    },
  });

  bb.cli.register({
    name: "diffdad",
    summary: "Diff Dad review queue",
    commands: [
      { name: "list", summary: "List the review queue (--mine: only PRs where you personally are a requested reviewer)", usage: "bb diffdad list [--mine] [--json]" },
      { name: "add", summary: "Add a PR to the queue", usage: "bb diffdad add <pr-url|owner/repo#n>" },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const mine = argv.includes("--mine");
      const [cmd, arg] = argv.filter((a) => a !== "--json" && a !== "--mine");
      if (cmd === "list") {
        const units = mine ? (await mineUnits()).mine : await listUnits();
        return { exitCode: 0, stdout: json ? JSON.stringify(units) : units.map(summary).join("\n") || "Queue is empty." };
      }
      if (cmd === "add" && arg) {
        const unit = await addUnit(arg);
        return { exitCode: 0, stdout: json ? JSON.stringify(unit) : summary(unit) };
      }
      return { exitCode: 1, stderr: "Usage: bb diffdad list [--mine] [--json] | bb diffdad add <pr>" };
    },
  });
}
