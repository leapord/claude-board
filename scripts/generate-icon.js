#!/usr/bin/env node
// scripts/generate-icon.js — 生成 Claude Board 应用图标
// 输出: build/icon.png (1024x1024), build/tray-icon.png (22x22 template)
const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

// 确保输出目录存在
const outDir = path.join(__dirname, '..', 'build');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

// ====== 主图标 1024x1024 ======
const SIZE = 1024;
const canvas = createCanvas(SIZE, SIZE);
const ctx = canvas.getContext('2d');

// 背景圆角矩形
const R = SIZE * 0.18; // 圆角
ctx.beginPath();
ctx.moveTo(R, 0);
ctx.lineTo(SIZE - R, 0);
ctx.quadraticCurveTo(SIZE, 0, SIZE, R);
ctx.lineTo(SIZE, SIZE - R);
ctx.quadraticCurveTo(SIZE, SIZE, SIZE - R, SIZE);
ctx.lineTo(R, SIZE);
ctx.quadraticCurveTo(0, SIZE, 0, SIZE - R);
ctx.lineTo(0, R);
ctx.quadraticCurveTo(0, 0, R, 0);
ctx.closePath();

// 渐变背景 — 深蓝到深紫
const bgGrad = ctx.createLinearGradient(0, 0, SIZE, SIZE);
bgGrad.addColorStop(0, '#0f172a');
bgGrad.addColorStop(0.5, '#1e1b4b');
bgGrad.addColorStop(1, '#0f172a');
ctx.fillStyle = bgGrad;
ctx.fill();

// 内发光
const innerGlow = ctx.createRadialGradient(SIZE/2, SIZE/2, SIZE*0.1, SIZE/2, SIZE/2, SIZE*0.5);
innerGlow.addColorStop(0, 'rgba(91, 157, 255, 0.15)');
innerGlow.addColorStop(1, 'rgba(91, 157, 255, 0)');
ctx.fillStyle = innerGlow;
ctx.fill();

// ====== 仪表盘主体 ======
const cx = SIZE / 2;
const cy = SIZE * 0.44;

// 外圈（表盘）
const outerR = SIZE * 0.32;
ctx.beginPath();
ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
const ringGrad = ctx.createLinearGradient(cx - outerR, cy - outerR, cx + outerR, cy + outerR);
ringGrad.addColorStop(0, 'rgba(91, 157, 255, 0.6)');
ringGrad.addColorStop(1, 'rgba(34, 211, 238, 0.6)');
ctx.strokeStyle = ringGrad;
ctx.lineWidth = SIZE * 0.03;
ctx.stroke();

// 内圈背景
ctx.beginPath();
ctx.arc(cx, cy, outerR - SIZE * 0.02, 0, Math.PI * 2);
ctx.fillStyle = 'rgba(15, 23, 42, 0.8)';
ctx.fill();

// 活跃弧线（70% 圆弧，表示活跃度）
const arcStart = -Math.PI * 0.75;
const arcEnd = arcStart + Math.PI * 1.5 * 0.72;
ctx.beginPath();
ctx.arc(cx, cy, outerR - SIZE * 0.045, arcStart, arcEnd);
const arcGrad = ctx.createLinearGradient(cx - outerR, cy, cx + outerR, cy);
arcGrad.addColorStop(0, '#3b82f6');
arcGrad.addColorStop(0.5, '#5b9dff');
arcGrad.addColorStop(1, '#22d3ee');
ctx.strokeStyle = arcGrad;
ctx.lineWidth = SIZE * 0.035;
ctx.lineCap = 'round';
ctx.stroke();

// 弧线端点发光点
const endX = cx + (outerR - SIZE * 0.045) * Math.cos(arcEnd);
const endY = cy + (outerR - SIZE * 0.045) * Math.sin(arcEnd);
ctx.beginPath();
ctx.arc(endX, endY, SIZE * 0.02, 0, Math.PI * 2);
ctx.fillStyle = '#22d3ee';
ctx.fill();
ctx.beginPath();
ctx.arc(endX, endY, SIZE * 0.035, 0, Math.PI * 2);
ctx.fillStyle = 'rgba(34, 211, 238, 0.3)';
ctx.fill();

// 刻度线（12条）
for (let i = 0; i < 12; i++) {
  const angle = arcStart + (Math.PI * 1.5 / 11) * i;
  const innerTick = outerR - SIZE * 0.07;
  const outerTick = outerR - SIZE * 0.055;
  ctx.beginPath();
  ctx.moveTo(cx + innerTick * Math.cos(angle), cy + innerTick * Math.sin(angle));
  ctx.lineTo(cx + outerTick * Math.cos(angle), cy + outerTick * Math.sin(angle));
  ctx.strokeStyle = 'rgba(91, 157, 255, 0.4)';
  ctx.lineWidth = SIZE * 0.005;
  ctx.lineCap = 'round';
  ctx.stroke();
}

// 中心文字 "CB"
ctx.font = `bold ${SIZE * 0.11}px "SF Pro Display", "Helvetica Neue", Arial, sans-serif`;
ctx.textAlign = 'center';
ctx.textBaseline = 'middle';
ctx.fillStyle = '#e6e8ec';
ctx.fillText('CB', cx, cy - SIZE * 0.005);

// 中心小文字 "BOARD"
ctx.font = `${SIZE * 0.03}px "SF Pro Display", "Helvetica Neue", Arial, sans-serif`;
ctx.fillStyle = 'rgba(91, 157, 255, 0.8)';
ctx.fillText('BOARD', cx, cy + SIZE * 0.06);

// ====== 底部迷你柱状图 ======
const barY = cy + outerR + SIZE * 0.06;
const barW = SIZE * 0.018;
const barGap = SIZE * 0.028;
const barCount = 14;
const barStartX = cx - (barCount * barGap) / 2;

const barColors = ['#3b82f6', '#5b9dff', '#22d3ee', '#4ade80'];
const barHeights = [0.3, 0.5, 0.7, 0.6, 0.85, 0.95, 1.0, 0.9, 0.75, 0.6, 0.8, 0.55, 0.4, 0.35];

for (let i = 0; i < barCount; i++) {
  const x = barStartX + i * barGap;
  const h = barHeights[i] * SIZE * 0.08;
  const color = barColors[i % barColors.length];

  // 柱子
  ctx.beginPath();
  const br = SIZE * 0.004;
  ctx.moveTo(x + br, barY + SIZE * 0.08 - h);
  ctx.lineTo(x + barW - br, barY + SIZE * 0.08 - h);
  ctx.quadraticCurveTo(x + barW, barY + SIZE * 0.08 - h, x + barW, barY + SIZE * 0.08 - h + br);
  ctx.lineTo(x + barW, barY + SIZE * 0.08);
  ctx.lineTo(x, barY + SIZE * 0.08);
  ctx.lineTo(x, barY + SIZE * 0.08 - h + br);
  ctx.quadraticCurveTo(x, barY + SIZE * 0.08 - h, x + br, barY + SIZE * 0.08 - h);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.7;
  ctx.fill();
  ctx.globalAlpha = 1;
}

// ====== 底部文字 ======
ctx.font = `bold ${SIZE * 0.04}px "SF Pro Display", "Helvetica Neue", Arial, sans-serif`;
ctx.textAlign = 'center';
ctx.fillStyle = 'rgba(230, 232, 236, 0.6)';
ctx.fillText('CLAUDE BOARD', cx, SIZE * 0.88);

ctx.font = `${SIZE * 0.022}px "SF Pro Display", "Helvetica Neue", Arial, sans-serif`;
ctx.fillStyle = 'rgba(91, 157, 255, 0.5)';
ctx.fillText('AI USAGE TRACKER', cx, SIZE * 0.93);

// 保存
const iconPath = path.join(outDir, 'icon.png');
fs.writeFileSync(iconPath, canvas.toBuffer('image/png'));
console.log('✅ icon.png saved:', iconPath);

// ====== 状态栏图标 22x22 (macOS template) ======
const TRAY = 44; // 2x for retina
const tc = createCanvas(TRAY, TRAY);
const tctx = tc.getContext('2d');

// 简化的 CB 标志
const tcx = TRAY / 2, tcy = TRAY / 2;

// 外圈
tctx.beginPath();
tctx.arc(tcx, tcy, TRAY * 0.42, 0, Math.PI * 2);
tctx.strokeStyle = '#ffffff';
tctx.lineWidth = 1.5;
tctx.stroke();

// 活跃弧
tctx.beginPath();
tctx.arc(tcx, tcy, TRAY * 0.34, -Math.PI * 0.7, Math.PI * 0.4);
tctx.strokeStyle = '#ffffff';
tctx.lineWidth = 2;
tctx.lineCap = 'round';
tctx.stroke();

// 中心点
tctx.beginPath();
tctx.arc(tcx, tcy, 2, 0, Math.PI * 2);
tctx.fillStyle = '#ffffff';
tctx.fill();

const trayPath = path.join(outDir, 'tray-icon.png');
fs.writeFileSync(trayPath, tc.toBuffer('image/png'));
console.log('✅ tray-icon.png saved:', trayPath);

console.log('\nDone! Files in build/:');
fs.readdirSync(outDir).forEach(f => {
  const stat = fs.statSync(path.join(outDir, f));
  console.log(`  ${f} (${(stat.size / 1024).toFixed(0)}KB)`);
});
