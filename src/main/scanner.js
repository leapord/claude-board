// src/main/scanner.js — Claude Code 日志扫描器
// 职责：读取 ~/.claude/projects/*.jsonl，解析会话，聚合统计
//
// 数据形态（Claude Code JSONL 一行一条）：
//   { type: 'user'|'assistant'|'system', message: { role, content, usage?, model? },
//     timestamp: ISO string, sessionId: string, cwd: string, model?: string }
//
// 输出（统一聚合）:
//   { stats, trendDays, trendData, pieData, recentProjects, recentActivities,
//     projects: { current, sessions }, models: { cards, prices },
//     tokens: { stats, savings, sankey }, heatmap, levels }
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// ----- 路径展开 & 文件发现 -----
function expandHome(p) {
  if (!p) return p;
  return p.startsWith('~/') || p === '~'
    ? path.join(os.homedir(), p.slice(p === '~' ? 1 : 2))
    : p;
}

async function findJsonlFiles(root) {
  const out = [];
  if (!root) return out;
  let stat;
  try { stat = await fs.promises.stat(root); } catch { return out; }
  if (!stat.isDirectory()) return out;
  async function walk(dir) {
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) {
        // 限深 3 层，避免扫到 node_modules 等
        if (fp.split(path.sep).length - root.split(path.sep).length < 3) await walk(fp);
      } else if (e.isFile() && e.name.endsWith('.jsonl')) {
        out.push(fp);
      }
    }
  }
  await walk(root);
  return out;
}

// ----- 价格表（v0.1 硬编码，v0.2 走 settings）-----
// 价格表（默认 + 用户持久化扩展）
// - 内置默认 PRICE_TABLE：常见 Claude/国产模型（让用户有表格可看）
// - 运行时 modelPrices：从 main 端 userData/model-prices.json 加载（自动覆盖默认）
// - 未知模型 fallback DEFAULT_PRICE
// 用户可随时切换厂商：新模型被 scanner 扫到后自动追加到 model-prices.json
const DEFAULT_PRICE = { in: 1.0, out: 3.0, cw: 1.25, cr: 0.1 };
const PRICE_TABLE = {
  // ====== Claude 全系 ======
  'claude-opus-4-20250514':   { in: 15.0,  out: 75.0,  cw: 18.75, cr: 1.5  },
  'claude-opus-4':            { in: 15.0,  out: 75.0,  cw: 18.75, cr: 1.5  },
  'claude-opus-4-latest':     { in: 15.0,  out: 75.0,  cw: 18.75, cr: 1.5  },
  'claude-sonnet-4-20250514': { in: 3.0,   out: 15.0,  cw: 3.75,  cr: 0.3  },
  'claude-sonnet-4':          { in: 3.0,   out: 15.0,  cw: 3.75,  cr: 0.3  },
  'claude-sonnet-4-latest':   { in: 3.0,   out: 15.0,  cw: 3.75,  cr: 0.3  },
  'claude-haiku-4-20250514':  { in: 0.8,   out: 4.0,   cw: 1.0,   cr: 0.08 },
  'claude-haiku-4':           { in: 0.8,   out: 4.0,   cw: 1.0,   cr: 0.08 },
  'claude-haiku-4-latest':    { in: 0.8,   out: 4.0,   cw: 1.0,   cr: 0.08 },
  'claude-3-7-sonnet':        { in: 3.0,   out: 15.0,  cw: 3.75,  cr: 0.3  },
  'claude-3-5-sonnet':        { in: 3.0,   out: 15.0,  cw: 3.75,  cr: 0.3  },
  'claude-3-5-haiku':         { in: 0.8,   out: 4.0,   cw: 1.0,   cr: 0.08 },
  'claude-3-opus':            { in: 15.0,  out: 75.0,  cw: 18.75, cr: 1.5  },
  'claude-3-sonnet':          { in: 3.0,   out: 15.0,  cw: 3.75,  cr: 0.3  },
  'claude-3-haiku':           { in: 0.25,  out: 1.25,  cw: 0.3,   cr: 0.03 },
  // ====== 智谱 GLM ======
  'glm-4':       { in: 0.5,  out: 0.5,  cw: 0.5,  cr: 0.05 },
  'glm-4-6':     { in: 0.6,  out: 2.2,  cw: 0.6,  cr: 0.06 },
  'glm-4-7':     { in: 0.6,  out: 2.2,  cw: 0.6,  cr: 0.06 },
  'glm-4.5':     { in: 0.6,  out: 2.2,  cw: 0.6,  cr: 0.06 },
  'glm-4.5-air': { in: 0.2,  out: 1.1,  cw: 0.0,  cr: 0.02 },
  'glm-5':       { in: 0.8,  out: 2.0,  cw: 0.8,  cr: 0.08 },
  'glm-5-1':     { in: 0.8,  out: 2.0,  cw: 0.8,  cr: 0.08 },
  'glm-z1':      { in: 0.5,  out: 0.5,  cw: 0.5,  cr: 0.05 },
  'glm-zero':    { in: 0.1,  out: 0.1,  cw: 0.1,  cr: 0.01 },
  // ====== MiniMax ======
  'MiniMax':     { in: 0.5,  out: 1.5,  cw: 0.5,  cr: 0.05 },
  'MiniMax-01':  { in: 0.5,  out: 1.5,  cw: 0.5,  cr: 0.05 },
  'MiniMax-2':   { in: 0.5,  out: 1.5,  cw: 0.5,  cr: 0.05 },
  'MiniMax-2.5': { in: 0.5,  out: 1.5,  cw: 0.5,  cr: 0.05 },
  'MiniMax-2.7': { in: 0.5,  out: 1.5,  cw: 0.5,  cr: 0.05 },
  'MiniMax-3':   { in: 0.5,  out: 1.5,  cw: 0.5,  cr: 0.05 },
  'MiniMax-M2':  { in: 0.5,  out: 1.5,  cw: 0.5,  cr: 0.05 },
  'MiniMax-M2.7':{ in: 0.5,  out: 1.5,  cw: 0.5,  cr: 0.05 },
  'MiniMax-M3':  { in: 0.5,  out: 1.5,  cw: 0.5,  cr: 0.05 },
  'MiniMax-M4':  { in: 0.5,  out: 1.5,  cw: 0.5,  cr: 0.05 },
  // ====== DeepSeek ======
  'deepseek-chat':      { in: 0.27, out: 1.10, cw: 0.27, cr: 0.07 },
  'deepseek-coder':     { in: 0.27, out: 1.10, cw: 0.27, cr: 0.07 },
  'deepseek-reasoner':  { in: 0.55, out: 2.19, cw: 0.55, cr: 0.14 },
  'deepseek-v2':        { in: 0.27, out: 1.10, cw: 0.27, cr: 0.07 },
  'deepseek-v3':        { in: 0.27, out: 1.10, cw: 0.27, cr: 0.07 },
  'deepseek-v3.1':      { in: 0.27, out: 1.10, cw: 0.27, cr: 0.07 },
  'deepseek-v3.2':      { in: 0.27, out: 1.10, cw: 0.27, cr: 0.07 },
  // ====== 通义千问 Qwen ======
  'qwen-turbo':         { in: 0.3,  out: 0.6,  cw: 0.3,  cr: 0.05 },
  'qwen-plus':          { in: 0.8,  out: 2.0,  cw: 0.8,  cr: 0.08 },
  'qwen-max':           { in: 2.4,  out: 9.6,  cw: 2.4,  cr: 0.24 },
  'qwen-long':          { in: 0.5,  out: 2.0,  cw: 0.5,  cr: 0.05 },
  'qwen2.5-7b':         { in: 0.5,  out: 1.0,  cw: 0.5,  cr: 0.05 },
  'qwen2.5-72b':        { in: 2.0,  out: 6.0,  cw: 2.0,  cr: 0.20 },
  'qwen2.5-coder-32b':  { in: 1.5,  out: 4.5,  cw: 1.5,  cr: 0.15 },
  'qwen3-235b':         { in: 2.0,  out: 6.0,  cw: 2.0,  cr: 0.20 },
  'qwen3-32b':          { in: 1.0,  out: 3.0,  cw: 1.0,  cr: 0.10 },
  'qwen3-8b':           { in: 0.5,  out: 1.5,  cw: 0.5,  cr: 0.05 },
  // ====== 月之暗面 Kimi / Moonshot ======
  'moonshot-v1-8k':     { in: 1.0,  out: 1.0,  cw: 1.0,  cr: 0.10 },
  'moonshot-v1-32k':    { in: 2.0,  out: 2.0,  cw: 2.0,  cr: 0.20 },
  'moonshot-v1-128k':   { in: 6.0,  out: 6.0,  cw: 6.0,  cr: 0.60 },
  'kimi-k2':            { in: 0.6,  out: 2.5,  cw: 0.6,  cr: 0.06 },
  // ====== 字节豆包 Doubao ======
  'doubao-lite':        { in: 0.3,  out: 0.6,  cw: 0.3,  cr: 0.03 },
  'doubao-pro':         { in: 0.8,  out: 2.0,  cw: 0.8,  cr: 0.08 },
  'doubao-pro-32k':     { in: 0.8,  out: 2.0,  cw: 0.8,  cr: 0.08 },
  'doubao-pro-128k':    { in: 1.2,  out: 3.0,  cw: 1.2,  cr: 0.12 },
  // ====== 百川 ======
  'baichuan2-turbo':    { in: 0.3,  out: 0.6,  cw: 0.3,  cr: 0.03 },
  'baichuan2-turbo-192k':{in: 0.6,  out: 1.2,  cw: 0.6,  cr: 0.06 },
  // ====== MiniMax M2/M3 国产其他 ======
  'qwen2.5':            { in: 0.5,  out: 1.0,  cw: 0.5,  cr: 0.05 },
  'yi-large':           { in: 0.8,  out: 0.8,  cw: 0.8,  cr: 0.08 },
  'yi-medium':          { in: 0.5,  out: 0.5,  cw: 0.5,  cr: 0.05 },
  'spark-v3.5':         { in: 0.3,  out: 0.3,  cw: 0.3,  cr: 0.03 },
  'ernie-4.0':          { in: 0.8,  out: 0.8,  cw: 0.8,  cr: 0.08 },
  'ernie-3.5':          { in: 0.4,  out: 0.4,  cw: 0.4,  cr: 0.04 },
  // 兜底
  'unknown':            { in: 0.0,  out: 0.0,  cw: 0.0,  cr: 0.0 },
};
function calcCost(model, usage, modelPrices) {
  // 优先级：用户持久化的 modelPrices > 内置 PRICE_TABLE > DEFAULT_PRICE
  const p = (modelPrices && modelPrices[model]) || PRICE_TABLE[model] || DEFAULT_PRICE;
  const u = usage || {};
  return ((u.input_tokens || 0) / 1e6) * p.in
       + ((u.output_tokens || 0) / 1e6) * p.out
       + ((u.cache_creation_input_tokens || 0) / 1e6) * p.cw
       + ((u.cache_read_input_tokens || 0) / 1e6) * p.cr;
}

// ----- 解析 JSONL 文件 -----
async function parseJsonl(file) {
  const sessions = new Map(); // sessionId -> { records, cwd, first, last, model }
  try {
    const content = await fs.promises.readFile(file, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    for (const line of lines) {
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (!rec.sessionId) continue;
      let s = sessions.get(rec.sessionId);
      if (!s) {
        s = { id: rec.sessionId, records: [], cwd: rec.cwd || path.dirname(file), first: rec.timestamp, last: rec.timestamp, model: rec.model || null, inTok: 0, outTok: 0, cw: 0, cr: 0, turns: 0 };
        sessions.set(rec.sessionId, s);
      }
      s.records.push(rec);
      if (rec.timestamp) {
        if (!s.first || rec.timestamp < s.first) s.first = rec.timestamp;
        if (!s.last  || rec.timestamp > s.last)  s.last  = rec.timestamp;
      }
      if (rec.cwd && !s.cwd) s.cwd = rec.cwd;
      // model 字段可能在 rec.model（旧版）或 rec.message.model（新版 Claude Code）
      const modelVal = rec.model || rec.message?.model;
      if (modelVal && !s.model) s.model = modelVal;
      const usage = rec.message?.usage || rec.usage || {};
      s.inTok += usage.input_tokens || 0;
      s.outTok += usage.output_tokens || 0;
      s.cw    += usage.cache_creation_input_tokens || 0;
      s.cr    += usage.cache_read_input_tokens || 0;
      if (rec.type === 'user' || rec.type === 'human') s.turns += 1;
    }
  } catch (e) {
    // 文件读失败忽略
  }
  return [...sessions.values()];
}

// ----- 项目名推断（cwd 最后一段）-----
function projectName(cwd) {
  if (!cwd) return 'unknown';
  return path.basename(cwd) || cwd;
}

// ----- 聚合 -----
function aggregate(allSessions, modelPrices = {}) {
  if (!allSessions.length) return null;
  // 按项目分组
  const byProject = new Map();
  for (const s of allSessions) {
    const name = projectName(s.cwd);
    let p = byProject.get(name);
    if (!p) { p = { name, cwd: s.cwd, sessions: 0, inTok: 0, outTok: 0, cw: 0, cr: 0, first: s.first, last: s.last, models: new Set(), stars: 0, sessionList: [] }; byProject.set(name, p); }
    p.sessions += 1;
    p.inTok += s.inTok; p.outTok += s.outTok; p.cw += s.cw; p.cr += s.cr;
    if (s.model) p.models.add(s.model);
    if (s.first && (!p.first || s.first < p.first)) p.first = s.first;
    if (s.last  && (!p.last  || s.last  > p.last))  p.last  = s.last;
    p.sessionList.push(s);
  }
  // 排序：按最后活跃时间
  const projects = [...byProject.values()]
    .map(p => ({
      name: p.name, path: p.cwd,
      sessions: p.sessions, inTok: p.inTok, outTok: p.outTok, cw: p.cw, cr: p.cr,
      first: p.first, last: p.last, models: [...p.models],
      cost: calcCost('', { input_tokens: p.inTok, output_tokens: p.outTok, cache_creation_input_tokens: p.cw, cache_read_input_tokens: p.cr }, modelPrices),
    }))
    .sort((a, b) => (b.last || '').localeCompare(a.last || ''));
  // 按模型分组
  const byModel = new Map();
  for (const s of allSessions) {
    const m = s.model;
    if (!m) continue;  // 跳过 model 字段为空的 session
    // 过滤合成/测试数据
    if (m.includes('synthetic') || m === 'unknown' || m === '<synthetic>') continue;
    let e = byModel.get(m);
    if (!e) { e = { name: m, count: 0, inTok: 0, outTok: 0, cw: 0, cr: 0, cost: 0 }; byModel.set(m, e); }
    e.count += 1;
    e.inTok += s.inTok; e.outTok += s.outTok; e.cw += s.cw; e.cr += s.cr;
    e.cost += calcCost(m, { input_tokens: s.inTok, output_tokens: s.outTok, cache_creation_input_tokens: s.cw, cache_read_input_tokens: s.cr }, modelPrices);
  }
  const models = [...byModel.values()].sort((a, b) => b.count - a.count);
  // 按日期聚合
  const byDate = new Map();
  for (const s of allSessions) {
    const d = (s.last || s.first || '').slice(0, 10);
    if (!d) continue;
    let e = byDate.get(d);
    if (!e) { e = { date: d, sessions: 0, turns: 0, tokens: 0, cost: 0 }; byDate.set(d, e); }
    e.sessions += 1;
    e.turns    += s.turns || 0;     // 累计"对话次数"（turn 级粒度）
    e.tokens += s.inTok + s.outTok;
    e.cost += calcCost(s.model || '', { input_tokens: s.inTok, output_tokens: s.outTok, cache_creation_input_tokens: s.cw, cache_read_input_tokens: s.cr }, modelPrices);
  }
  const dates = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  // 全局 token 汇总
  const totalIn = allSessions.reduce((s, x) => s + x.inTok, 0);
  const totalOut = allSessions.reduce((s, x) => s + x.outTok, 0);
  const totalCW = allSessions.reduce((s, x) => s + x.cw, 0);
  const totalCR = allSessions.reduce((s, x) => s + x.cr, 0);
  const totalTurns = allSessions.reduce((s, x) => s + (x.turns || 0), 0);   // 总对话次数
  const totalCost = allSessions.reduce((s, x) => s + calcCost(x.model || '', { input_tokens: x.inTok, output_tokens: x.outTok, cache_creation_input_tokens: x.cw, cache_read_input_tokens: x.cr }, modelPrices), 0);
  const totalCacheHit = (totalCR) / Math.max(1, totalCR + totalIn) * 100;
  return { projects, models, dates, totals: { in: totalIn, out: totalOut, cw: totalCW, cr: totalCR, cost: totalCost, cacheHit: totalCacheHit, turns: totalTurns }, sessions: allSessions };
}

// ----- 解析 ~/.claude/history.jsonl（用户交互历史，补充被清理的旧 session）-----
async function parseHistoryJsonl(file) {
  const sessions = new Map(); // sessionId -> { id, first, last, turns, cwd }
  try {
    const content = await fs.promises.readFile(file, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    for (const line of lines) {
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (!rec.sessionId || !rec.timestamp) continue;
      // history.jsonl 的 timestamp 是毫秒时间戳（数字），转为 ISO 字符串
      const ts = typeof rec.timestamp === 'number'
        ? new Date(rec.timestamp).toISOString()
        : rec.timestamp;
      let s = sessions.get(rec.sessionId);
      if (!s) {
        s = { id: rec.sessionId, records: [], cwd: rec.project || '', first: ts, last: ts, model: null, inTok: 0, outTok: 0, cw: 0, cr: 0, turns: 0 };
        sessions.set(rec.sessionId, s);
      }
      if (ts < s.first) s.first = ts;
      if (ts > s.last) s.last = ts;
      s.turns += 1;
    }
  } catch (e) {
    // 文件读失败忽略
  }
  return [...sessions.values()];
}

// ----- 主入口：扫描 + 聚合 + 转 UI 友好形态 -----
async function scan(opts = {}) {
  const logsPath = expandHome(opts.logsPath || '~/.claude/projects');
  const workspacePath = expandHome(opts.workspacePath || '~/Workspace');
  const configuredProjects = opts.configuredProjects || [];
  const modelPrices = opts.modelPrices || {};
  const files = await findJsonlFiles(logsPath);
  let all = [];
  for (const f of files) {
    const ss = await parseJsonl(f);
    all = all.concat(ss);
  }
  // 补充读取 ~/.claude/history.jsonl（包含被清理的旧 session 历史）
  const historyFile = path.join(os.homedir(), '.claude', 'history.jsonl');
  const existingIds = new Set(all.map(s => s.id));
  try {
    if ((await fs.promises.stat(historyFile)).isFile()) {
      const historySessions = await parseHistoryJsonl(historyFile);
      for (const hs of historySessions) {
        if (!existingIds.has(hs.id)) {
          all.push(hs);
        }
      }
    }
  } catch { /* history.jsonl 不存在则忽略 */ }
  // ⚠️ 不要过滤 sessions！全局 stats/heatmap/trend/pie/sankey 永远用全部 session
  // 只有 recentProjects/recentActivities 才用 configuredProjects 列表
  const agg = aggregate(all, modelPrices);
  // aggregate([]) 返回 null，shaped 也 null → 不能 set meta。用空 shape 兜底
  const empty = {
    stats: [], trendDays: [], trendData: [], pieData: [],
    recentProjects: [], recentActivities: [],
    projects: { current: null, sessions: [] },
    models: { cards: [], prices: [] },
    tokens: { stats: [], savings: null, sankey: null },
    heatmap: [], heatmapYearlyStats: [], levels: { current: { lv: 1, score: 0, target: 1240, streak: 0 } },
  };
  const shaped = agg ? shapeForUI(agg, { ...opts, configuredProjects, modelPrices }) : empty;
  shaped.meta = {
    logsPath, workspacePath,
    filesScanned: files.length,
    sessionsScanned: all.length,
    configuredProjectsCount: configuredProjects.length,
    source: all.length > 0 ? 'real' : (configuredProjects.length > 0 ? 'no-data' : 'empty'),
  };
  return shaped;
}

// ----- UI 形态（与 renderer 期望对齐）-----
function shapeForUI(agg, opts) {
  const modelPrices = opts.modelPrices || {};
  if (!agg) return null;
  const now = new Date();
  // 14 天趋势
  const trendDays = [];
  const trendData = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    trendDays.push(`${d.getMonth()+1}/${d.getDate()}`);
    trendData.push(agg.dates.find(x => x.date === key)?.turns || 0);
  }
  // 4 个 stat cards
  const todayKey = now.toISOString().slice(0, 10);
  const yesterdayDate = new Date(now); yesterdayDate.setDate(now.getDate() - 1);
  const yesterdayKey = yesterdayDate.toISOString().slice(0, 10);
  const todayTurns = agg.dates.find(x => x.date === todayKey)?.turns || 0;
  const yesterdayTurns = agg.dates.find(x => x.date === yesterdayKey)?.turns || 0;
  const weekStart = new Date(now); weekStart.setDate(weekStart.getDate() - 6);
  const weekDates = new Set();
  for (let i = 0; i < 7; i++) { const d = new Date(weekStart); d.setDate(weekStart.getDate() + i); weekDates.add(d.toISOString().slice(0,10)); }
  const weekAgg = agg.dates.filter(x => weekDates.has(x.date));
  const weekTurns = weekAgg.reduce((s,x) => s + x.turns, 0);
  const weekCost = weekAgg.reduce((s,x) => s + x.cost, 0);
  const weekTokens = weekAgg.reduce((s,x) => s + x.tokens, 0);
  const weekActiveDays = weekAgg.length;
  // 连续活跃
  let streak = 0;
  for (let i = 0; i < 90; i++) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    if (agg.dates.find(x => x.date === d.toISOString().slice(0,10))) streak++; else break;
  }
  const stats = [
    { labelKey: 'overview_stat_today_turns', value: String(todayTurns), deltaKey: 'overview_stat_today_delta', deltaParams: { diff: Math.abs(todayTurns-yesterdayTurns), dir: todayTurns >= yesterdayTurns ? '↑' : '↓' }, trend: todayTurns >= yesterdayTurns ? 'up' : 'down' },
    { labelKey: 'overview_stat_week_cost', value: `$${weekCost.toFixed(2)}`, deltaKey: 'overview_stat_week_cost_delta', trend: 'warn' },
    { labelKey: 'overview_stat_active_days', labelParams: { streak }, value: `${weekActiveDays} / 7`, deltaKey: 'overview_stat_active_days_delta', deltaParams: { pct: Math.round(weekActiveDays/7*100) }, trend: 'up' },
    { labelKey: 'overview_stat_week_tokens', value: weekTokens.toLocaleString(), deltaKey: 'overview_stat_week_tokens_delta', deltaParams: { rate: (agg.totals.cr / Math.max(1, agg.totals.cr + agg.totals.in) * 100).toFixed(0) }, trend: 'up' },
  ];
  // pie：显示所有真实模型
  const pieData = agg.models.map(m => ({ name: m.name, value: +(m.inTok/1e6 + m.outTok/1e6).toFixed(2) }));
  // recent projects / activities — 基于用户手动配置的 configuredProjects
  const configured = opts.configuredProjects || [];
  // 用 agg 里的统计 (sessions/tokens/last) 合并到配置项
  const projectStatsByPath = new Map(agg.projects.map(p => [p.path, p]));
  const enriched = configured.map(cfg => {
    const stats = projectStatsByPath.get(cfg.path);
    return stats ? { ...cfg, sessions: stats.sessions, inTok: stats.inTok, outTok: stats.outTok, last: stats.last, models: stats.models }
                 : { ...cfg, sessions: 0, inTok: 0, outTok: 0, last: null, models: [] };
  });
  // 按 lastOpenedAt 倒序（最近打开的在前）
  enriched.sort((a, b) => (b.lastOpenedAt || '').localeCompare(a.lastOpenedAt || ''));
  const recentProjects = enriched.slice(0, 4).map(p => ({
    name: p.name, path: p.path, model: p.models[0] || '—', star: true,
  }));
  // 最近活动 = 列表中 lastOpenedAt 在 7 天内的项目
  const sevenDaysAgo = new Date(now); sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const recentActivities = enriched
    .filter(p => p.lastOpenedAt && new Date(p.lastOpenedAt) >= sevenDaysAgo)
    .slice(0, 4)
    .map(p => ({ name: p.name, path: p.path, time: humanTime(p.lastOpenedAt) }));
  // projects — 当前项目 = 最近打开的
  const current = enriched[0] || { name: '—', path: opts.workspacePath, sessions: 0, inTok: 0, outTok: 0, cost: 0, first: null, last: null, models: [] };
  const projectCurrent = {
    name: current.name, path: current.path,
    stats: { sessions: current.sessions, projects: enriched.length, tokens: fmtTok(current.inTok + current.outTok), cost: `$${(calcCost('', { input_tokens: current.inTok, output_tokens: current.outTok, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 })).toFixed(1)}` },
    meta: { first: (current.addedAt || '').slice(0, 10), last: humanTime(current.lastOpenedAt), models: current.models.length, hours: '—' },
  };
  // sessions for table — 当前项目下的最近会话
  const sessionList = (current.sessionList || agg.sessions).slice(0, 20).map((s, i) => ({
    id: s.id.slice(0, 8) + '...', time: s.last || s.first, turns: s.turns, model: s.model || '—',
    tokens: (s.inTok + s.outTok + s.cw + s.cr),
  }));
  // models
  const maxCount = Math.max(1, ...agg.models.map(m => m.count));
  // 显示所有真实扫描到的模型（不限 3 个）
  const modelCards = agg.models.map(m => ({
    name: m.name, bar: Math.round(m.count / maxCount * 100),
    count: m.count, inTok: fmtTok(m.inTok), outTok: fmtTok(m.outTok), cost: `$${m.cost.toFixed(2)}`,
  }));
  // tokens
  const tokenStats = [
    { label: 'Input',       value: (agg.totals.in / 1e6).toFixed(1),  unit: 'M' },
    { label: 'Output',      value: (agg.totals.out / 1e6).toFixed(1), unit: 'M' },
    { label: 'Cache Write', value: (agg.totals.cw / 1e6).toFixed(1),  unit: 'M' },
    { label: 'Cache Read',  value: (agg.totals.cr / 1e6).toFixed(1),  unit: 'M' },
  ];
  // sankey：所有真实模型
  const topModels = agg.models;
  const sankey = {
    nodes: [
      { name: 'Input' }, { name: 'Cache Read' },
      ...topModels.map(m => ({ name: m.name })),
      { name: 'Output' },
    ],
    links: [
      ...topModels.map(m => ({ source: 'Input', target: m.name, value: Math.max(1, Math.round(m.inTok/1e5)) })),
      ...topModels.map(m => ({ source: 'Cache Read', target: m.name, value: Math.max(1, Math.round(m.cr/1e5)) })),
      ...topModels.map(m => ({ source: m.name, target: 'Output', value: Math.max(1, Math.round(m.outTok/1e5)) })),
    ],
  };
  // 缓存节省 = CR * (in - cr_price)  / 1e6
  const savedAmount = (agg.totals.cr / 1e6) * (PRICE_TABLE['claude-sonnet-4'].in - PRICE_TABLE['claude-sonnet-4'].cr);
  const tokens = {
    stats: tokenStats,
    savings: { hitRate: `${agg.totals.cacheHit.toFixed(1)}%`, saved: `$${Math.round(savedAmount).toLocaleString()}` },
    sankey,
  };
  // heatmap：从今年 1 月 1 日到今天（确保年度热力图覆盖全年）
  const yearStart = new Date(now.getFullYear(), 0, 1);
  const totalDays = Math.ceil((now - yearStart) / 86400000) + 1;
  const heatmap = [];
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(yearStart); d.setDate(d.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    const rec = agg.dates.find(x => x.date === key);
    heatmap.push([key, rec ? (rec.sessions * 3 + (rec.tokens > 100000 ? Math.round(rec.tokens/50000) : 0)) : 0]);
  }
  // 年度统计卡片（供热力图页使用，具体数值由前端 yearData 实时计算，此处仅作兜底）
  const heatmapYearlyStats = [
    { labelKey: 'heatmap_total_active_days', value: String(agg.dates.length), delta: `/ ${Math.ceil((now - new Date(now.getFullYear(), 0, 1)) / 86400000)}` },
    { labelKey: 'heatmap_current_streak', value: `${maxStreak(agg.dates)}`, delta: streak > 0 ? '🔥' : '—' },
    { labelKey: 'heatmap_daily_avg', value: (agg.sessions.length / Math.max(1, agg.dates.length)).toFixed(1), delta: '—' },
    { labelKey: 'heatmap_weekly_active', value: `${weekActiveDays} / 7`, delta: `${Math.round(weekActiveDays/7*100)}%` },
  ];
  // levels: 每 1240 分一级
  const sessionCount = (agg.sessions || []).length;
  const totalScore = Math.max(1240, Math.round(sessionCount * 12 + agg.totals.in / 1e4));
  const lv = Math.floor(totalScore / 1240) + 1;
  const targetScore = lv * 1240;
  const levels = {
    current: { lv, score: totalScore, target: targetScore, streak },
  };
  return {
    stats, trendDays, trendData, pieData, recentProjects, recentActivities,
    projects: { current: projectCurrent, sessions: sessionList },
    models: {
  cards: modelCards,
  // 价格表：合并"内置默认 PRICE_TABLE + 用户持久化的 modelPrices"
  // 优先级：用户持久化 > 内置默认
  prices: (() => {
    const merged = { ...PRICE_TABLE, ...(modelPrices || {}) };
    return Object.entries(merged).map(([name, p]) => ({
      name, in: `$${p.in.toFixed(2)}`, out: `$${p.out.toFixed(2)}`, cw: `$${p.cw.toFixed(2)}`, cr: `$${p.cr.toFixed(2)}`,
      auto: !!(modelPrices && modelPrices[name]?.auto),
    }));
  })(),
},
    tokens,
    heatmap,
    heatmapYearlyStats,
    levels,
  };
}

// ----- 工具 -----
function fmtTok(n) {
  if (n >= 1e6) return (n/1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n/1e3).toFixed(0) + 'K';
  return String(n);
}
function humanTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  const diff = Date.now() - d.getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'human_just_now';
  if (m < 60) return `human_minutes_ago:${m}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `human_hours_ago:${h}`;
  const days = Math.floor(h / 24);
  if (days === 1) return 'human_yesterday';
  if (days < 7) return `human_days_ago:${days}`;
  return d.toISOString().slice(0, 10);
}
function maxStreak(dates) {
  if (!dates.length) return 0;
  const set = new Set(dates.map(d => d.date));
  let best = 0, cur = 0;
  const sorted = [...set].sort();
  for (let i = 0; i < sorted.length; i++) {
    if (i === 0) { cur = 1; }
    else {
      const prev = new Date(sorted[i-1]);
      const curr = new Date(sorted[i]);
      const diff = (curr - prev) / 86400000;
      cur = diff === 1 ? cur + 1 : 1;
    }
    if (cur > best) best = cur;
  }
  return best;
}

// ----- Seed 合成（无真实日志时兜底）-----
function seedSynthetic(workspacePath, logsPath) {
  // 基于 workspace 路径 hash 决定 seed，让同一台机器每次数据稳定
  let seed = 0;
  for (const ch of (workspacePath + logsPath)) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  let rng = seed;
  const rand = () => { rng = (rng * 1103515245 + 12345) >>> 0; return rng / 0xffffffff; };
  const MODELS = ['claude-sonnet-4', 'claude-opus-4', 'glm-4.6', 'claude-haiku-4'];
  const PROJECTS = ['Claude Board', 'xCloud IoT', 'hexo-blog', 'hermes-web-ui', 'scout-api', 'design-system'];
  const sessions = [];
  const now = new Date();
  for (let i = 0; i < 96; i++) {
    const projectIdx = Math.floor(rand() * PROJECTS.length);
    const projectName = PROJECTS[projectIdx];
    const projectPath = `${workspacePath}/${projectName.toLowerCase().replace(/\s+/g, '-')}`;
    const daysAgo = Math.floor(rand() * 90);
    const sessionStart = new Date(now);
    sessionStart.setDate(sessionStart.getDate() - daysAgo);
    sessionStart.setHours(Math.floor(rand() * 24), Math.floor(rand() * 60), 0, 0);
    const sessionEnd = new Date(sessionStart.getTime() + (10 + rand() * 50) * 60000);
    const model = MODELS[Math.floor(rand() * MODELS.length)];
    const turns = 2 + Math.floor(rand() * 30);
    const inTok  = Math.floor(rand() * 50000) + 1000;
    const outTok = Math.floor(rand() * 15000) + 200;
    const cr     = Math.floor(rand() * 80000);
    const cw     = Math.floor(rand() * 5000);
    sessions.push({
      id: Math.floor(rand() * 0xffffff).toString(16).padStart(8, '0') + Math.floor(rand() * 0xffffff).toString(16).padStart(8, '0'),
      cwd: projectPath,
      first: sessionStart.toISOString(),
      last:  sessionEnd.toISOString(),
      model,
      turns,
      inTok, outTok, cw, cr,
      records: [],
    });
  }
  return sessions;
}

module.exports = { scan, expandHome };
