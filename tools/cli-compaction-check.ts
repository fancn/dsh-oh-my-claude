#!/usr/bin/env bun
// Live check: dsh's compaction of a Claude session is answered by Claude Code's own `/compact`
// (`cliCompaction`), on a real dsh and a real `claude`.
//
// The offline suite fakes both. This links the checkout into dsh's `acp` profile, where one dsh
// process serves several turns over stdio, so what happens after a turn can be watched. Each
// scenario gets throwaway DSH_HOME, DSH_OMC_STATE_DIR and cwd directories and runs on
// claude-haiku-4-5 with compaction-basic's threshold lowered:
//   s1  dsh's threshold is crossed in a turn's last step: a later turn's start runs /compact once
//   s3  Claude Code's own threshold comes first: its summary reaches dsh's copy with no model call
// A compaction asked for mid-turn is left to the offline suite: the acp profile mounts no web
// server, so the plugin's MCP bridge and its dsh tools are not there to split a turn, and ACP takes
// one prompt per session at a time, so a steer cannot either.
// It spends tokens. dsh loads `lib/`, so run `bun run build` first.
//
//   bun tools/cli-compaction-check.ts [--dsh desktop|<bin.js or executable>] [--only s1,s3] [--keep]
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compactSummaryOf } from "../src/compact-summary.js";
import { projectDirName } from "../src/adapter/transcript-watch.js";
import type { SessionEvent } from "../src/dsh.js";
import { readKeeperInfo } from "../src/process.js";

const REPO = resolve(import.meta.dirname, "..");
const DESKTOP_DSH = "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh";
const MODEL = "claude-haiku-4-5";
const WINDOW = 200_000;

const args = process.argv.slice(2);
/** The word after `name` on the command line, or undefined when the flag is not given. */
const flag = (name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const dshArg = flag("--dsh") ?? "dsh";
const dshPath = dshArg === "desktop" ? DESKTOP_DSH : dshArg;
const dshCommand = dshPath.endsWith(".js") ? ["node", dshPath] : [dshPath];
const only = flag("--only")?.split(",");
const keep = args.includes("--keep");

let failed = 0;
let inconclusive = 0;
/** Print one line and count it when the expectation does not hold. */
const check = (label: string, ok: boolean, detail: string) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  ${detail}`);
};
/** A precondition the run did not reach: no verdict on what depends on it. */
const unmet = (label: string, detail: string) => {
  inconclusive++;
  console.log(`INCONCLUSIVE  ${label}  ${detail}`);
};

/** Three files of about 20,000 tokens each: under the Read tool's per-file cap, 60,000 together. */
function writeReading(cwd: string) {
  const words = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima".split(
    " ",
  );
  for (const part of [1, 2, 3]) {
    const lines: string[] = [];
    for (let i = 1; i <= 1500; i++) {
      const row: string[] = [];
      for (let j = 0; j < words.length; j++) row.push(words[(i + j) % words.length]!);
      lines.push(`part ${part} line ${i}: ${row.join(" ")}`);
    }
    writeFileSync(join(cwd, `part${part}.txt`), `${lines.join("\n")}\n`);
  }
}

/** The launching environment pared down to what dsh and the CLI need. Run from inside a Claude
 *  Code session, the rest (its session id, messaging socket, child-session switches) reaches the
 *  CLI dsh spawns and makes it a child of that session. */
const BASE_ENV: Record<string, string> = Object.fromEntries(
  ["HOME", "PATH", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TERM"]
    .concat(
      ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"].flatMap((k) => [k, k.toLowerCase()]),
    )
    .flatMap((k) => {
      const v = process.env[k];
      return v === undefined ? [] : [[k, v]];
    }),
);

/** dsh's `acp` profile under `home`, with this checkout as one of its bundles. */
function linkProfile(home: string, env: NodeJS.ProcessEnv) {
  execFileSync(dshCommand[0]!, [...dshCommand.slice(1), "--profile", "acp", "--dump-config"], {
    env,
    stdio: "ignore",
  });
  const profile = join(home, "profiles", "acp");
  const manifestPath = join(profile, "package.json");
  // SAFETY: the profile manifest dsh just wrote; only `dsh.profile.bundles` is touched
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    dsh: { profile: { bundles: string[] } };
  };
  manifest.dsh.profile.bundles.push("dsh-oh-my-claude");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  mkdirSync(join(profile, "node_modules"), { recursive: true });
  symlinkSync(REPO, join(profile, "node_modules", "dsh-oh-my-claude"));
}

/** The `--patch` overlay: the model and compaction-basic's threshold for it. */
function patchFile(root: string, ratio: number) {
  // The acp entry picks its sessions' model itself, ahead of agent-default-model.
  const lines = [
    "- id: acp",
    "  config:",
    "    provider: claude-code",
    `    model: ${MODEL}`,
    "- id: agent-default-model",
    "  config:",
    "    provider: claude-code",
    `    model: ${MODEL}`,
    "- id: compaction-basic",
    "  config:",
    "    modelPolicies:",
    "      - provider: claude-code",
    `        model: ${MODEL}`,
    `        thresholdRatio: ${ratio}`,
    "        retainTokens: 2000",
  ];
  const path = join(root, "patch.yml");
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

/** The fields of an ACP answer this script reads: `session/new`'s id, `session/prompt`'s reason. */
type Answer = { sessionId?: string; stopReason?: string };
type Rpc = {
  id?: number;
  method?: string;
  params?: { options?: { optionId: string; kind?: string }[] };
  result?: Answer;
  error?: { message?: string };
};

/** A minimal Agent Client Protocol client over the dsh process's stdio. */
class Acp {
  child: ChildProcess;
  next = 1;
  waiting = new Map<number, { done: (r: Answer) => void; fail: (e: Error) => void }>();
  /** Start dsh's `acp` profile with `patch` laid over it; its stderr is kept in `stderrFile`. */
  constructor(env: NodeJS.ProcessEnv, patch: string, stderrFile: string) {
    this.child = spawn(
      dshCommand[0]!,
      [...dshCommand.slice(1), "--profile", "acp", "--patch", patch],
      { env, stdio: ["pipe", "pipe", "pipe"] },
    );
    let errors = "";
    this.child.stderr?.on("data", (chunk: Buffer) => {
      errors += chunk.toString();
      writeFileSync(stderrFile, errors);
    });
    let buffered = "";
    this.child.stdout?.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      for (let at = buffered.indexOf("\n"); at >= 0; at = buffered.indexOf("\n")) {
        const line = buffered.slice(0, at);
        buffered = buffered.slice(at + 1);
        if (line.trim()) this.receive(line);
      }
    });
  }

  /** One line from dsh: an answer to a request of ours, or a request of its own. A permission
   *  prompt is allowed, since the scenarios only read; anything else is refused. */
  receive(line: string) {
    let msg: Rpc;
    try {
      // SAFETY: a JSON-RPC line from dsh's ACP server; each field read is checked below
      msg = JSON.parse(line) as Rpc;
    } catch {
      return;
    }
    if (msg.method === undefined && msg.id !== undefined) {
      const waiter = this.waiting.get(msg.id);
      this.waiting.delete(msg.id);
      if (msg.error) waiter?.fail(new Error(JSON.stringify(msg.error)));
      else waiter?.done(msg.result ?? {});
      return;
    }
    if (msg.method === "session/request_permission" && msg.id !== undefined) {
      const allow = msg.params?.options?.find((o) => o.kind?.startsWith("allow"));
      const outcome = allow
        ? { outcome: "selected", optionId: allow.optionId }
        : { outcome: "cancelled" };
      this.send({ jsonrpc: "2.0", id: msg.id, result: { outcome } });
    } else if (msg.id !== undefined) {
      this.send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not supported" } });
    }
  }

  /** Write one JSON-RPC message as a line on dsh's stdin. */
  send(msg: object) {
    this.child.stdin?.write(`${JSON.stringify(msg)}\n`);
  }

  /** Send a request and wait for its answer; rejects on an error answer or after `timeoutMs`. */
  request(method: string, params: object, timeoutMs = 600_000): Promise<Answer> {
    const id = this.next++;
    return new Promise((done, fail) => {
      const timer = setTimeout(
        () => fail(new Error(`${method}: no answer in ${timeoutMs} ms`)),
        timeoutMs,
      );
      this.waiting.set(id, {
        done: (r) => {
          clearTimeout(timer);
          done(r);
        },
        fail: (e) => {
          clearTimeout(timer);
          fail(new Error(`${method}: ${e.message}`));
        },
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** Hang up: dsh serves ACP until the client disconnects, then flushes and exits. */
  async close() {
    this.child.stdin?.end();
    const exited = new Promise<void>((done) => this.child.once("exit", () => done()));
    const timedOut = new Promise<boolean>((done) => setTimeout(() => done(true), 20_000));
    if ((await Promise.race([exited.then(() => false), timedOut])) === true) this.child.kill();
  }
}

type Event = Pick<SessionEvent, "type" | "seq" | "data">;

/** The session's dsh log, read once dsh has exited and flushed it. */
function sessionEvents(home: string, sessionId: string): Event[] {
  const root = join(home, "sessions");
  for (const group of existsSync(root) ? readdirSync(root) : []) {
    const dir = join(root, group, sessionId);
    if (!existsSync(dir)) continue;
    const file = readdirSync(dir).find((f) => f.startsWith("session") && f.includes(".jsonl"));
    if (!file) continue;
    const path = join(dir, file);
    const text = path.endsWith(".zstd")
      ? execFileSync("zstd", ["-dc", path]).toString()
      : readFileSync(path, "utf8");
    // SAFETY: dsh's own session log, one event object per line; the header line has no data
    return text
      .split("\n")
      .filter(Boolean)
      .map((l) => ({ data: {}, ...(JSON.parse(l) as Partial<Event>) }) as Event);
  }
  return [];
}

/** The prompt size each step reported, by turn, the way dsh's token meter reads it. */
function promptsByTurn(events: Event[]): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const e of events) {
    if (e.type !== "assistant/message") continue;
    // SAFETY: an assistant/message payload; its usage counters are numbers dsh normalized
    const data = e.data as {
      usage?: Record<string, number>;
      message?: { usage?: Record<string, number> };
    };
    const usage = data.usage ?? data.message?.usage;
    if (!usage) continue;
    const prompt =
      (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
    const turn = Number(e.data.turn);
    out.set(turn, [...(out.get(turn) ?? []), prompt]);
  }
  return out;
}

type Compaction = { turn: number | null; seq: number; error?: string; summary?: string };

/** Every compaction dsh opened, with the turn that owned it (null for one run while idle). */
function compactions(events: Event[]): Compaction[] {
  const byId = new Map<string, Compaction>();
  for (const e of events) {
    const id = String(e.data.compactionId ?? "");
    if (e.type === "compaction/start")
      byId.set(id, { turn: e.data.turn === null ? null : Number(e.data.turn), seq: e.seq });
    const c = byId.get(id);
    if (!c) continue;
    if (e.type === "compaction/summary") {
      // SAFETY: the summary blocks dsh recorded; only their text is joined
      const blocks = e.data.summary as { text?: string }[];
      c.summary = blocks.map((b) => b.text ?? "").join("");
    }
    if (e.type === "compaction/end" && e.data.error !== undefined)
      c.error = JSON.stringify(e.data.error);
  }
  return [...byId.values()];
}

/** The turn numbers in the order the prompts opened them. */
const turnsOf = (events: Event[]) =>
  events.filter((e) => e.type === "turn/start").map((e) => Number(e.data.turn));

/** The newest summary Claude Code wrote under the scenario's cwd. Every transcript there is read:
 *  a compaction can carry the session on in a transcript of its own. */
function cliSummary(cwd: string): string | undefined {
  const dir = join(homedir(), ".claude", "projects", projectDirName(cwd));
  if (!existsSync(dir)) return undefined;
  let found: string | undefined;
  for (const path of readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => join(dir, f))
    .toSorted((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs))
    found = compactSummaryOf(readFileSync(path, "utf8")) ?? found;
  return found;
}

/** The keepers this scenario's plugin started, each with its own and its Claude's pid. */
const keeperPids = (state: string) => {
  const root = join(state, "keepers");
  const dirs = existsSync(root) ? readdirSync(root).map((d) => join(root, d)) : [];
  return dirs.flatMap((d) => {
    const info = readKeeperInfo(d);
    return info ? [info] : [];
  });
};

/** Lines resume.log holds for this session's compactions. */
const routeLog = (state: string, sessionId: string) =>
  (existsSync(join(state, "resume.log")) ? readFileSync(join(state, "resume.log"), "utf8") : "")
    .split("\n")
    .filter((l) => l.includes(`compaction ${sessionId}:`));

/** Whether a process with this pid still runs. */
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Poll `test` every 2 s for up to `ms`; resolves to its last answer. */
const waitFor = async (test: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!test() && Date.now() < end) await new Promise((r) => setTimeout(r, 2000));
  return test();
};

type Run = {
  acp: Acp;
  sessionId: string;
  state: string;
  prompt: (text: string) => Promise<void>;
};
type Scenario = {
  name: string;
  /** compaction-basic's thresholdRatio on a 200k window (headroom caps it at 134,464). 0.4 puts
   *  it at 80,000: over what the CLI keeps after a /compact (about 43,000 on haiku, measured
   *  2026-11-04), under what reading the three files brings (about 150,000). */
  ratio: number;
  env?: Record<string, string>;
  steps: (run: Run) => Promise<void>;
  verify: (v: { events: Event[]; log: string[]; cwd: string; threshold: number }) => void;
};

const READ_ALL =
  "Use your Read tool to read part1.txt, part2.txt and part3.txt in the current directory, each in full.";
const OK = "Reply with exactly: OK";

const SCENARIOS: Scenario[] = [
  {
    name: "s1",
    ratio: 0.4,
    steps: async ({ prompt }) => {
      await prompt(`${READ_ALL} Then reply with only the last line of part3.txt.`);
      for (let i = 0; i < 3; i++) await prompt(OK);
    },
    verify: ({ events, log, cwd, threshold }) => {
      const [t1, ...later] = turnsOf(events);
      const prompts = promptsByTurn(events);
      const crossed = Math.max(...(prompts.get(t1!) ?? [0]));
      if (crossed < threshold)
        return unmet("s1 crossing", `turn 1 peaked at ${crossed} < ${threshold}`);
      const all = compactions(events);
      const shown = JSON.stringify(all.map((c) => ({ turn: c.turn, error: c.error })));
      const at = all[0]?.turn ?? null;
      const done = all.filter((c) => c.error === undefined);
      check(
        "s1 one /compact on the CLI",
        log.filter((l) => l.includes("ran /compact")).length === 1,
        log.join(" | "),
      );
      check("s1 no one-shot", !log.some((l) => l.includes("one-shot")), "");
      // dsh's tool-result pruner can meet its stale figure for a turn before it asks for a summary.
      check(
        "s1 asked at turn 2's or 3's start",
        at !== null && later.slice(0, 2).includes(at),
        shown,
      );
      // After the pruner, the span dsh asks to replace can be smaller than a summary of the whole
      // conversation, and dsh turns the summary down; the CLI is compacted either way.
      check(
        "s1 dsh holds the CLI's summary, or found its span smaller",
        done.length === 1
          ? done[0]!.summary?.trim() === cliSummary(cwd)?.trim()
          : done.length === 0 && all.some((c) => c.error?.includes("not smaller")),
        shown,
      );
      check(
        "s1 asking again in the same check was refused",
        all.slice(1).every((c) => c.turn !== at || c.error?.includes("already")),
        shown,
      );
      const after = later
        .filter((t) => at !== null && t >= at)
        .flatMap((t) => prompts.get(t) ?? []);
      check(
        "s1 the CLI's prompt stays compacted",
        after.length > 0 && after.every((p) => p < threshold),
        `${after}`,
      );
    },
  },
  {
    name: "s3",
    ratio: 0.4,
    // A 100,000-token auto-compact window puts Claude Code's threshold near 67,000 (the window less
    // its output and summary reserves): under dsh's 80,000, over what it keeps after compacting.
    // CLAUDE_AUTOCOMPACT_PCT_OVERRIDE did not take on 2.1.316 under stream-json.
    env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "100000" },
    steps: async ({ prompt, state, sessionId }) => {
      await prompt(`${READ_ALL} Then reply with only the last line of part3.txt.`);
      await waitFor(() => routeLog(state, sessionId).some((l) => l.includes("reused")), 120_000);
      await prompt(OK);
    },
    verify: ({ events, log, cwd }) => {
      const cli = cliSummary(cwd);
      if (cli === undefined || log.some((l) => l.includes("ran /compact")))
        return unmet(
          "s3 Claude Code compacted first",
          `dsh's threshold came first or nothing compacted: ${log.join(" | ") || "no compaction"}`,
        );
      const all = compactions(events);
      const idle = all.filter((c) => c.turn === null && c.error === undefined);
      check(
        "s3 reused the CLI's own compaction",
        log.some((l) => l.includes("reused")),
        log.join(" | "),
      );
      check(
        "s3 dsh holds the CLI's summary",
        idle.length === 1 && idle[0]!.summary?.trim() === cli.trim(),
        JSON.stringify(all.map((c) => ({ turn: c.turn, error: c.error }))),
      );
      check(
        "s3 dsh's own check never fired",
        all.every((c) => c.turn === null),
        "",
      );
      check("s3 no one-shot", !log.some((l) => l.includes("one-shot")), "");
    },
  },
];

/** One scenario in its own throwaway directories, cleaned up after, keepers and transcripts too. */
async function runScenario(s: Scenario) {
  // Short on purpose: the keeper's socket lives under the state dir, and macOS's tmpdir() is long
  // enough to push it past the 104-byte unix socket path limit.
  const root = mkdtempSync(
    join(process.platform === "win32" ? tmpdir() : "/tmp", `omc-${s.name}-`),
  );
  const home = join(root, "home");
  const state = join(root, "state");
  const cwd = join(root, "cwd");
  for (const d of [home, state, cwd]) mkdirSync(d);
  const realCwd = realpathSync(cwd);
  writeReading(realCwd);
  const env = { ...BASE_ENV, DSH_HOME: home, DSH_OMC_STATE_DIR: state, ...s.env };
  const threshold = Math.floor(Math.min(WINDOW * s.ratio, WINDOW - 65_536));
  console.log(`\n== ${s.name} (${root}), dsh threshold ${threshold}`);
  let acp: Acp | undefined;
  let sessionId = "";
  try {
    linkProfile(home, env);
    acp = new Acp(env, patchFile(root, s.ratio), join(root, "dsh.stderr"));
    await acp.request("initialize", { protocolVersion: 1, clientCapabilities: {} }, 120_000);
    // The plugin registers its adapter once the services it injects are up, a few seconds after
    // dsh answers `initialize`; until then dsh has no `claude-code` provider.
    const end = Date.now() + 60_000;
    while (!sessionId) {
      try {
        sessionId =
          (await acp.request("session/new", { cwd: realCwd, mcpServers: [] })).sessionId ?? "";
        if (!sessionId) throw new Error("session/new answered no session id");
      } catch (error) {
        if (Date.now() > end || !String(error).includes("no adapter registered")) throw error;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    const pids = new Set<number>();
    const prompt = async (text: string) => {
      const started = Date.now();
      await acp!.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
      for (const k of keeperPids(state)) pids.add(k.claudePid);
      console.log(
        `   prompt done in ${Math.round((Date.now() - started) / 1000)} s: ${text.slice(0, 50)}`,
      );
    };
    await s.steps({ acp, sessionId, state, prompt });
    await acp.close();
    acp = undefined;
    check(`${s.name} one Claude process throughout`, pids.size === 1, `claude pids ${[...pids]}`);
    s.verify({
      events: sessionEvents(home, sessionId),
      log: routeLog(state, sessionId),
      cwd: realCwd,
      threshold,
    });
  } catch (error) {
    check(
      `${s.name} ran`,
      false,
      `${error instanceof Error ? error.message : error}; dsh stderr: ${join(root, "dsh.stderr")}`,
    );
  } finally {
    await acp?.close();
    const pids = keeperPids(state).flatMap((k) => [k.pid, k.claudePid]);
    for (const pid of pids)
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    // Claude writes its transcript as it exits, which would bring the project directory back.
    await waitFor(() => !pids.some(alive), 10_000);
    rmSync(join(homedir(), ".claude", "projects", projectDirName(realCwd)), {
      recursive: true,
      force: true,
    });
    if (!keep) rmSync(root, { recursive: true, force: true });
  }
}

const built = join(REPO, "lib", "server", "adapter", "class.js");
if (
  !existsSync(built) ||
  statSync(built).mtimeMs < statSync(join(REPO, "src", "adapter", "class.ts")).mtimeMs
) {
  console.error("lib/ is older than src/: run `bun run build` first, dsh loads lib/");
  process.exit(2);
}
console.log(`dsh: ${dshCommand.join(" ")}`);
for (const s of SCENARIOS) if (!only || only.includes(s.name)) await runScenario(s);
console.log(`\n${failed} failed, ${inconclusive} inconclusive`);
process.exit(failed > 0 ? 1 : 0);
