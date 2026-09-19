'use strict';
/* H1：「建档管理」独立页签结构测试。
   锁定：tab-register 包含三个 details 与全部原 id、tab-item-work 不再含它们、导航按钮存在且 data-primary。 */
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { parseHTML } = require('linkedom');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const { document } = parseHTML(html);

test('导航存在 data-tab="register" 按钮且 data-primary', () => {
  const btn = document.querySelector('button[data-tab="register"]');
  assert.ok(btn, '应有 data-tab="register" 的导航按钮');
  assert.equal(btn.getAttribute('data-primary'), '1');
  assert.equal(btn.textContent, '建档管理');
});

test('tab-register section 存在且包含三个 details 与全部原 id', () => {
  const tab = document.getElementById('tab-register');
  assert.ok(tab, '应有 id="tab-register" 的 section');
  const details = tab.querySelectorAll('details');
  assert.equal(details.length, 6, 'tab-register 应包含 6 个 details（建档/建档内高级/核实启用/退役/导入复核/关系冲突）');
  // 关键 id 全部保留
  const ids = ['itmRegisterDetails', 'itmRegisterType', 'itmRegisterCat', 'itmRegisterName', 'itmRegisterSpec',
    'itmRegisterAdvanced', 'itmRegisterCode', 'itmRegister', 'itmRegisterResult',
    'itmAdminLoc', 'itmAdminContainer', 'itmActivateLoc', 'itmActivateContainer',
    'itmRetireCode', 'itmRetireReason', 'itmRetire',
    'itmRecoveryReview', 'itmConflictRefresh', 'itmConflictPanel'];
  for (const id of ids) {
    assert.ok(tab.querySelector('#' + id), 'tab-register 内应保留 #' + id);
  }
  // 第一个 details（建档）默认 open
  const first = tab.querySelector('#itmRegisterDetails');
  assert.ok(first.hasAttribute('open'), '建档 details 应默认 open');
});

test('tab-item-work 不再包含管理与复核 details', () => {
  const tab = document.getElementById('tab-item-work');
  assert.ok(tab, '应有 id="tab-item-work" 的 section');
  assert.equal(tab.querySelector('#itmRegisterDetails'), null, 'tab-item-work 不应再含 itmRegisterDetails');
  assert.equal(tab.querySelector('#itmAdminLoc'), null, 'tab-item-work 不应再含 itmAdminLoc');
  assert.equal(tab.querySelector('#itmRetireCode'), null, 'tab-item-work 不应再含 itmRetireCode');
  assert.equal(tab.querySelector('#itmRecoveryReview'), null, 'tab-item-work 不应再含 itmRecoveryReview');
  assert.equal(tab.querySelector('#itmConflictPanel'), null, 'tab-item-work 不应再含 itmConflictPanel');
  // 但作业页本身的关键 id 仍在
  const workIds = ['itmKind', 'itmCode', 'itmScanBtn', 'itmCamera', 'itmConfirm', 'itmStatus', 'itmStep', 'itmRows', 'itmRowTable', 'itmPending'];
  for (const id of workIds) {
    assert.ok(tab.querySelector('#' + id), 'tab-item-work 内应保留 #' + id);
  }
});

test('tab-item-work 留有引导提示', () => {
  const tab = document.getElementById('tab-item-work');
  assert.match(tab.textContent, /建档、核实启用、退役已移到/);
});
