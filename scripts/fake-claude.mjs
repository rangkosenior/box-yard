#!/usr/bin/env node
// A stand-in for the `claude` CLI, for trying Box Yard with no Anthropic
// account and for tests. It speaks the same headless protocol Box Yard uses
// (`-p --output-format stream-json`, `--session-id` / `--resume`,
// `--mcp-config`) and calls the real Box Yard MCP tools, driven by keywords in
// the prompt instead of a model.
//
//   CLAUDE_BIN="node scripts/fake-claude.mjs" npm run dev
//
// Orchestrator chat understands:
//   create project <name> [repo owner/name]
//   task <project>: <title> -- <prompt>       (prompt is optional)
//   tell captain <project>: <message>         (send_to_captain)
//   ask captain <project>: <message>          (ask_captain, waits for the reply)
//   wait captain <project>                    (wait_for_captain)
//   status
// A quick question whose prompt carries the state of what it names ("[What this message names …]", server/handoff.ts)
// is answered from that block with no tool call, as the prompt tells a model to.
//   [slow] / [slow:<seconds>]                 (takes 2 s / that long before replying)
//   [fyi]                                     (a Captain marks its reply to the Coordinator FYI: no wake needed)
//   [decide]                                  (a Captain's reply ends with a decision for Cody)
//   [fail]                                    (a Captain's turn fails)
//   [code]                                    (a Captain's code question: repo_clone, then Read and Grep README.md, try to
//                                              Write NEW.md, Edit README.md and Bash `git push` in the clone, each as the run's
//                                              flags allow: see fileTool; the reply says what each did)
// FAKE_CLAUDE_EXIT_MS=<ms> waits that long between the result line and exiting, like the real CLI's exit tail.
// Replies stream word by word, 15 ms apart; FAKE_CLAUDE_WORD_MS=<ms> slows that down (a long reply to type over).
// A Captain answers an agent's message_captain ("[From task … (task_…), an agent …]") when the message has
// [reply] (reply_to_agent) or [reply-task] (send_to_task), after any [slow:<seconds>]; otherwise it doesn't reply.
// A Captain reads Cody's message forwarded from a task's chat ("[From Cody, sent from the chat of task … (task_…) …]")
// and says which queued ids came with it; with [cancel-queued] it cancels the first one (cancel_queued_message).
// A Captain's "📝 Notes retro" wake accepts every suggestion it lists (resolve_suggestion, with a reason) and
// replies "(no update)"; FAKE_RETRO=reject rejects them instead, and FAKE_RETRO=skip leaves them all pending.
// Worker prompts understand these markers anywhere in the text:
//   [ask] [fail] [slow] [slow:<seconds>] [hang] [preview] [artifact] [agent:<taskId>] [note] [noop] [pr]
// [connectors] (any session) connects to the --mcp-config servers besides Box Yard's own, expanding their ${VAR}s from
// the env, and replies with each one's tools (and, for a command with an env_keys tool, the env var names it got).
// [slow:<seconds>] says "Working on it slowly." and then takes that long (a turn to restart Box Yard under).
// [note] suggests a project note (suggest_note) for the Captain's notes retro.
// A line "message captain: <msg>" sends <msg> with message_captain (fire-and-forget); "message captain wait: <msg>"
// or "message captain wait <seconds>: <msg>" waits (default 30 s). The final reply quotes each tool result.
// [hang] keeps the turn running for two minutes (until it's stopped, or a steer comes in).
// Steers: with `--input-format stream-json` the turn's prompt is the first user message on stdin, and each later one
// is a steer the worker reads at its next step (after its [slow] wait, around its Bash call, before its reply), as the
// real CLI folds them in between tool calls; it says so ("Steered mid-turn: …") and the turn's result quotes them.
// [tail:<seconds>] waits that long after the last of those steps, before the result: a steer that comes in then runs
// as one more turn in the same process, with a result of its own, as the real CLI runs a message that missed the turn.
// The CLI exits once stdin ends.
// FAKE_CLAUDE_GATE (env) holds each turn until a test says how it ends; see worker().
// With no marker the worker writes a file, publishes it, and calls finish (it rests, ready for review: only Cody marks
// a task done). [noop] calls finish with outcome "noop" (a quiet schedule run), even alongside [ask] or [fail].
// [pr] ends the turn without finish, like an agent that opened a PR and waits for review.
// Sub-tasks (server/subtasks.ts): "spawn subtasks: A | B > B1, B2 | C" starts A, B and C with spawn_subtasks (B's
// prompt starts B1 and B2 of its own; "C {hang}" gives C's prompt the [hang] marker); "use N sub agents" (as Cody would say it) starts N on angles of the topic, the
// first of them splitting in two when N is 3 or more. [wait] waits for their reports in the same turn
// (wait_for_subtasks); [cancel] cancels them all at once (cancel_subtasks) and finishes without their reports;
// otherwise the turn ends and the reports start the next one. A turn that carries the last report
// answers from all of them and calls finish. A sub-task with nothing to split reports mock findings.
// Logging in: a CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY containing "revoked" fails like a bad token, one
// containing "limited" like a subscription at its usage limit (resetting in an hour), and FAKE_CLAUDE_LOGIN=required
// fails every run that has neither, like the real CLI with no login.
// FAKE_CLAUDE_LIMIT_FILE=<path>: while that file exists every run fails with its text as the error (a usage limit: delete the file to clear it).
// Each turn reports its subscription's limits (a rate_limit_event) unless it runs on an API key; FAKE_CLAUDE_LIMITS=off
// sends none and =full reports the 5-hour window spent.
// The Merge PR button's standard message ("Merge your pull request #N") stands in for `gh pr merge` when
// FAKE_GH_STATE names a file: the worker writes {"state":"MERGED"} there for a test's fake GitHub to read.
// FAKE_CLAUDE_COMPACT_FAIL=1 makes /compact fail (after the summary was written), FAKE_CLAUDE_BAD_SUMMARY=1 the summary.
// Usage, like the real CLI's result: `usage` counts the main loop's calls of that result only, while modelUsage and
// total_cost_usd are the session's running totals (saved with it, so a resumed or forked session goes on from them)
// and also count compaction calls. [autocompact] in a prompt compacts the context at the turn's start (a
// compact_boundary line and one summary call), as the real CLI does on its own near the window's end; /compact makes
// that call too. FAKE_CLAUDE_USD_PER_MTOK=<$> prices every token at that rate (default 0: every run reports $0).
// Side threads: `--resume <id> --resume-session-at <uuid> --fork-session --session-id <new>` copies the session's turns
// up to the one that printed <uuid> into a new session (the original is left alone), as the real CLI forks. Every
// assistant line carries a uuid. A side thread's reply says how many earlier turns it sees and quotes the last one's
// prompt; "try <tool>" in its question calls that Box Yard tool and quotes the result (a read-only check).

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

if (args.includes("--version")) {
  console.log("0.0.0 (fake claude for Box Yard)")
  process.exit(0)
}

const streamInput = flag("--input-format") === "stream-json"
/** stream-json stdin, line by line: the first user message is the turn's prompt, and later ones are steers. */
const inbox = { first: null, steers: [], closed: false, wake: () => {} }
if (streamInput) {
  let buf = ""
  const firstLine = new Promise((resolve) => {
    inbox.wake = resolve
    process.stdin.setEncoding("utf8").on("data", (d) => {
      buf += d
      for (let nl; (nl = buf.indexOf("\n")) >= 0; buf = buf.slice(nl + 1)) {
        let msg
        try {
          msg = JSON.parse(buf.slice(0, nl))
        } catch {
          continue
        }
        if (!inbox.first) {
          inbox.first = msg
          resolve()
        } else if (msg.type === "user") inbox.steers.push(textOf(msg))
        else inbox.control?.(msg)
      }
    })
    process.stdin.on("end", () => {
      inbox.closed = true
      resolve()
    })
  })
  await firstLine
}

function textOf(msg) {
  const c = msg?.message?.content
  return typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => b.text ?? "").join("") : ""
}

// The model list Box Yard's pickers ask for (server/claudeModels.ts): answer stream-json's `initialize` control
// request like the real CLI. FAKE_CLAUDE_MODELS=<json array> replaces the rows; "fail" exits without answering.
if (streamInput && inbox.first?.type !== "user") {
  if (process.env.FAKE_CLAUDE_MODELS === "fail") process.exit(1)
  const all = ["low", "medium", "high", "xhigh", "max"]
  const models = process.env.FAKE_CLAUDE_MODELS
    ? JSON.parse(process.env.FAKE_CLAUDE_MODELS)
    : [
        { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", supportsEffort: true, supportedEffortLevels: all },
        { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus", supportsEffort: true, supportedEffortLevels: all },
        { value: "fable", resolvedModel: "claude-fable-5-2", displayName: "Fable", supportsEffort: true, supportedEffortLevels: all },
        { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet", supportsEffort: true, supportedEffortLevels: all },
        { value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku", supportsEffort: true, supportedEffortLevels: all },
      ]
  const answer = (msg) => {
    if (msg?.type === "control_request" && msg.request?.subtype === "initialize") {
      process.stdout.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: { commands: [], models } } }) + "\n")
    }
  }
  answer(inbox.first)
  inbox.control = answer
  if (inbox.closed) process.exit(0)
  process.stdin.on("end", () => process.exit(0))
  await new Promise(() => {})
}

const partial = args.includes("--include-partial-messages")
const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".fake-claude")
const sessionsDir = path.join(configDir, "fake-sessions")
fs.mkdirSync(sessionsDir, { recursive: true })

const resumeId = flag("--resume")
const newId = flag("--session-id")
const fork = args.includes("--fork-session")
const resumeAt = flag("--resume-session-at") ?? args.find((a) => a.startsWith("--resume-session-at="))?.slice("--resume-session-at=".length)
if (resumeId && newId && !fork) {
  console.error("Error: --session-id can only be used with --continue or --resume if --fork-session is also specified.")
  process.exit(1)
}
const sessionId = fork ? (newId ?? randomUUID()) : (resumeId ?? newId)
const sessionFile = sessionId ? path.join(sessionsDir, `${sessionId}.json`) : null
const resumeFile = resumeId ? path.join(sessionsDir, `${resumeId}.json`) : null

if (resumeId && !fs.existsSync(resumeFile)) {
  console.error(`No conversation found with session ID: ${resumeId}`)
  process.exit(1)
}
if (newId && fs.existsSync(sessionFile)) {
  console.error(`Session ID ${newId} is already in use.`)
  process.exit(1)
}

const WINDOW = Number(process.env.FAKE_CLAUDE_WINDOW || 200_000)
const PER_TURN = Number(process.env.FAKE_CLAUDE_TOKENS_PER_TURN || 3000)
// The summary lists the live tasks Box Yard gave it, like a real one would.
const liveTasks = (prompt) => /Live task state from Box Yard[^\n]*\n((?:- .*\n?)+)/.exec(prompt)?.[1]?.trim()
const fmt = (n) => (n >= 1e6 ? `${n / 1e6}m` : n >= 1e3 ? `${Math.round(n / 100) / 10}k` : String(n))
// Record how we were called, so tests can check flags (set FAKE_CLAUDE_LOG to a file).
// FAKE_CLAUDE_LOG_FULL=1 logs the whole prompt instead of its first 120 characters.

const session = resumeId ? JSON.parse(fs.readFileSync(resumeFile, "utf8")) : { id: sessionId, turns: [] }
session.tokens ??= 0
if (resumeAt) {
  // Only the turns up to and including the one that printed that line, like the real CLI's chain cut.
  const at = session.turns.findIndex((t) => (t.uuids ?? []).includes(resumeAt))
  if (at < 0) {
    console.error(`No message found with message.uuid of: ${resumeAt}`)
    process.exit(1)
  }
  session.turns = session.turns.slice(0, at + 1)
}
if (fork) Object.assign(session, { id: sessionId, forkedFrom: resumeId, forkedAt: resumeAt ?? null })
/** The uuids of the assistant lines this run prints (a later fork can cut there). */
const uuids = []
const usageNow = () => ({ input_tokens: session.tokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 10 })
/** Every call the session has made, in modelUsage's names: what the result's modelUsage and total_cost_usd report. */
session.spent ??= { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
const spend = (u) => {
  session.spent.inputTokens += u.input_tokens ?? 0
  session.spent.cacheCreationInputTokens += u.cache_creation_input_tokens ?? 0
  session.spent.cacheReadInputTokens += u.cache_read_input_tokens ?? 0
  session.spent.outputTokens += u.output_tokens ?? 0
}
const spentUsd = () => (Object.values(session.spent).reduce((a, n) => a + n, 0) * Number(process.env.FAKE_CLAUDE_USD_PER_MTOK || 0)) / 1e6
/** One compaction: the summary call reads the whole context and writes the summary, and the context shrinks to it. */
const compactCall = () => {
  spend({ input_tokens: 40, cache_creation_input_tokens: 600, cache_read_input_tokens: session.tokens, output_tokens: 1500 })
  session.tokens = 2000
}
const out = (obj) => {
  // Every assistant message carries the usage of its API call, like the real CLI.
  if (obj.type === "assistant") {
    obj.message.usage = usageNow()
    obj.uuid = randomUUID()
    obj.session_id = session.id
    uuids.push(obj.uuid)
  }
  if (flag("--output-format") !== "stream-json") return // plain text mode prints only the text
  process.stdout.write(JSON.stringify(obj) + "\n")
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- MCP clients

function loadMcp() {
  const file = flag("--mcp-config")
  if (!file) return null
  const cfg = JSON.parse(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : file)
  // Box Yard's own server is `boxyard`; a session's connectors (docs/connectors.md › Sessions) sit beside it.
  const server = cfg.mcpServers?.boxyard ?? Object.values(cfg.mcpServers ?? {})[0]
  if (!server) return null
  const client = server.type === "http" ? httpClient(server) : stdioClient(server)
  client.kind = server.type === "http" ? "orchestrator" : "worker"
  return client
}

function httpClient(server) {
  let id = 0
  const call = async (method, params) => {
    const res = await fetch(server.url, {
      method: "POST",
      headers: { ...server.headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    })
    const body = await res.json()
    if (body.error) throw new Error(body.error.message)
    return body.result
  }
  return {
    async init() {
      await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-claude", version: "0" } })
      // Like the real CLI, which lists the tools before it's ready.
      await call("tools/list", {})
    },
    tool: (name, args) => call("tools/call", { name, arguments: args }),
    list: () => call("tools/list", {}),
    close() {},
  }
}

function stdioClient(server) {
  const child = spawn(server.command, server.args ?? [], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, ...server.env } })
  let id = 0
  let buf = ""
  const waiting = new Map()
  child.stdout.on("data", (d) => {
    buf += d
    const lines = buf.split("\n")
    buf = lines.pop()
    for (const line of lines) {
      if (!line.trim()) continue
      const msg = JSON.parse(line)
      waiting.get(msg.id)?.(msg)
      waiting.delete(msg.id)
    }
  })
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const myId = ++id
      waiting.set(myId, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)))
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n")
    })
  return {
    async init() {
      await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-claude", version: "0" } })
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n")
      await call("tools/list", {})
    },
    tool: (name, args) => call("tools/call", { name, arguments: args }),
    list: () => call("tools/list", {}),
    close: () => child.stdin.end(),
  }
}

/** ${VAR} and ${VAR:-default} in a config value, from this process's env, as the real CLI expands them. */
const expandVars = (v) => v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, k, d) => process.env[k] ?? d ?? "")
const expandAll = (o) => Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k, expandVars(v)]))

/**
 * [connectors]: connect to every server in --mcp-config besides Box Yard's own (a session's connectors,
 * docs/connectors.md › Sessions), expanding its ${VAR}s like the real CLI, and say what each offers. A command
 * connector with an env_keys tool also says which env vars it got. Never prints a value.
 */
async function connectorsCheck() {
  const file = flag("--mcp-config")
  const cfg = file ? JSON.parse(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : file) : {}
  const lines = []
  for (const [name, server] of Object.entries(cfg.mcpServers ?? {})) {
    if (name === "boxyard") continue
    const client =
      server.type === "stdio"
        ? stdioClient({ ...server, command: expandVars(server.command), args: (server.args ?? []).map(expandVars), env: expandAll(server.env) })
        : httpClient({ ...server, url: expandVars(server.url), headers: expandAll(server.headers) })
    try {
      await client.init()
      const tools = (await client.list()).tools.map((t) => t.name)
      let line = `Connector ${name}: tools ${tools.join(", ")}`
      if (tools.includes("env_keys")) line += `; env ${JSON.parse((await client.tool("env_keys", {})).content[0].text).join(", ")}`
      lines.push(line)
    } catch (err) {
      lines.push(`Connector ${name}: failed (${String(err.message).slice(0, 80)})`)
    } finally {
      client.close()
    }
  }
  return lines.length ? lines.join("\n") : "No connectors."
}

// ---------------------------------------------------------------- output helpers

async function say(text) {
  if (partial) {
    for (const word of text.split(/(?<= )/)) {
      out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: word } } })
      await sleep(Number(process.env.FAKE_CLAUDE_WORD_MS) || 15)
    }
  }
  out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } })
}

function withNextSteps(text, steps) {
  return `${text}\n\n<!-- boxyard-next-steps\n${JSON.stringify(steps)}\n-->`
}

async function useTool(mcp, name, input) {
  const id = `t${Date.now()}`
  out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name: `mcp__boxyard__${name}`, input }] } })
  const result = await mcp.tool(name, input)
  const text = result?.content?.map((c) => c.text).join("") ?? ""
  out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: Boolean(result?.isError) }] } })
  return text
}

function sh(cmd) {
  return new Promise((resolve) => {
    const p = spawn("bash", ["-c", cmd], { stdio: "ignore" })
    p.on("close", (code) => resolve(code))
  })
}

// The CLI's own file tools, as far as a test needs them, under its permission rules: a tool missing from --tools doesn't
// exist; a --disallowedTools rule denies it, then an --allowedTools rule allows it; a read in the working folder is
// allowed; anything else is denied (dontAsk). Edit rules cover every tool that edits files, Read rules every one that
// reads them, as the CLI applies them. Path rules here are absolute ones only: `Read(//abs/dir/**)`.
const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit"])
const READ_TOOLS = new Set(["Read", "Grep", "Glob"])

function rulesOf(name) {
  return (flag(name) ?? "")
    .split(",")
    .map((r) => r.trim().match(/^(\w+)(?:\((.*)\))?$/))
    .filter(Boolean)
    .map((m) => ({ tool: m[1], pattern: m[2] ?? null }))
}

function ruleCovers(rule, tool, file) {
  const family = EDIT_TOOLS.has(tool) ? "Edit" : READ_TOOLS.has(tool) ? "Read" : tool
  if (rule.tool !== tool && rule.tool !== family) return false
  if (rule.pattern === null) return true
  if (!rule.pattern.startsWith("//") || !file) return false
  const dir = rule.pattern.slice(1).replace(/\/\*\*$/, "")
  return file === dir || file.startsWith(dir + "/")
}

/** Why the run may not use `tool` on `file`, or null when it may. */
function refusal(tool, file) {
  const tools = flag("--tools")
  if (tools !== undefined && !tools.split(",").includes(tool)) return `No such tool available: ${tool}`
  if (rulesOf("--disallowedTools").some((r) => ruleCovers(r, tool, file))) return `Permission to use ${tool} has been denied.`
  if (rulesOf("--allowedTools").some((r) => ruleCovers(r, tool, file))) return null
  const cwd = process.cwd()
  if (READ_TOOLS.has(tool) && file && (file === cwd || file.startsWith(cwd + "/"))) return null
  return `Permission to use ${tool} has been denied because Claude Code is running in don't ask mode.`
}

/** The files under `dir` (but .git) whose text matches `pattern`, relative to it. */
function grep(dir, pattern) {
  const re = new RegExp(pattern)
  const found = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".git") continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile() && re.test(fs.readFileSync(p, "utf8"))) found.push(path.relative(dir, p))
    }
  }
  walk(dir)
  return found.length ? found.join("\n") : "No matches found"
}

/** Run one of the CLI's own tools, if the run's permissions let it: what it said, and whether it worked. */
async function fileTool(tool, input) {
  const id = `b${Date.now()}${Math.random().toString(36).slice(2, 6)}`
  out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name: tool, input }] } })
  const target = input.file_path ?? input.path ?? null
  let text = refusal(tool, target && path.resolve(target))
  let ok = !text
  if (ok) {
    try {
      if (tool === "Read") text = fs.readFileSync(input.file_path, "utf8")
      else if (tool === "Grep") text = grep(input.path, input.pattern)
      else if (tool === "Write") (fs.writeFileSync(input.file_path, input.content), (text = `File created successfully at: ${input.file_path}`))
      else if (tool === "Edit") {
        const was = fs.readFileSync(input.file_path, "utf8")
        if (!was.includes(input.old_string)) throw new Error("String to replace not found in file.")
        fs.writeFileSync(input.file_path, was.replace(input.old_string, input.new_string))
        text = `The file ${input.file_path} has been updated.`
      } else text = `(mock) ${tool} ran`
    } catch (err) {
      ok = false
      text = err.message
    }
  }
  out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: !ok }] } })
  return { ok, text }
}

/** A Captain's code question ([code]): open its clone, read and search it, then try to change it and push. */
async function codeQuestion(mcp) {
  const raw = await useTool(mcp, "repo_clone", {})
  let clone = null
  try {
    clone = JSON.parse(raw)
  } catch {}
  if (!clone?.path) return [`repo_clone said: ${raw.slice(0, 300)}`]
  const lines = [`Read from the clone at ${clone.path} (${clone.status}, synced ${clone.synced}, ${clone.commit}).`]
  if (clone.stale) lines.push(`Stale: ${clone.stale}`)
  const readme = path.join(clone.path, "README.md")
  const tries = [
    ["Read", { file_path: readme }],
    ["Grep", { pattern: "hello", path: clone.path }],
    ["Write", { file_path: path.join(clone.path, "NEW.md"), content: "written by the Captain\n" }],
    ["Edit", { file_path: readme, old_string: "hello", new_string: "edited" }],
    ["Bash", { command: `git -C ${clone.path} push` }],
  ]
  for (const [tool, input] of tries) {
    const r = await fileTool(tool, input)
    lines.push(`- ${tool} ${r.ok ? "worked" : "was refused"}: ${r.text.trim().split("\n")[0].slice(0, 200)}`)
  }
  return lines
}

// ---------------------------------------------------------------- behaviors

/** A Captain's notes retro: settle every suggestion it names. */
async function notesRetro(mcp, prompt) {
  const ids = [...new Set([...prompt.matchAll(/`(sug_[A-Za-z0-9_-]+)`/g)].map((m) => m[1]))]
  const mode = process.env.FAKE_RETRO
  const action = mode === "reject" ? "reject" : "accept"
  await useTool(mcp, "list_notes", {})
  if (mode !== "skip") for (const id of ids) await useTool(mcp, "resolve_suggestion", { suggestion: id, action, reason: `mock retro ${action}` })
  await say("(no update)")
  return "(no update)"
}

/**
 * A reply thread's routing (server/sideThreads.ts routeRules): "a new task" or "split" goes to the main chat; an
 * instruction ("fix…", "please make…", "go ahead") to the task's agent (or the main chat, when the thread has no task);
 * anything else, a question above all, is answered.
 */
function mockRoute(prompt, question) {
  if (!prompt.includes("[[route:chat]]")) return null
  const q = question.trim()
  if (/\?\s*$/.test(q)) return null
  if (/\b(new task|separate task|split)\b/i.test(q)) return "chat"
  if (!/^(please\s+)?(fix|change|make|add|remove|use|rename|update|go ahead|do it|ship|switch|move|revert|retry|run|drop|keep|stop)\b/i.test(q)) return null
  return prompt.includes("[[route:agent]]") ? "agent" : "chat"
}

/** A side thread's turn: what it can see of the chat it forked, and any tool its question asks to try. */
async function sideThread(mcp, prompt) {
  const earlier = session.turns.filter((t) => !t.thread)
  const question = /\[Box Yard side thread\]|\[\[route:chat\]\]|answered here in the thread/.test(prompt) ? (prompt.split(/'s (?:question|reply):\n/).pop() ?? prompt) : prompt
  const route = mockRoute(prompt, question)
  if (route) {
    await say(`[[route:${route}]]`)
    return `[[route:${route}]]`
  }
  const lines = [`Side thread answer (mock Claude). I can see ${earlier.length} earlier chat turn${earlier.length === 1 ? "" : "s"}${session.forkedFrom ? " (forked)" : ""}.`]
  const last = earlier.at(-1)
  if (last) lines.push(`The last one asked: "${last.prompt.split("\n").filter((l) => l.trim() && !l.startsWith("[Yard now]") && !l.startsWith("- ")).pop()?.slice(0, 120) ?? ""}"`)
  if (/Your session for this thread was started fresh/.test(prompt)) lines.push("I started fresh from the summary.")
  // A reply thread's first prompt quotes the message replied to.
  const original = prompt.match(/The message .+ is replying to:\n((?:> .*\n?)+)/)
  if (original) lines.push(`Replying to: "${original[1].replace(/^> /gm, "").trim().split("\n")[0].slice(0, 120)}"`)
  lines.push(`You asked: ${question.trim().slice(0, 200)}`)
  const tool = question.match(/\btry (\w+)/i)
  if (tool) lines.push(`${tool[1]} said: ${(await useTool(mcp, tool[1], tool[1] === "create_task" ? { project: "demo", title: "From a side thread", prompt: "x" } : {})).slice(0, 300)}`)
  if (/\[slow\]/i.test(question)) await sleep(2000)
  await say(lines.join("\n\n"))
  return lines.join("\n")
}

const NAMED_BLOCK = /^\[(?:What|Tasks) this message names[^\n]*\]\n((?:(?:- |  |Projects it names).*(?:\n|$))*)/m

async function orchestrator(mcp, prompt) {
  if (prompt.includes("📝 **Notes retro**")) return notesRetro(mcp, prompt)
  if (prompt.includes("[Box Yard side thread]") || session.thread) {
    session.thread = true
    return sideThread(mcp, prompt)
  }
  // The state of what the message names (server/handoff.ts): a model answers a quick question from it, without a lookup.
  const named = prompt.match(NAMED_BLOCK)
  const text = prompt
    .replace(NAMED_BLOCK, "")
    .split("\n")
    .filter((l) => !l.startsWith("- ") && !l.startsWith("[Box Yard") && !l.startsWith("[Yard now]"))
    .join("\n")
    .trim()
  const lines = []
  let m
  if ((m = text.match(/create project\s+"?([\w .-]+?)"?(?:\s+repo\s+(\S+))?\s*$/im))) {
    const r = await useTool(mcp, "create_project", { name: m[1].trim(), ...(m[2] ? { repo: m[2] } : {}) })
    lines.push(`Created project **${m[1].trim()}**.`, "```json", r.slice(0, 400), "```")
  }
  const taskRe = /^task\s+([\w .-]+?):\s*(.+?)(?:\s+--\s+(.+))?$/gim
  while ((m = taskRe.exec(text))) {
    const r = await useTool(mcp, "create_task", { project: m[1].trim(), title: m[2].trim(), prompt: (m[3] ?? m[2]).trim() })
    lines.push(r.startsWith("{") ? `Started task **${m[2].trim()}** in ${m[1].trim()}.` : `Couldn't start that task: ${r}`)
  }
  const scheduleRe = /^schedule\s+([\w .-]+?)\s+"([^"]+)":\s*(.+?)(?:\s+--\s+(.+))?$/gim
  while ((m = scheduleRe.exec(text))) {
    const r = await useTool(mcp, "create_schedule", { project: m[1].trim(), cron: m[2], name: m[3].trim(), prompt: (m[4] ?? m[3]).trim() })
    lines.push(r.startsWith("{") ? `Scheduled **${m[3].trim()}** in ${m[1].trim()} (\`${m[2]}\`).` : `Couldn't create that schedule: ${r}`)
  }
  // Orchestrator schedule (no project): `oschedule "<cron>": <name> -- <prompt>`
  const oscheduleRe = /^oschedule\s+"([^"]+)":\s*(.+?)(?:\s+--\s+(.+))?$/gim
  while ((m = oscheduleRe.exec(text))) {
    const r = await useTool(mcp, "create_schedule", { cron: m[1], name: m[2].trim(), prompt: (m[3] ?? m[2]).trim() })
    lines.push(r.startsWith("{") ? `Scheduled **${m[2].trim()}** for the orchestrator (\`${m[1]}\`).` : `Couldn't create that schedule: ${r}`)
  }
  const captainRe = /^(ask|tell) captain\s+([\w .-]+?):\s*(.+)$/gim
  while ((m = captainRe.exec(text))) {
    const ask = m[1].toLowerCase() === "ask"
    const r = await useTool(mcp, ask ? "ask_captain" : "send_to_captain", { project: m[2].trim(), message: m[3].trim(), ...(ask ? { timeout_seconds: 30 } : {}) })
    lines.push(ask ? `The ${m[2].trim()} Captain answered.` : `Sent that to the ${m[2].trim()} Captain.`, "```json", r.slice(0, 300), "```")
  }
  if ((m = text.match(/^wait captain\s+([\w .-]+?)\s*$/im))) {
    await useTool(mcp, "wait_for_captain", { project: m[1].trim(), timeout_seconds: 30 })
    lines.push(`The ${m[1].trim()} Captain is done.`)
  }
  if ((m = text.match(/^delete schedule\s+(.+?)\s*$/im))) {
    lines.push(await useTool(mcp, "delete_schedule", { schedule: m[1] }))
  }
  // Cody's messages forwarded from a task's chat (TaskManager.forwardToCaptain): the task's queue comes with each.
  const forwardRe = /^\[From [^\n]+?, sent from the chat of task .*?\((task_[\w-]+)\)[^\n]*\]\n([\s\S]*?)(?=\n\[From |(?![\s\S]))/gm
  while ((m = forwardRe.exec(prompt))) {
    const ids = [...m[2].matchAll(/^- (in_[\w-]+) /gm)].map((x) => x[1])
    lines.push(`Forwarded from ${m[1]} with ${ids.length ? `queued ${ids.join(", ")}` : "no queued messages"}.`)
    if (/\[cancel-queued\]/i.test(m[2]) && ids[0]) {
      const r = await useTool(mcp, "cancel_queued_message", { task: m[1], message_id: ids[0] })
      lines.push(`Cancelled ${ids[0]}: ${r.slice(0, 200)}`)
    }
  }
  const captain = prompt.includes("[Project now: ")
  if (captain && /\[code\]/i.test(text)) lines.push(...(await codeQuestion(mcp)))
  if (!lines.length && named) {
    lines.push(`Here's what you asked about:\n${named[1].trim()}`)
  } else if (!lines.length || /status|what.*(up|going)/i.test(text)) {
    const r = await useTool(mcp, "list_tasks", {})
    let tasks = []
    try {
      tasks = JSON.parse(r)
    } catch {}
    lines.push(
      tasks.length ? `Here's the yard:\n${tasks.map((t) => `- **${t.title}** (${t.project}): ${t.status}`).join("\n")}` : "No tasks yet.",
      "",
      "_This is the mock Claude. Try `create project demo`, then `task demo: Write a haiku -- write a haiku about boxes [artifact]`, or `schedule demo \"*/5 * * * *\": Haiku drop -- write a haiku [artifact]`._",
    )
  }
  if (/\[slow\]/i.test(text)) await sleep(2000)
  if ((m = text.match(/\[slow:(\d+)\]/i))) await sleep(Number(m[1]) * 1000)
  // Agents' message_captain messages: reply when they ask for it.
  const agentRe = /^\[From task .*?\((task_[\w-]+)\), an agent[^\n]*\]\n([^\n]*)/gm
  while ((m = agentRe.exec(text))) {
    if (/\[reply\]/i.test(m[2])) await useTool(mcp, "reply_to_agent", { task: m[1], message: "Captain reply: go ahead, that's in scope." })
    else if (/\[reply-task\]/i.test(m[2])) await useTool(mcp, "send_to_task", { task: m[1], message: "Captain reply via send_to_task: go ahead." })
    else continue
    lines.push(`Answered ${m[1]}.`)
  }
  if (captain && /\[fail\]/i.test(text)) throw new Error("fake Captain failure")
  if (captain && /\[decide\]/i.test(text)) lines.push("", "The owner needs to decide: merge PR #1 now, or after the release.")
  // A Captain's reply that's only for Cody's information says so, so it doesn't wake the Coordinator.
  const fyi = captain && /\[fyi\]/i.test(text) ? "\n\n<!-- boxyard-coordinator: fyi -->" : ""
  await say(withNextSteps(lines.join("\n") + fyi, ["Check the latest yard status", "Start a related task", "Summarize open decisions"]))
  return lines.join("\n")
}

async function worker(mcp, prompt) {
  const cwd = process.cwd()
  if (/\[slow\]/i.test(prompt)) await sleep(3000)
  const slow = prompt.match(/\[slow:(\d+)\]/i)
  if (slow) {
    // Some output first, so a test can tell the turn is under way (a restart mid-turn, say).
    await say("Working on it slowly. (mock Claude)")
    await sleep(Number(slow[1]) * 1000)
  }
  if (/\[hang\]/i.test(prompt)) await waitOrSteer(120_000)
  // FAKE_CLAUDE_GATE=<path>: each turn takes the next number n (a line in <path>.turns) and waits for <path>.<n>:
  // "fail" exits with an error, "kill" dies by SIGKILL (as the out-of-memory killer does), anything else carries on.
  // A test acts on the box while the turn runs. A test that fails before it says gives up the turn after 2 minutes,
  // so no fake agent is left waiting.
  const gate = process.env.FAKE_CLAUDE_GATE
  if (gate) {
    fs.appendFileSync(`${gate}.turns`, `${process.pid}\n`)
    const n = fs.readFileSync(`${gate}.turns`, "utf8").trim().split("\n").length
    const giveUp = Date.now() + 120_000
    while (!fs.existsSync(`${gate}.${n}`)) {
      if (Date.now() > giveUp) {
        console.error(`FAKE_CLAUDE_GATE: nothing said how turn ${n} ends`)
        process.exit(3)
      }
      await sleep(50)
    }
    const verdict = fs.readFileSync(`${gate}.${n}`, "utf8").trim()
    if (verdict === "kill") process.kill(process.pid, "SIGKILL")
    if (verdict === "fail") {
      console.error(`fake failure requested by FAKE_CLAUDE_GATE (turn ${n})`)
      process.exit(3)
    }
  }
  await fold()
  const tree = await subtaskTurn(mcp, prompt)
  if (tree !== null) return tree
  const noop = /\[noop\]/i.test(prompt)
  const markNoop = () => useTool(mcp, "finish", { summary: "Nothing to do this run.", outcome: "noop" })
  if (/\[fail\]/i.test(prompt)) {
    if (noop) await markNoop()
    console.error("fake failure requested by the fail marker")
    process.exit(3)
  }
  await say("Looking at the task. (mock Claude)")
  out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t0", name: "Bash", input: { command: "ls" } }] } })
  await fold()

  const merge = prompt.match(/Merge your pull request #(\d+)/i)
  if (merge && process.env.FAKE_GH_STATE) {
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: `gh pr merge ${merge[1]} --squash --delete-branch` } }] } })
    fs.writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify({ state: "MERGED", mergedBy: "fake-claude", number: Number(merge[1]) }))
    const reply = `Merged PR #${merge[1]} (mock gh pr merge).`
    await say(withNextSteps(reply, ["Check the merged PR", "Clean up the branch"]))
    return reply
  }

  if (/\[ask\]/i.test(prompt) && !session.turns.length) {
    await useTool(mcp, "ask_user", { question: "Which color should the button be: blue or green?" })
    if (noop) await markNoop()
    return "I asked which color to use."
  }
  const agent = prompt.match(/\[agent:([\w-]+)\]/i)
  if (agent) {
    await useTool(mcp, "message_agent", { to: agent[1], message: "Hi from another agent! What are you working on?", expect_reply: false })
  }
  // Explicit message lines exercise the runner's real MCP schemas and worker events.
  const agentRe = /^message agent ([\w-]+)(?: (fyi|ask|fyi ask))?:\s*(.+)$/gim
  let am
  while ((am = agentRe.exec(prompt))) {
    await useTool(mcp, "message_agent", { to: am[1], message: am[3].trim(), fyi: /fyi/.test(am[2] ?? ""), expect_reply: /ask/.test(am[2] ?? "") })
  }
  const captainNotes = []
  const captainRe = /^message captain(?: (fyi))?(?: (wait)(?: (\d+))?)?:\s*(.+)$/gim
  let cm
  while ((cm = captainRe.exec(prompt))) {
    const wait = cm[2] ? Number(cm[3] ?? 30) : 0
    captainNotes.push(await useTool(mcp, "message_captain", { message: cm[4].trim(), ...(cm[1] ? { fyi: true } : {}), ...(wait ? { wait_seconds: wait } : {}) }))
  }
  if (/\[note\]/i.test(prompt))
    await useTool(mcp, "suggest_note", { content: "The mock agent says: tests run with npm test.", why: "A future agent would guess the wrong test command." })
  if (/\[preview\]/i.test(prompt)) {
    const port = Number(process.env.PORT || 4000)
    await sh(
      `nohup node -e "require('http').createServer((q,r)=>r.end('<h1>Box Yard preview</h1>')).listen(${port},'0.0.0.0')" > /dev/null 2>&1 &`,
    )
    await useTool(mcp, "report_preview", { port, label: "Demo page" })
  }
  const file = path.join(cwd, "box-yard-demo.md")
  fs.writeFileSync(file, `# Mock result\n\nPrompt:\n\n${prompt.slice(0, 2000)}\n`)
  if (/\[artifact\]/i.test(prompt)) await useTool(mcp, "publish_artifact", { path: "box-yard-demo.md", title: "Mock report" })
  // An agent that prints its credentials (the transcript keeps "[redacted]" instead, test/identities.e2e.test.ts).
  if (/\[print-env\]/i.test(prompt)) await say(`My env: GITHUB_TOKEN=${process.env.GITHUB_TOKEN ?? ""} ${Object.entries(process.env).filter(([k]) => /^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)$/.test(k)).map(([k, v]) => `${k}=${v}`).join(" ")}`)
  if (noop) await markNoop()
  else if (!/\[(ask|preview|pr)\]/i.test(prompt) && !/^Message from agent/m.test(prompt)) {
    await useTool(mcp, "finish", { summary: "The mock agent wrote box-yard-demo.md." })
  }
  await fold()
  const reply = ["Done for now. I wrote box-yard-demo.md.", ...captainNotes.map((r) => `message_captain: ${r}`)].join("\n\n")
  await say(withNextSteps(reply, ["Review the mock result", "Run a broader check", "Ask for a PR-ready summary"]))
  return reply
}

const ANGLES = ["Classic technique", "Ingredients and ratios", "Pans and heat", "Chef and expert methods", "Common mistakes", "Taste tests", "Variations", "Science of it"]
const NESTED_ANGLES = ["French rolled method", "American folded method", "Japanese tamagoyaki", "Spanish tortilla", "Soufflé omelette", "Frittata"]

/** The sub-tasks a worker prompt asks for: explicit "spawn subtasks:" items, or "use N sub agents". */
function subtaskAsks(prompt) {
  const line = prompt.match(/^spawn subtasks:\s*(.+)$/im)
  if (line) {
    return line[1].split("|").map((item) => {
      const [own, nested] = item.split(">").map((x) => x.trim())
      // "{hang}" in an item is a marker for that sub-task's own prompt ([hang]), so the parent doesn't act on it.
      const marks = [...own.matchAll(/\{([\w:-]+)\}/g)].map((m) => ` [${m[1]}]`).join("")
      const title = own.replace(/\s*\{[\w:-]+\}/g, "").trim()
      const kids = nested ? nested.split(",").map((x) => x.trim()).filter(Boolean) : []
      return { title, prompt: `Research this part: ${title}.${marks}${kids.length ? `\nspawn subtasks: ${kids.join(" | ")}` : ""}${/\[wait\]/i.test(prompt) ? " [wait]" : ""}` }
    })
  }
  const n = Number(prompt.match(/\b(?:use|with|using|spin up|start)\s+(\d+|two|three|four|five|six)\s+sub[- ]?(?:agents?|tasks?)/i)?.[1]?.replace(/^two$/i, "2").replace(/^three$/i, "3").replace(/^four$/i, "4").replace(/^five$/i, "5").replace(/^six$/i, "6"))
  if (!n) return []
  // A sub-task splitting its own part names the methods it compares; a top-level task, the angles of its topic.
  if (/You are a sub-task of/.test(flag("--append-system-prompt") ?? "")) {
    const part = prompt.match(/^# Task: (.+)$/m)?.[1] ?? "this part"
    return Array.from({ length: Math.min(n, NESTED_ANGLES.length) }, (_, i) => ({ title: NESTED_ANGLES[i], prompt: `For "${part}", research the ${NESTED_ANGLES[i]}. Report your findings.` }))
  }
  const topic = (prompt.match(/^# Task: (.+)$/m)?.[1] ?? prompt.split("\n")[0] ?? "the task")
    .replace(/[,.;:]?\s*(?:and\s+)?(?:use|with|using|spin up|start)\s+\S+\s+sub[- ]?(?:agents?|tasks?).*$/i, "")
    .replace(/^research\s+/i, "")
    .trim()
  return Array.from({ length: Math.min(n, ANGLES.length) }, (_, i) => ({
    title: ANGLES[i],
    prompt: `Research one angle of "${topic}": ${ANGLES[i].toLowerCase()}. Report your findings.${i === 0 && n >= 3 ? " Use 2 sub agents for this part." : ""}`,
  }))
}

/** The sub-task reports a prompt carries (server/subtasks.ts reportText). */
const reportsIn = (prompt) => [...prompt.matchAll(/^Sub-task report from "(.+)" \((task_\w+)\), ([^:]+):\n\n([\s\S]*?)(?=\n\n(?:\d+ of your|All \d+ of your|Your sub-task has))/gm)].map((m) => ({ title: m[1], id: m[2], status: m[3], text: m[4] }))

/** A turn about sub-tasks: spawning them, or answering from their reports. Null when the prompt has nothing for it. */
async function subtaskTurn(mcp, prompt) {
  const reports = reportsIn(prompt)
  if (reports.length) {
    const all = /(?:All \d+ of your sub-tasks have reported|Your sub-task has reported)/.test(prompt)
    if (!all) {
      const reply = `Noted the report from ${reports.map((r) => r.title).join(", ")}; waiting for the rest. (mock Claude)`
      await say(reply)
      return reply
    }
    // The last report: answer from every report this session has seen.
    const seen = new Map()
    for (const t of [...session.turns.map((t) => t.prompt), prompt]) for (const r of reportsIn(t ?? "")) seen.set(r.id, r)
    return answerFromReports(mcp, [...seen.values()])
  }
  const asks = session.turns.length ? [] : subtaskAsks(prompt)
  if (asks.length) return startSubtasks(mcp, prompt, asks)
  // A sub-task with no marker of its own to act on reports findings ([slow:N] only makes it take longer).
  const plain = !/\[(?!wait\]|slow\b)[a-z-]+(?::[^\]]*)?\]|^message (?:agent|captain)/im.test(prompt)
  return plain && !session.turns.length && /You are a sub-task of/.test(flag("--append-system-prompt") ?? "") ? subtaskFindings(mcp, prompt) : null
}

async function startSubtasks(mcp, prompt, asks) {
  await say(`Splitting this into ${asks.length} sub-tasks. (mock Claude)`)
  const started = await useTool(mcp, "spawn_subtasks", { tasks: asks })
  if (/^Not started/.test(started)) {
    await say(`Couldn't start sub-tasks: ${started}`)
    return started
  }
  if (/\[cancel\]/i.test(prompt)) return cancelAndFinish(mcp)
  if (/\[wait\]/i.test(prompt)) {
    const waited = await useTool(mcp, "wait_for_subtasks", { timeout_seconds: 120 })
    const got = [...waited.matchAll(/^## (.+) \((task_\w+), ([^)]+)\)\n\S+\n\n([\s\S]*?)(?=\n\n## |$)/gm)].map((m) => ({ title: m[1], id: m[2], status: m[3], text: m[4] }))
    return answerFromReports(mcp, got)
  }
  const reply = `${started}\n\nI'll write the answer once they report.`
  await say(withNextSteps(reply, ["Show me the sub-tasks", "Cancel the sub-tasks"]))
  return reply
}

/** [cancel]: stop every sub-task it started, then finish without their reports. */
async function cancelAndFinish(mcp) {
  // The runner reads its sub-tasks from subtasks.json, which the server writes a moment after they start (and again
  // once they're cancelled): ask until it lists them.
  const retry = async (name, input, ok) => {
    let text = ""
    for (let i = 0; i < 100 && !ok.test(text); i++) {
      if (i) await new Promise((r) => setTimeout(r, 100))
      text = await useTool(mcp, name, input)
    }
    return text
  }
  const cancelled = await retry("cancel_subtasks", {}, /^Cancelling/)
  const summary = "Cancelled the sub-tasks: not needed after all. (mock Claude)"
  await retry("finish", { summary }, /^Ready/)
  await say(`${cancelled}\n\n${summary}`)
  return summary
}

async function answerFromReports(mcp, reports) {
  const lines = reports.map((r) => `- [${r.title}](/tasks/${r.id}) (${r.status}): ${r.text.split("\n")[0]}`)
  const answer = [`Combined answer from ${reports.length} sub-task${reports.length === 1 ? "" : "s"} (mock Claude):`, "", ...lines].join("\n")
  await useTool(mcp, "finish", { summary: answer })
  await say(withNextSteps(answer, ["Dig deeper into one finding", "Turn this into a recipe card"]))
  return answer
}

/** A sub-task with nothing to split: mock findings, as its report. */
async function subtaskFindings(mcp, prompt) {
  const title = prompt.match(/^# Task: (.+)$/m)?.[1] ?? "this part"
  const findings = `Findings on "${title}" (mock): whisk 3 eggs with a pinch of salt 15 minutes ahead, cook in butter over medium-low heat, stir until just set, fold and serve.`
  await useTool(mcp, "finish", { summary: findings })
  await say(findings)
  return findings
}

// ---------------------------------------------------------------- main

/**
 * A subscription's limits, like the real CLI's `rate_limit_event` (from the API's anthropic-ratelimit-unified-*
 * headers): the 5-hour window filling a little more each turn of the session, and the weekly one. An API key has
 * none. FAKE_CLAUDE_LIMITS=off sends none; =full reports the 5-hour window spent, as when the CLI is refused.
 */
function limitsEvent() {
  if (process.env.FAKE_CLAUDE_LIMITS === "off" || (process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN)) return
  const now = Date.now() / 1000
  const full = process.env.FAKE_CLAUDE_LIMITS === "full"
  const turns = session.turns.length
  const five = { utilization: full ? 1 : Math.min(0.95, 0.18 + 0.06 * (turns % 12)), resetsAt: Math.floor(now / 18_000) * 18_000 + 18_000 }
  const week = { utilization: Math.min(0.9, 0.31 + 0.01 * turns), resetsAt: Math.floor(now / 604_800) * 604_800 + 604_800 }
  out({
    type: "rate_limit_event",
    rate_limit_info: { status: full ? "rejected" : five.utilization >= 0.8 ? "allowed_warning" : "allowed", rateLimitType: "five_hour", ...five, unifiedWindows: { five_hour: five, seven_day: week } },
    uuid: randomUUID(),
    session_id: session.id,
  })
}

/** Steers this turn read so far (the result quotes them). */
let steered = []
const lastLine = (text) => text.trim().split("\n").filter((l) => l.trim()).pop()?.trim() ?? ""

/** The steers that came in since the last step, read now, as the real CLI folds them in between tool calls. */
async function fold() {
  for (const text of inbox.steers.splice(0)) {
    steered.push(text)
    await say(`Steered mid-turn: ${lastLine(text)}`)
  }
}

/** Sleep, ending early once a steer comes in. */
async function waitOrSteer(ms) {
  const until = Date.now() + ms
  while (Date.now() < until && !inbox.steers.length) await sleep(Math.min(50, until - Date.now()))
}

async function turn(prompt, started) {
  const login = [process.env.CLAUDE_CODE_OAUTH_TOKEN, process.env.ANTHROPIC_API_KEY].filter(Boolean)
  const loginError = login.some((t) => t.includes("revoked"))
    ? "Invalid API key · Please run /login"
    : login.some((t) => t.includes("limited"))
      ? `Claude AI usage limit reached|${Math.floor(Date.now() / 1000) + 3600}`
      : process.env.FAKE_CLAUDE_LIMIT_FILE && fs.existsSync(process.env.FAKE_CLAUDE_LIMIT_FILE)
      ? fs.readFileSync(process.env.FAKE_CLAUDE_LIMIT_FILE, "utf8").trim()
      : process.env.FAKE_CLAUDE_LOGIN === "required" && !login.length
      ? "Not logged in · Please run /login"
      : null
  if (loginError) {
    out({ type: "system", subtype: "init", session_id: session.id, tools: [], model: "fake" })
    out({ type: "result", subtype: "success", is_error: true, result: loginError, session_id: session.id })
    process.exit(1)
  }
  // Like the real CLI, a session exists from its first turn's start: a turn killed halfway can be resumed. Its turns
  // list gets this one at the end.
  if (sessionFile && (!resumeId || fork)) fs.writeFileSync(sessionFile, JSON.stringify(session))
  let result = ""
  let mcp = null
  steered = []
  if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, prompt: process.env.FAKE_CLAUDE_LOG_FULL ? prompt : prompt.slice(0, 120) }) + "\n")
  // The prompt and the reply grow the context.
  if (!/^\s*\/(compact|context)\b/.test(prompt)) session.tokens += PER_TURN
  try {
    mcp = loadMcp()
    await mcp?.init().catch((err) => {
      out({ type: "system", subtype: "init", session_id: session.id, tools: [], model: "fake", mcp_servers: [{ name: "boxyard", status: "failed" }] })
      throw err
    })
    // Like the real CLI: init comes once the MCP servers are connected (turn timings read start-up off it).
    out({ type: "system", subtype: "init", session_id: session.id, tools: [], model: "fake", mcp_servers: mcp ? [{ name: "boxyard", status: "connected" }] : [] })
    const isOrchestrator = mcp?.kind === "orchestrator"
    if (/\[autocompact\]/i.test(prompt)) {
      out({ type: "system", subtype: "compact_boundary", session_id: session.id, uuid: randomUUID(), compact_metadata: { trigger: "auto", pre_tokens: session.tokens } })
      compactCall()
    }
    if (/^\s*\/compact\b/.test(prompt)) {
      // Like the real CLI: same session, much smaller context, nothing printed as a message.
      if (!session.turns.length) throw new Error("Nothing to compact")
      if (process.env.FAKE_CLAUDE_COMPACT_FAIL) throw new Error("fake /compact failure (FAKE_CLAUDE_COMPACT_FAIL)")
      compactCall()
      result = ""
    } else if (/^\s*\/context\b/.test(prompt)) {
      result = `## Context Usage\n\n**Model:** fake  \n**Tokens:** ${fmt(session.tokens)} / ${fmt(WINDOW)} (${Math.round((session.tokens / WINDOW) * 100)}%)\n`
      process.stdout.write(result)
    } else if (/Your (Captain )?context( for project "[^"]*")? is about to be compacted/.test(prompt)) {
      result = process.env.FAKE_CLAUDE_BAD_SUMMARY
        ? "ok"
        : `## Decisions and preferences\n- The owner prefers short replies.\n\n## Projects and repos\n- demo (acme/demo): a demo project.\n\n## Ongoing work\n${liveTasks(prompt) || "- none"}\n\n## Open threads and next steps\n- none`
      await say(result)
    } else if (/\[connectors\]/i.test(prompt)) {
      result = await connectorsCheck()
      await say(result)
    } else if (!mcp) {
      result = "(mock Claude) No MCP server configured."
      await say(result)
    } else if (isOrchestrator) result = await orchestrator(mcp, prompt)
    else result = await worker(mcp, prompt)
  } catch (err) {
    out({ type: "result", subtype: "error_during_execution", is_error: true, result: String(err.message), session_id: session.id })
    process.exit(1)
  } finally {
    mcp?.close()
  }
  const tail = streamInput && prompt.match(/\[tail:(\d+(?:\.\d+)?)\]/i)
  if (tail) await sleep(Number(tail[1]) * 1000)
  if (steered.length) result = [result, ...steered.map((t) => `Steered mid-turn: ${lastLine(t)}`)].join("\n\n")
  session.turns.push({ prompt, result, at: Date.now(), uuids, model: flag("--model") ?? null, effort: flag("--effort") ?? null, ...(steered.length ? { steers: steered } : {}), ...(session.thread ? { thread: true } : {}) })
  const usage = usageNow()
  spend(usage)
  if (sessionFile) fs.writeFileSync(sessionFile, JSON.stringify(session))
  limitsEvent()
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    result,
    session_id: session.id,
    duration_ms: Date.now() - started,
    duration_api_ms: 0,
    num_turns: 1,
    total_cost_usd: spentUsd(),
    usage,
    modelUsage: { fake: { ...session.spent, webSearchRequests: 0, costUSD: spentUsd(), contextWindow: WINDOW, maxOutputTokens: 32_000 } },
  })
}

if (streamInput) {
  await turn(textOf(inbox.first), Date.now())
  // Like the real CLI: a message that came in too late for the turn runs as a turn of its own, and the CLI exits
  // once stdin ends.
  for (;;) {
    if (inbox.steers.length) await turn(inbox.steers.splice(0).join("\n\n"), Date.now())
    else if (inbox.closed) break
    else await sleep(20)
  }
  if (Number(process.env.FAKE_CLAUDE_EXIT_MS) > 0) await sleep(Number(process.env.FAKE_CLAUDE_EXIT_MS))
  process.exit(0)
}

let prompt = ""
process.stdin.on("data", (d) => (prompt += d))
process.stdin.on("end", async () => {
  await turn(prompt, Date.now())
  if (Number(process.env.FAKE_CLAUDE_EXIT_MS) > 0) await sleep(Number(process.env.FAKE_CLAUDE_EXIT_MS))
  process.exit(0)
})
