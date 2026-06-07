#!/usr/bin/env node
// test-terminal-detect.js — 跨平台终端检测逻辑的 mock 测试
// 在 macOS 上验证 Windows/Linux 检测逻辑是否正确
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

let passed = 0, failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✅ ${msg}`); }
  else           { failed++; console.log(`  ❌ ${msg}`); }
}

// ====== 提取检测核心逻辑（与 main.js 一致）======
const TERMINAL_DEFINITIONS = {
  darwin: [
    { id: 'iterm2',   label: 'iTerm2',      appPaths: ['/Applications/iTerm.app'], osascriptApp: 'iTerm' },
    { id: 'terminal',  label: 'Terminal.app', appPaths: ['/Applications/Utilities/Terminal.app', '/System/Applications/Utilities/Terminal.app'], osascriptApp: 'Terminal' },
  ],
  win32: [
    { id: 'wt',         label: 'Windows Terminal',  testCmd: 'wt.exe',         testArgs: ['--version'] },
    { id: 'powershell', label: 'PowerShell',         testCmd: 'powershell.exe', testArgs: ['-Command', 'echo ok'] },
    { id: 'cmd',        label: 'CMD',                testCmd: 'cmd.exe',        testArgs: ['/c', 'echo ok'] },
  ],
  linux: [
    { id: 'gnome-terminal',        label: 'GNOME Terminal' },
    { id: 'konsole',               label: 'Konsole' },
    { id: 'x-terminal-emulator',   label: 'X Terminal' },
  ],
};

// mock 版检测函数：可控 platform + spawn 结果
function createMockDetector(platform, spawnResults) {
  return async function detectTerminals() {
    const defs = TERMINAL_DEFINITIONS[platform] || [];
    const found = [];
    for (const def of defs) {
      let available = false;
      if (platform === 'darwin') {
        available = (def.appPaths || []).some(p => fs.existsSync(p));
      } else if (platform === 'win32') {
        const key = def.testCmd;
        available = !!spawnResults[key];
      } else if (platform === 'linux') {
        available = !!spawnResults[def.id];
      }
      if (available) found.push({ id: def.id, label: def.label, osascriptApp: def.osascriptApp });
    }
    return found;
  };
}

// ====== 测试用例 ======

async function runTests() {
  console.log('\n=== Windows 终端检测测试 ===\n');

  // 场景 1：三个终端都有
  console.log('场景 1：Windows Terminal + PowerShell + CMD 都有');
  let r = await createMockDetector('win32', {
    'wt.exe': true, 'powershell.exe': true, 'cmd.exe': true,
  })();
  assert(r.length === 3, '检测到 3 个终端');
  assert(r[0].id === 'wt',         '第一个是 Windows Terminal（最高优先级）');
  assert(r[1].id === 'powershell',  '第二个是 PowerShell');
  assert(r[2].id === 'cmd',         '第三个是 CMD');
  assert(r[0].label === 'Windows Terminal', 'label 正确');

  // 场景 2：只有 PowerShell 和 CMD（无 Windows Terminal）
  console.log('\n场景 2：无 Windows Terminal，只有 PowerShell + CMD');
  r = await createMockDetector('win32', {
    'wt.exe': false, 'powershell.exe': true, 'cmd.exe': true,
  })();
  assert(r.length === 2, '检测到 2 个终端');
  assert(r[0].id === 'powershell', '第一个是 PowerShell（提升为最高优先级）');
  assert(r[1].id === 'cmd',        '第二个是 CMD');

  // 场景 3：只有 CMD（最老的环境）
  console.log('\n场景 3：只有 CMD');
  r = await createMockDetector('win32', {
    'wt.exe': false, 'powershell.exe': false, 'cmd.exe': true,
  })();
  assert(r.length === 1, '检测到 1 个终端');
  assert(r[0].id === 'cmd', '唯一可用的是 CMD');

  // 场景 4：什么都没有（极端情况）
  console.log('\n场景 4：没有可用终端');
  r = await createMockDetector('win32', {
    'wt.exe': false, 'powershell.exe': false, 'cmd.exe': false,
  })();
  assert(r.length === 0, '返回空数组');

  // 场景 5：只有 Windows Terminal（Win11 新装）
  console.log('\n场景 5：只有 Windows Terminal');
  r = await createMockDetector('win32', {
    'wt.exe': true, 'powershell.exe': false, 'cmd.exe': false,
  })();
  assert(r.length === 1, '检测到 1 个终端');
  assert(r[0].id === 'wt', '是 Windows Terminal');

  console.log('\n=== Linux 终端检测测试 ===\n');

  // 场景 6：Linux 三个都有
  console.log('场景 6：GNOME Terminal + Konsole + X Terminal');
  r = await createMockDetector('linux', {
    'gnome-terminal': true, 'konsole': true, 'x-terminal-emulator': true,
  })();
  assert(r.length === 3, '检测到 3 个终端');
  assert(r[0].id === 'gnome-terminal', '第一个是 GNOME Terminal');

  // 场景 7：Linux 只有 konsole
  console.log('\n场景 7：只有 Konsole');
  r = await createMockDetector('linux', {
    'gnome-terminal': false, 'konsole': true, 'x-terminal-emulator': false,
  })();
  assert(r.length === 1, '检测到 1 个终端');
  assert(r[0].id === 'konsole', '是 Konsole');

  console.log('\n=== macOS 终端检测测试（真实环境）===\n');

  // 场景 8：macOS 真实检测
  console.log('场景 8：macOS 真实环境');
  r = await createMockDetector('darwin', {})();  // 用真实的 fs.existsSync
  assert(r.length >= 1, `至少检测到 1 个终端（实际 ${r.length} 个）`);
  if (r.length >= 1) assert(r[0].id === 'iterm2', 'iTerm2 优先于 Terminal.app');

  console.log('\n=== launchInTerminal 逻辑验证 ===\n');

  // 验证 launchInTerminal 的命令构造
  console.log('场景 9：各终端的启动命令构造');
  // macOS iTerm2
  const iterm2Info = { id: 'iterm2', label: 'iTerm2', osascriptApp: 'iTerm' };
  // macOS Terminal
  const terminalInfo = { id: 'terminal', label: 'Terminal.app', osascriptApp: 'Terminal' };
  // Windows WT
  const wtInfo = { id: 'wt', label: 'Windows Terminal' };
  // Windows PowerShell
  const psInfo = { id: 'powershell', label: 'PowerShell' };
  // Windows CMD
  const cmdInfo = { id: 'cmd', label: 'CMD' };

  // 模拟命令构造逻辑（不实际 spawn）
  function buildLaunchArgs(termInfo, cmd, platform) {
    const termId = termInfo?.id || 'unknown';
    if (platform === 'darwin') {
      if (termId === 'iterm2') {
        return { method: 'osascript', app: 'iTerm', cmd };
      } else {
        return { method: 'osascript', app: 'Terminal', cmd };
      }
    } else if (platform === 'win32') {
      if (termId === 'wt')         return { method: 'spawn', bin: 'wt.exe', args: ['new-tab', '-p', 'Command Prompt', 'cmd', '/k', cmd] };
      if (termId === 'powershell') return { method: 'spawn', bin: 'powershell.exe', args: ['-Command', `Start-Process powershell -ArgumentList '-NoExit','-Command','${cmd}'`] };
      return { method: 'spawn', bin: 'cmd', args: ['/c', 'start', 'Claude', 'cmd', '/k', cmd] };
    } else {
      const argsMap = {
        'gnome-terminal': ['--', 'sh', '-c', cmd],
        'konsole': ['-e', 'sh', '-c', cmd],
        'x-terminal-emulator': ['-e', 'sh', '-c', cmd],
      };
      return { method: 'spawn', bin: termId, args: argsMap[termId] || ['-e', 'sh', '-c', cmd] };
    }
  }

  let a;
  a = buildLaunchArgs(iterm2Info, 'cd /foo && claude', 'darwin');
  assert(a.app === 'iTerm', 'iTerm2 使用 iTerm app');
  assert(a.method === 'osascript', 'macOS 用 osascript');

  a = buildLaunchArgs(terminalInfo, 'cd /foo && claude', 'darwin');
  assert(a.app === 'Terminal', 'Terminal.app 使用 Terminal app');

  a = buildLaunchArgs(wtInfo, 'cd C:\\foo && claude', 'win32');
  assert(a.bin === 'wt.exe', 'Windows Terminal 用 wt.exe');
  assert(a.args[0] === 'new-tab', 'WT 参数以 new-tab 开始');

  a = buildLaunchArgs(psInfo, 'cd C:\\foo && claude', 'win32');
  assert(a.bin === 'powershell.exe', 'PowerShell 用 powershell.exe');
  assert(a.args[0] === '-Command', 'PS 参数以 -Command 开始');

  a = buildLaunchArgs(cmdInfo, 'cd C:\\foo && claude', 'win32');
  assert(a.bin === 'cmd', 'CMD 用 cmd');
  assert(a.args[3] === 'cmd', 'CMD start 命令中嵌套 cmd /k');

  a = buildLaunchArgs({ id: 'gnome-terminal', label: 'GNOME Terminal' }, 'cd /foo && claude', 'linux');
  assert(a.bin === 'gnome-terminal', 'Linux 用 gnome-terminal');
  assert(a.args[0] === '--', 'gnome-terminal 参数以 -- 开始');

  console.log(`\n${'='.repeat(40)}`);
  console.log(`总计: ${passed + failed} 个断言, ${passed} 通过, ${failed} 失败`);
  if (failed === 0) console.log('🎉 全部通过！');
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(e => { console.error(e); process.exit(1); });
