// Agent Hub 서버 — 제로 의존성. 정적 PWA + API + SSE + 에이전트 오케스트레이션.
// 실행: node app/server.mjs   (상시: nohup node app/server.mjs > app/server.log 2>&1 &)
import http from "node:http";
import { readFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
if (!existsSync(join(DIR, "config.json"))) {
  console.error("config.json이 없습니다. 먼저:  cp config.example.json config.json  후 프로젝트 경로를 수정하세요.");
  process.exit(1);
}
const cfg = JSON.parse(readFileSync(join(DIR, "config.json"), "utf8"));
const DATA = join(DIR, "data");
mkdirSync(DATA, { recursive: true });
const LOG = join(DATA, "messages.jsonl");
const messages = existsSync(LOG)
  ? readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : [];

const sse = new Set();
const broadcast = (ev) => {
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of sse) res.write(line);
};
const post = (msg) => {
  msg.ts = Date.now();
  messages.push(msg);
  appendFileSync(LOG, JSON.stringify(msg) + "\n");
  broadcast({ type: "msg", ...msg });
  if (msg.from !== "me") notify(`${msg.project || ""} · ${msg.from}`, msg.text);
};
const busy = (room, who, on, project) => broadcast({ type: "busy", room, who, on, project, ts: Date.now() });

// launchd 실행 시 PATH가 최소로 잡히므로 homebrew·node 경로를 명시적으로 보강
const PATH_ENV = [process.env.PATH, dirname(process.execPath), "/opt/homebrew/bin", "/usr/local/bin",
  process.env.HOME + "/.bun/bin", process.env.HOME + "/.local/bin"].join(":");
const run = (bin, args, cwd, timeout = 600_000) =>
  new Promise((done) => {
    const child = execFile(bin, args, { cwd, timeout, maxBuffer: 20 * 1024 * 1024, env: { ...process.env, PATH: PATH_ENV } }, (err, stdout, stderr) => {
      if (err && !stdout) done("⚠️ 실행 오류: " + (stderr || err.message).slice(-1500));
      else done((stdout || "(출력 없음)").trim());
    });
    child.stdin?.end(); // codex exec가 stdin EOF를 기다리며 멈추는 것 방지
  });

// 세션 연속성: (백엔드|에이전트|오피스)마다 세션을 이어써서 기억을 유지하고
// 프롬프트 캐시를 살린다 — 매 지시마다 프로젝트를 재탐색하던 토큰 낭비의 주범 제거.
const SESSFILE = join(DATA, "sessions.json");
const sessMap = existsSync(SESSFILE) ? JSON.parse(readFileSync(SESSFILE, "utf8")) : {};
const sessKey = (backend, name, cwd) => `${backend}|${name}|${cwd}`;
const getSess = (k) => (sessMap[k] && Date.now() - sessMap[k].ts < 48 * 3600_000 ? sessMap[k].id : null);
const setSess = (k, id) => { if (!id) return; sessMap[k] = { id, ts: Date.now() }; writeFileSync(SESSFILE, JSON.stringify(sessMap)); };
const delSess = (k) => { delete sessMap[k]; writeFileSync(SESSFILE, JSON.stringify(sessMap)); };
const clearOfficeSessions = (cwd) => {
  for (const k of Object.keys(sessMap)) if (k.endsWith("|" + cwd)) delete sessMap[k];
  writeFileSync(SESSFILE, JSON.stringify(sessMap));
};

const callBackend = async (backend, name, persona, prompt, cwd, args = []) => {
  const k = sessKey(backend, name, cwd);
  const sid = getSess(k);
  if (backend === "grok") {
    const full = sid ? prompt : `[너의 역할] ${persona}\n\n${prompt}`;
    let out = await run("grok", ["-p", full, "--output-format", "plain", "--no-auto-update", ...(sid ? ["--continue"] : []), ...args], cwd);
    if (out.startsWith("⚠️") && sid) { delSess(k); out = await run("grok", ["-p", `[너의 역할] ${persona}\n\n${prompt}`, "--output-format", "plain", "--no-auto-update", ...args], cwd); }
    if (!out.startsWith("⚠️")) setSess(k, "cwd"); // grok은 --continue(cwd 기준)라 마커만 저장
    return out;
  }
  if (backend === "codex") {
    const outFile = join(DATA, `.codex-last-${Date.now()}`);
    const read = () => { try { const t = readFileSync(outFile, "utf8").trim(); unlinkSync(outFile); return t || "(출력 없음)"; } catch { return "⚠️ codex 출력 없음"; } };
    if (sid) {
      await run("codex", ["exec", "resume", sid, "--skip-git-repo-check", ...args, "--output-last-message", outFile, prompt], cwd);
      const t = read();
      if (!t.startsWith("⚠️")) { setSess(k, sid); return t; }
      delSess(k); // 세션 소실 → 새로 시작
    }
    const raw = await run("codex", ["exec", "--json", "--skip-git-repo-check", ...args, "--output-last-message", outFile, `[너의 역할] ${persona}\n\n${prompt}`], cwd);
    const m = raw.match(/"thread_id":"([a-f0-9-]+)"/);
    if (m) setSess(k, m[1]);
    return read();
  }
  // claude: --output-format json으로 session_id 획득, 이후 --resume
  const base = ["-p", prompt, "--append-system-prompt", persona, "--output-format", "json", ...args];
  let raw = await run("claude", sid ? [...base, "--resume", sid] : base, cwd);
  let j = null; try { j = JSON.parse(raw); } catch {}
  if (!j && sid) { delSess(k); raw = await run("claude", base, cwd); try { j = JSON.parse(raw); } catch {} }
  if (j) {
    setSess(k, j.session_id);
    const text = (j.result ?? "").trim();
    return j.is_error ? "⚠️ " + (text || "claude 오류") : text || "(출력 없음)";
  }
  return raw;
};
// 한도 초과·오류 시 다른 모델로 자동 폴백 ("session limit" 류 문구 포함)
const failedOut = (t) => !t || t.startsWith("⚠️") ||
  (t.length < 600 && /you've hit|session limit|usage limit|rate limit|overloaded|quota|too many requests/i.test(t));
const runAgent = async (name, prompt, cwd) => {
  const a = cfg.agents[name];
  // 토큰 절약: Claude 5시간 한도 90% 이상이면 선제적으로 codex로 우회
  let pre = "";
  if (a.backend === "claude") {
    try {
      const pct = (await limits())?.claude?.five_hour?.pct || 0;
      if (pct >= 90) {
        const alt = await callBackend("codex", name, a.prompt, prompt, cwd);
        if (!failedOut(alt)) return `⏱ Claude 5시간 한도 ${Math.round(pct)}% — codex로 수행\n\n${alt}`;
        pre = `⏱ Claude 한도 ${Math.round(pct)}% (우회 실패, claude로 강행)\n\n`;
      }
    } catch {}
  }
  let out = await callBackend(a.backend, name, a.prompt, prompt, cwd, a.args || []);
  if (!failedOut(out) && pre) return pre + out;
  if (!failedOut(out)) return out;
  for (const b of ["claude", "codex", "grok"].filter((x) => x !== a.backend)) {
    const alt = await callBackend(b, name, a.prompt, prompt, cwd);
    if (!failedOut(alt)) return `↪️ ${a.backend} 응답 불가 → ${b}로 대체 수행\n\n${alt}`;
  }
  return out;
};

async function orchestrate({ room, text, project, verify }) {
  const cwd = cfg.projects[project]?.path || DIR;
  const ctx = `현재 프로젝트(오피스): ${project || "agent_manager"} (${cwd})\n사용자 지시: ${text}`;
  try {
    if (!verify) {
      busy(room, room, true, project);
      const out = await runAgent(room, ctx, cwd);
      busy(room, room, false, project);
      post({ room, from: room, text: out, project });
    } else {
      busy(room, "무진", true, project);
      const work = await runAgent("무진", ctx + "\n\n작업을 수행하고 결과를 보고하라. 보고 첫 줄은 반드시 `📊 진행률 N/M 단계 · 남은 것: … · 예상: …` 한 줄로 시작하라.", cwd);
      busy(room, "무진", false, project);
      post({ room, from: "무진", text: work, project });
      if (failedOut(work)) { // 실무가 실패했으면 검증·요약 체인을 돌리지 않는다 (토큰 절약)
        post({ room, from: "system", text: "실무 단계 실패 — 검증 체인 중단. 잠시 후 다시 시도하세요.", project });
        return;
      }
      busy(room, "하연", true, project);
      const audit = await runAgent("하연", `사용자 지시:\n${text}\n\n무진의 결과 보고:\n${work}\n\n결과를 실물로 검증하고 문제를 지적하거나 통과를 선언하라.`, cwd);
      busy(room, "하연", false, project);
      post({ room, from: "하연", text: audit, project });
      busy(room, "아라", true, project);
      const sum = await runAgent("아라", `지시:${text}\n\n무진 보고:\n${work}\n\n하연 검증:\n${audit}\n\n사용자에게 최종 상황을 3줄 이내로 보고하라. 첫 줄에 전체 진행률(% 또는 N/M)과 남은 단계·예상 완료 시점을 반드시 명시하라.`, cwd);
      busy(room, "아라", false, project);
      post({ room, from: "아라", text: sum, project });
    }
    run("gbrain", ["capture", `[agent-hub][${project}] ${text.slice(0, 120)} — 처리 완료`], DIR, 30_000); // best-effort
  } catch (e) {
    post({ room, from: "system", text: "오류: " + e.message, project });
  }
}

// 등록된 프로젝트 폴더 밖 접근 차단
const safePath = (project, p) => {
  const root = cfg.projects[project]?.path;
  if (!root) return null;
  const full = resolve(root, p || ".");
  return full === root || full.startsWith(root + "/") ? full : null;
};
const listFiles = (root, dir, out, depth) => {
  if (depth > 3 || out.length > 300) return;
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) listFiles(root, full, out, depth + 1);
    else out.push({ path: relative(root, full), size: st.size, md: name.endsWith(".md") });
  }
};

// 웹 푸시 (web-push, HTTPS 필요 — tailscale serve 경유)
let webpush = null;
const SUBS = join(DATA, "subs.json");
const VAPID = join(DATA, "vapid.json");
try {
  webpush = (await import("web-push")).default;
  if (!existsSync(VAPID)) writeFileSync(VAPID, JSON.stringify(webpush.generateVAPIDKeys()));
  const k = JSON.parse(readFileSync(VAPID, "utf8"));
  webpush.setVapidDetails("mailto:kaist.mesc@gmail.com", k.publicKey, k.privateKey);
} catch (e) { console.error("web-push 비활성:", e.message); }
const subs = () => (existsSync(SUBS) ? JSON.parse(readFileSync(SUBS, "utf8")) : []);
async function notify(title, body) {
  if (!webpush) return;
  const list = subs();
  const alive = [];
  for (const s of list) {
    try { await webpush.sendNotification(s, JSON.stringify({ title, body: body.slice(0, 140) })); alive.push(s); }
    catch (e) { if (e.statusCode !== 404 && e.statusCode !== 410) alive.push(s); }
  }
  if (alive.length !== list.length) writeFileSync(SUBS, JSON.stringify(alive));
}

// Claude Code 세션 기록 (~/.claude/projects/<슬러그>/*.jsonl)
const claudeDir = (project) => {
  const p = cfg.projects[project]?.path;
  return p ? process.env.HOME + "/.claude/projects/" + p.replace(/[/._]/g, "-") : null;
};
const sessMsgs = (file, limit) => {
  const out = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.isMeta || j.isSidechain || (j.type !== "user" && j.type !== "assistant")) continue;
    const c = j.message?.content;
    const text = typeof c === "string" ? c : (c || []).filter((x) => x.type === "text").map((x) => x.text).join("\n");
    const clean = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
      .replace(/<(command-name|command-message|command-args|local-command-stdout|local-command-caveat)>[\s\S]*?<\/\1>/g, "").trim();
    if (clean) out.push({ role: j.type, text: clean, ts: j.timestamp });
    if (limit && out.length >= limit) break;
  }
  return out;
};

// 3사 플랜 한도 사용률 (5분 캐시. 토큰은 절대 응답에 넣지 않음)
let limitsCache = { at: 0, data: null };
async function limits() {
  if (Date.now() - limitsCache.at < 300_000) return limitsCache.data;
  const HOME = process.env.HOME;
  let claude = null, codex = null, grok = null;
  try { // Claude: 키체인 OAuth 토큰 → 공식 usage 엔드포인트
    const raw = await run("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], DIR, 15_000);
    const tok = JSON.parse(raw).claudeAiOauth.accessToken;
    const r = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: { authorization: "Bearer " + tok, "anthropic-beta": "oauth-2025-04-20" },
    }).then((x) => x.json());
    const pick = (o) => (o ? { pct: o.utilization, resets_at: o.resets_at } : null);
    claude = { five_hour: pick(r.five_hour), seven_day: pick(r.seven_day) };
  } catch {}
  try { // Codex: 최신 세션 로그의 마지막 rate_limits 스냅샷
    const base = HOME + "/.codex/sessions";
    const files = readdirSync(base, { recursive: true }).filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ f: join(base, f), m: statSync(join(base, f)).mtimeMs })).sort((a, b) => b.m - a.m);
    for (const { f, m } of files.slice(0, 3)) {
      const lines = readFileSync(f, "utf8").split("\n").filter((l) => l.includes('"rate_limits"'));
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const j = JSON.parse(lines[i]);
          const rl = j.payload?.rate_limits || j.rate_limits || j.payload?.info?.rate_limits;
          if (rl?.primary) {
            codex = { pct: rl.primary.used_percent, window_hours: Math.round(rl.primary.window_minutes / 60),
              resets_at: rl.primary.resets_at ? new Date(rl.primary.resets_at * 1000).toISOString() : null,
              plan: rl.plan_type, asof: m };
            break;
          }
        } catch {}
      }
      if (codex) break;
    }
  } catch {}
  try { // Grok: unified 로그의 마지막 creditUsagePercent
    const f = HOME + "/.grok/logs/unified.jsonl";
    const ms = [...readFileSync(f, "utf8").matchAll(/"creditUsagePercent":([\d.]+)/g)];
    if (ms.length) grok = { pct: +ms.at(-1)[1], asof: statSync(f).mtimeMs };
  } catch {}
  limitsCache = { at: Date.now(), data: { claude, codex, grok } };
  return limitsCache.data;
}

// 사용량 (10분 캐시)
let usageCache = { at: 0, data: {} };
async function usage() {
  if (Date.now() - usageCache.at < 600_000) return usageCache.data;
  const today = new Date().toLocaleDateString("sv"); // YYYY-MM-DD
  const parse = (s) => {
    try {
      const list = JSON.parse(s).daily || [];
      const day = (e) => e.date || e.period;
      const e = list.find((d) => day(d) === today) || list.at(-1);
      if (!e) return null;
      return {
        date: day(e),
        totalTokens: e.totalTokens ?? (e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheCreationTokens),
        totalCost: e.totalCost ?? e.costUSD ?? 0,
      };
    } catch { return null; }
  };
  const [cl, cx] = await Promise.all([
    run("npx", ["-y", "ccusage@latest", "daily", "--json"], DIR, 120_000).then(parse),
    existsSync(process.env.HOME + "/.codex/sessions")
      ? run("npx", ["-y", "ccusage@latest", "codex", "daily", "--json"], DIR, 120_000).then(parse)
      : null,
  ]);
  usageCache = { at: Date.now(), data: { claude: cl, codex: cx } };
  return usageCache.data;
}

const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };

http.createServer(async (req, res) => {
  try {
    await handle(req, res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: e.message });
  }
}).listen(cfg.port, () => console.log("agent-hub on http://localhost:" + cfg.port));

async function handle(req, res) {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(readFileSync(join(DIR, "index.html")));
  }
  if (u.pathname === "/api/config")
    return json(res, 200, {
      agents: Object.fromEntries(Object.entries(cfg.agents).map(([k, v]) => [k, { role: v.role, avatar: v.avatar, backend: v.backend }])),
      projects: Object.fromEntries(Object.entries(cfg.projects).map(([k, v]) => [k, { icon: v.icon || "📁", desc: v.desc || "" }])),
    });
  if (u.pathname === "/api/messages") {
    const room = u.searchParams.get("room");
    const project = u.searchParams.get("project");
    return json(res, 200, messages.filter((m) => m.room === room && (m.project || "agent_manager") === project).slice(-100));
  }
  if (u.pathname === "/api/stream") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write("\n");
    sse.add(res);
    const hb = setInterval(() => res.write(": hb\n\n"), 25_000);
    req.on("close", () => { sse.delete(res); clearInterval(hb); });
    return;
  }
  if (u.pathname === "/api/send" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { room, text, project, verify } = JSON.parse(body);
        if (!cfg.agents[room] || !text) return json(res, 400, { error: "bad request" });
        post({ room, from: "me", text, project });
        if (text.trim() === "/새세션") { // 이 오피스의 이어쓰기 세션을 리셋 (컨텍스트가 꼬였을 때)
          clearOfficeSessions(cfg.projects[project]?.path || DIR);
          post({ room, from: "system", text: "🔄 이 오피스의 에이전트 세션을 초기화했습니다. 다음 지시부터 새 기억으로 시작합니다.", project });
          return json(res, 200, { ok: true });
        }
        orchestrate({ room, text, project, verify });
        json(res, 200, { ok: true });
      } catch (e) { json(res, 400, { error: e.message }); }
    });
    return;
  }
  if (u.pathname === "/api/files") {
    const root = cfg.projects[u.searchParams.get("project")]?.path;
    if (!root) return json(res, 404, { error: "unknown project" });
    const out = [];
    listFiles(root, root, out, 0);
    return json(res, 200, out.sort((a, b) => (b.md - a.md) || a.path.localeCompare(b.path)));
  }
  if (u.pathname === "/api/file") {
    const full = safePath(u.searchParams.get("project"), u.searchParams.get("path"));
    if (!full || !existsSync(full)) return json(res, 404, { error: "not found" });
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    return res.end(readFileSync(full));
  }
  if (u.pathname === "/api/sessions") {
    const dir = claudeDir(u.searchParams.get("project"));
    if (!dir || !existsSync(dir)) return json(res, 200, []);
    const list = readdirSync(dir).filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ id: f.slice(0, -6), mtime: statSync(join(dir, f)).mtimeMs, size: statSync(join(dir, f)).size }))
      .sort((a, b) => b.mtime - a.mtime).slice(0, 20);
    for (const s of list) {
      try { s.title = (sessMsgs(join(dir, s.id + ".jsonl"), 1)[0]?.text || "(빈 세션)").slice(0, 60); } catch { s.title = "(읽기 실패)"; }
    }
    return json(res, 200, list);
  }
  if (u.pathname === "/api/session") {
    const dir = claudeDir(u.searchParams.get("project"));
    const id = (u.searchParams.get("id") || "").replace(/[^a-f0-9-]/g, "");
    if (!dir || !existsSync(join(dir, id + ".jsonl"))) return json(res, 404, { error: "not found" });
    return json(res, 200, sessMsgs(join(dir, id + ".jsonl")).slice(-200));
  }
  if (u.pathname === "/api/status") {
    const now = Date.now();
    return json(res, 200, Object.fromEntries(Object.keys(cfg.projects).map((p) => {
      const dir = claudeDir(p);
      let last = 0;
      if (dir && existsSync(dir)) for (const f of readdirSync(dir)) if (f.endsWith(".jsonl")) last = Math.max(last, statSync(join(dir, f)).mtimeMs);
      return [p, !last ? "none" : now - last < 300_000 ? "working" : now - last < 86_400_000 ? "today" : "idle"];
    })));
  }
  if (u.pathname === "/api/resume" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { project, id, text } = JSON.parse(body);
        const cwd = cfg.projects[project]?.path;
        const sid = (id || "").replace(/[^a-f0-9-]/g, "");
        if (!cwd || !sid || !text) return json(res, 400, { error: "bad request" });
        const out = await run("claude", ["-p", text, "--resume", sid], cwd);
        json(res, 200, { text: out });
      } catch (e) { json(res, 400, { error: e.message }); }
    });
    return;
  }
  if (u.pathname === "/marked.js") {
    res.writeHead(200, { "content-type": "application/javascript" });
    return res.end(readFileSync(join(DIR, "node_modules/marked/lib/marked.esm.js")));
  }
  if (u.pathname === "/sw.js") {
    res.writeHead(200, { "content-type": "application/javascript" });
    return res.end(readFileSync(join(DIR, "sw.js")));
  }
  if (u.pathname === "/api/vapid") {
    if (!webpush) return json(res, 503, { error: "push 비활성" });
    return json(res, 200, { key: JSON.parse(readFileSync(VAPID, "utf8")).publicKey });
  }
  if (u.pathname === "/api/subscribe" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const sub = JSON.parse(body);
        if (!sub.endpoint) return json(res, 400, { error: "bad sub" });
        const list = subs().filter((s) => s.endpoint !== sub.endpoint);
        list.push(sub);
        writeFileSync(SUBS, JSON.stringify(list));
        json(res, 200, { ok: true, total: list.length });
      } catch (e) { json(res, 400, { error: e.message }); }
    });
    return;
  }
  if (u.pathname === "/api/brief" && req.method === "POST") {
    json(res, 202, { ok: true });
    const status = Object.entries(cfg.projects).map(([p]) => {
      const dir = claudeDir(p);
      let last = 0, title = "";
      if (dir && existsSync(dir)) {
        const fs = readdirSync(dir).filter((f) => f.endsWith(".jsonl"))
          .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.m - a.m);
        if (fs[0]) { last = fs[0].m; try { title = sessMsgs(join(dir, fs[0].f), 1)[0]?.text.slice(0, 80) || ""; } catch {} }
      }
      return `- ${p}: 최근 활동 ${last ? new Date(last).toLocaleString("ko") : "없음"}${title ? ` / 마지막 주제: ${title}` : ""}`;
    }).join("\n");
    const out = await runAgent("아라", `아침 브리핑 시간이다. 아래는 각 오피스(프로젝트)의 최근 활동 현황이다.\n${status}\n\nPROJECTS.md를 참고해 아래 형식을 정확히 지켜라. 인사말·의례 문구·자기소개 금지, 군더더기 없는 압축 존댓말.\n1행: "⭐ 오늘 1순위: <가장 중요한 액션 하나>"\n빈 줄 후, 변화가 있는 오피스만 "· <오피스> — <현황과 오늘 할 일, 한 줄>". 변화 없는 오피스들은 마지막에 "· 나머지 N곳 변화 없음" 한 줄로 묶어라.\n사용자가 정해야 할 것이 있으면 맨 끝에 "🔔 결정 대기: <항목>" 한 줄 (없으면 생략).\n전체 8줄 이내.`, DIR);
    if (failedOut(out)) post({ room: "아라", from: "system", text: "🌅 아침 브리핑 실패 (전 백엔드 한도/오류). 나중에 아라 방에서 '브리핑'이라고 지시하면 재시도합니다.", project: "agent_manager" });
    else post({ room: "아라", from: "아라", text: "🌅 아침 브리핑\n\n" + out, project: "agent_manager" });
    return;
  }
  if (u.pathname === "/api/todo") {
    const root = cfg.projects[u.searchParams.get("project")]?.path;
    const f = root && join(root, "TODO.md");
    if (!f || !existsSync(f)) return json(res, 200, { open: 0, items: [] });
    const lines = readFileSync(f, "utf8").split("\n");
    const items = lines.filter((l) => /^\s*[-*] \[ \]/.test(l)).map((l) => l.replace(/^\s*[-*] \[ \]\s*/, ""));
    return json(res, 200, { open: items.length, done: lines.filter((l) => /^\s*[-*] \[x\]/i.test(l)).length, items: items.slice(0, 3) });
  }
  if (u.pathname === "/api/skills") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    try { return res.end(readFileSync(process.env.HOME + "/.claude/skills/SKILLS_GUIDE.md")); }
    catch { return res.end("SKILLS_GUIDE.md 없음"); }
  }
  if (u.pathname === "/api/usage") return json(res, 200, await usage());
  if (u.pathname === "/api/limits") {
    try { return json(res, 200, await limits()); } catch (e) { return json(res, 200, { error: e.message.slice(0, 100) }); }
  }
  json(res, 404, { error: "not found" });
}
