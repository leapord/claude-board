// src/main/profile-manager.js — Claude Code ENV 配置组管理
// 从 model_helper 项目融合，管理 ~/.claude/profiles/*.json
// 核心能力：Profile CRUD + 切换配置写入 ~/.claude/settings.json
'use strict';

const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const HOME_DIR     = os.homedir();
const CLAUDE_DIR   = path.join(HOME_DIR, '.claude');
const SETTINGS_FILE = path.join(CLAUDE_DIR, 'settings.json');
const PROFILES_DIR  = path.join(CLAUDE_DIR, 'profiles');

// 确保 profiles 目录存在
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// 读取 ~/.claude/settings.json
function readClaudeSettings() {
  ensureDir(CLAUDE_DIR);
  if (!fs.existsSync(SETTINGS_FILE)) {
    return { env: {}, permissions: { allow: [] }, hasCompletedOnboarding: true };
  }
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
  } catch {
    return { env: {}, permissions: { allow: [] }, hasCompletedOnboarding: true };
  }
}

// 写入 ~/.claude/settings.json
function writeClaudeSettings(settings) {
  ensureDir(CLAUDE_DIR);
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
}

// Profile 文件路径
function profilePath(name) {
  // 安全过滤文件名：只允许字母数字、中文、- _ .
  const safe = name.replace(/[^a-zA-Z0-9一-鿿._-]/g, '_');
  return path.join(PROFILES_DIR, `${safe}.json`);
}

// ====== 7 个核心方法 ======

/**
 * 列出所有 profiles
 * @returns {Array<{name, description, env, filename, createdAt}>}
 */
function list() {
  ensureDir(PROFILES_DIR);
  const files = fs.readdirSync(PROFILES_DIR).filter(f => f.endsWith('.json'));
  return files.map(file => {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, file), 'utf-8'));
      return {
        name:        p.name || file.replace('.json', ''),
        description: p.description || '',
        env:         p.env || {},
        filename:    file,
        createdAt:   p.createdAt || null,
      };
    } catch {
      return null;
    }
  }).filter(Boolean);
}

/**
 * 获取单个 profile
 * @param {string} name
 * @returns {object|null}
 */
function get(name) {
  const fp = profilePath(name);
  if (!fs.existsSync(fp)) return null;
  try {
    const p = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    return {
      name:        p.name || name,
      description: p.description || '',
      env:         p.env || {},
      filename:    path.basename(fp),
      createdAt:   p.createdAt || null,
    };
  } catch {
    return null;
  }
}

/**
 * 新增 profile
 * @param {{ name: string, description?: string, env: object }} profile
 * @returns {{ ok: boolean, profile?: object, reason?: string }}
 */
function add(profile) {
  if (!profile.name) return { ok: false, reason: 'name-required' };
  ensureDir(PROFILES_DIR);
  const fp = profilePath(profile.name);
  if (fs.existsSync(fp)) return { ok: false, reason: 'duplicate' };

  const data = {
    name:        profile.name,
    description: profile.description || '',
    env:         profile.env || {},
    createdAt:   new Date().toISOString(),
  };
  fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf-8');
  return { ok: true, profile: data };
}

/**
 * 更新 profile
 * @param {string} name
 * @param {{ description?: string, env?: object }} patch
 * @returns {{ ok: boolean, reason?: string }}
 */
function update(name, patch) {
  const fp = profilePath(name);
  if (!fs.existsSync(fp)) return { ok: false, reason: 'not-found' };

  let data;
  try { data = JSON.parse(fs.readFileSync(fp, 'utf-8')); }
  catch { return { ok: false, reason: 'read-error' }; }

  if (patch.description !== undefined) data.description = patch.description;
  if (patch.env !== undefined) data.env = { ...data.env, ...patch.env };
  data.updatedAt = new Date().toISOString();

  fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf-8');
  return { ok: true, profile: data };
}

/**
 * 删除 profile
 * @param {string} name
 * @returns {{ ok: boolean, reason?: string }}
 */
function remove(name) {
  const fp = profilePath(name);
  if (!fs.existsSync(fp)) return { ok: false, reason: 'not-found' };
  fs.unlinkSync(fp);
  return { ok: true };
}

/**
 * 切换到指定 profile（写入 ~/.claude/settings.json 的 env）
 * @param {string} name
 * @returns {{ ok: boolean, reason?: string, env?: object }}
 */
function switchTo(name) {
  const p = get(name);
  if (!p) return { ok: false, reason: 'not-found' };

  const settings = readClaudeSettings();
  // 浅合并：profile 的 env 覆盖 settings.env 中同名的 key
  // 但先清空旧的 profile env keys（可选：提供 clean switch 模式）
  settings.env = { ...settings.env, ...p.env };
  writeClaudeSettings(settings);

  return { ok: true, env: settings.env };
}

/**
 * 读取当前生效的 env 配置
 * @returns {object} 当前 ~/.claude/settings.json 中的 env 对象
 */
function current() {
  const settings = readClaudeSettings();
  return settings.env || {};
}

/**
 * 获取 Claude Code 支持的环境变量字段定义（供 UI 表单用）
 */
function getEnvFields() {
  return [
    { key: 'ANTHROPIC_BASE_URL',                          label: 'API Base URL',    placeholder: 'https://api.anthropic.com',   required: true,  type: 'url' },
    { key: 'ANTHROPIC_AUTH_TOKEN',                         label: 'Auth Token',      placeholder: 'sk-ant-...',                  required: true,  type: 'password' },
    { key: 'ANTHROPIC_MODEL',                              label: '默认模型',         placeholder: 'claude-sonnet-4-20250514',    required: false, type: 'text' },
    { key: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',                label: 'Haiku 模型',      placeholder: 'claude-haiku-4-20250514',     required: false, type: 'text' },
    { key: 'ANTHROPIC_DEFAULT_SONNET_MODEL',               label: 'Sonnet 模型',     placeholder: 'claude-sonnet-4-20250514',    required: false, type: 'text' },
    { key: 'ANTHROPIC_DEFAULT_OPUS_MODEL',                 label: 'Opus 模型',       placeholder: 'claude-opus-4-20250514',      required: false, type: 'text' },
    { key: 'CLAUDE_CODE_SUBAGENT_MODEL',                   label: 'Subagent 模型',   placeholder: 'claude-haiku-4-20250514',     required: false, type: 'text' },
    { key: 'API_TIMEOUT_MS',                               label: '超时 (ms)',       placeholder: '3000000',                     required: false, type: 'text' },
    { key: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',     label: '禁用非必要流量',   placeholder: '1',                           required: false, type: 'text' },
  ];
}

module.exports = {
  list,
  get,
  add,
  update,
  remove,
  switchTo,
  current,
  getEnvFields,
};
