/* 416MES homepage — read-only dashboard and safe navigation.
   No stock mutations, no Feishu write, and no implicit cloud-truth claims. */
(function () {
  'use strict';
  var SNAPSHOT_KEY = 'mes416_state_v1';
  var BACKUP_KEY = 'mes416_last_backup';
  var DB_NAME = 'mes416-store';
  var byId = function (id) { return document.getElementById(id); };
  function setText(id, text) { var e = byId(id); if (e) e.textContent = text; }
  function validTime(value) {
    var n = typeof value === 'number' ? value : Date.parse(value);
    return Number.isFinite(n) && n > 1000000000000 && n <= Date.now() + 60000 ? n : null;
  }
  function formatTime(time) {
    return new Date(time).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  function updateNetwork() {
    var online = navigator.onLine !== false;
    setText('networkLabel', online ? '网络连接可用（云端未验证）' : '当前设备离线');
    setText('sourceSummary', online ? '概览是本机快照，不代表飞书同步成功' : '数据来自本机快照；离线时无法确认飞书状态');
    var e = byId('welcomeContext');
    if (e) e.classList.toggle('context-offline', !online);
  }
  function readLocal() {
    var raw, state;
    try {
      raw = localStorage.getItem(SNAPSHOT_KEY);
      if (!raw) return { kind: 'empty' };
      state = JSON.parse(raw);
      if (!state || typeof state !== 'object' || Array.isArray(state)) throw Error('结构异常');
      if (!Array.isArray(state.items) || !Array.isArray(state.workorders)) return { kind: 'invalid' };
      return { kind: 'ok', state: state };
    } catch (_) { return { kind: 'invalid' }; }
  }
  function showSnapshot() {
    var result = readLocal();
    var indicator = byId('snapshotIndicator');
    var counts = ['statItems', 'statInStock', 'statWip'];
    if (result.kind !== 'ok') {
      counts.forEach(function (id) { setText(id, '—'); });
      setText('dataNotice', result.kind === 'empty'
        ? '本浏览器尚未保存仓库快照。进入主应用同步后，这里才会显示本机库存统计；“—”不代表零库存。'
        : '本机快照不可读取或数据不完整。请到主应用“同步与状态”核对；不会用零代替未知。');
      indicator.textContent = result.kind === 'empty' ? '本机暂无快照' : '本机快照异常';
      indicator.className = 'indicator indicator--warn';
      return;
    }
    var state = result.state;
    var waiting = ['未执行', '待执行', '部分执行'];
    setText('statItems', String(state.items.length));
    setText('statInStock', String(state.items.filter(function (it) { return it && it.status === 'in_stock'; }).length));
    setText('statWip', String(state.workorders.filter(function (it) { return it && waiting.indexOf(it.status) >= 0; }).length));
    setText('dataNotice', '当前为本设备浏览器存储的业务快照，仅作操作参考；如需云端最新状态，请进入主应用验证飞书同步。');
    indicator.textContent = '本机快照 · 非云端实时';
    indicator.className = 'indicator indicator--neutral';
  }
  function showBackup() {
    var raw;
    try { raw = localStorage.getItem(BACKUP_KEY); } catch (_) { raw = null; }
    var when = raw == null ? null : validTime(Number(raw));
    if (!when) {
      setText('backupStatus', raw ? '本机备份时间无效' : '本机未发现备份记录');
      setText('backupHint', '这里仅查看当前浏览器的导出记录，不代表其他设备没有备份。');
      return;
    }
    var days = Math.floor((Date.now() - when) / 86400000);
    setText('backupStatus', days === 0 ? '今天有备份记录' : days + ' 天前备份');
    setText('backupHint', '本机记录时间：' + formatTime(when) + (days > 7 ? ' · 建议检查是否需要重新备份' : ''));
  }
  function showCloud() {
    setText('cloudStatus', navigator.onLine === false ? '设备离线 · 飞书未验证' : '云端同步状态未验证');
    setText('cloudHint', '联网只说明网络连接可用；是否同步成功，应在“同步与状态”页查看服务端与客户端数据时间。');
  }
  /* Open existing IndexedDB read-only. Never create or upgrade the DB from homepage. */
  function readPending() {
    return new Promise(function (resolve) {
      if (!window.indexedDB || typeof indexedDB.databases !== 'function') return resolve(null);
      indexedDB.databases().then(function (dbs) {
        if (!dbs.some(function (x) { return x.name === DB_NAME; })) return resolve(null);
        var req = indexedDB.open(DB_NAME);
        req.onupgradeneeded = function () { req.transaction.abort(); };
        req.onerror = function () { resolve(null); };
        req.onsuccess = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains('outbox')) { db.close(); return resolve(null); }
          var tx = db.transaction('outbox', 'readonly');
          var reqAll = tx.objectStore('outbox').getAll();
          reqAll.onerror = function () { db.close(); resolve(null); };
          reqAll.onsuccess = function () {
            db.close();
            var terminal = ['applied', 'rejected', 'discarded', 'done', 'completed', 'cancelled', 'canceled'];
            var list = Array.isArray(reqAll.result) ? reqAll.result : [];
            resolve(list.filter(function (c) { return c && terminal.indexOf(String(c.status || 'pending').toLowerCase()) < 0; }).length);
          };
          tx.onabort = function () { db.close(); resolve(null); };
        };
      }).catch(function () { resolve(null); });
    });
  }
  function showPending() {
    setText('statPending', '—');
    setText('pendingHelp', '仅读取本机 IndexedDB 队列');
    return readPending().then(function (count) {
      if (count === null) {
        setText('statPending', '—');
        setText('pendingHelp', '本机队列未初始化或不可读取');
      } else {
        setText('statPending', String(count));
        setText('pendingHelp', count ? '待提交 / 待确认的本机操作' : '当前本机队列没有未决操作');
      }
    });
  }
  function refresh() {
    updateNetwork();
    showSnapshot();
    showBackup();
    showCloud();
    return showPending();
  }
  var form = byId('homeSearchForm');
  if (form) form.addEventListener('submit', function (event) {
    event.preventDefault();
    var q = byId('homeSearch').value.trim();
    if (!q) {
      byId('homeSearch').focus();
      return;
    }
    // Hash-only read-only search; main application consumes #items?q=... after localStoreReady.
    window.location.assign('index.html#items?q=' + encodeURIComponent(q));
  });
  var refreshButton = byId('refreshSnapshot');
  if (refreshButton) refreshButton.addEventListener('click', refresh);
  window.addEventListener('online', refresh);
  window.addEventListener('offline', refresh);
  window.addEventListener('pageshow', function (e) { if (e.persisted) refresh(); });
  refresh();
})();
