/**
 * 发现 M（v3.13.9）：服务端 pulledAt 全仓零消费，健康面板的「最近同步」
 * 用的是客户端 new Date()——设备时钟不准时会误导。
 * 本测试锁死「数据层产出 → 界面消费」闭环（BUG-19 的同类）。
 */
'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

test('发现 M：服务端 pulledAt 必须被捕获并暴露给 UI', () => {
  assert.match(HTML, /HEALTH\.serverPulledAt = d\.pulledAt \|\| null/, '拉取后必须记录服务端时间戳');
  assert.match(HTML, /HEALTH\.serverPulledAtMs = d\.pulledAt \? Date\.parse\(d\.pulledAt\) : null/, '必须同时记 epoch 供偏移比较');
  // API 侧确实返回它
  const api = fs.readFileSync(path.join(ROOT, 'api/feishu/state.js'), 'utf8');
  assert.match(api, /pulledAt: new Date\(\)\.toISOString\(\)/, 'state 接口必须返回 pulledAt');
});

test('发现 M：健康面板必须同时显示客户端与服务端数据时间', () => {
  assert.match(HTML, /服务端数据时间 /, '面板必须显示服务端数据时间');
  assert.match(HTML, /设备时钟可能不准，请以服务端为准/, '偏移过大时必须给出可操作指引');
});

test('发现 M：偏移比较用 epoch，且无客户端时刻时不误报', () => {
  // 行为自证：复刻 index.html 的三段条件
  const calc = (serverMs, clientMs) => {
    if (!serverMs || !clientMs) return null;                       // 缺任一时刻不判
    const d = Math.abs((serverMs - clientMs) / 60000);
    return d > 2 ? Math.round(d) : null;                           // 阈值 2 分钟
  };
  const now = Date.now();
  assert.equal(calc(now, now - 40 * 60e3), 40, '设备慢 40 分钟必须报 40');
  assert.equal(calc(now, now - 60e3), null, '1 分钟抖动不报（阈值 2 分钟）');
  assert.equal(calc(now, null), null, '没有客户端时刻不得误报');
  assert.equal(calc(null, now), null, '没有服务端时刻不得误报');
  // 源码不得再用 ISO 与本地串直接相减
  const block = (HTML.match(/var skew = null;[\s\S]{0,700}?return clientLine/) || [''])[0];
  assert.ok(block.length > 0, '必须能取到 skew 计算块');
  assert.match(block, /HEALTH\.serverPulledAtMs/, '必须用服务端 epoch');
  assert.match(block, /HEALTH\.lastSyncAtMs/, '必须用客户端 epoch');
  assert.ok(!/new Date\(HEALTH\.lastSyncAt\)/.test(block), '不得再用本地时间串反解比较');
});

test('发现 M：客户端同步时刻记 epoch', () => {
  assert.match(HTML, /HEALTH\.lastSyncAt = new Date\(\)\.toLocaleTimeString\(\);\s*\n\s*HEALTH\.lastSyncAtMs = Date\.now\(\)/, '记展示串时必须同时记 epoch');
});
