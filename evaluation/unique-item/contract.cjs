'use strict';
// Independent read-model oracle for fixture-based acceptance, not app code.
function unique(rows, code, kind) {
  const found = rows.filter(r => r.code === code);
  if (found.length !== 1) throw new Error(found.length ? 'DUPLICATE_' + kind : 'UNKNOWN_' + kind);
  return found[0];
}
function itemView(state, code) {
  const item = unique(state.items, code, 'ITEM');
  const status = item.status || 'unknown';
  const view = { code, status, container: null, location: null };
  if (status !== 'in_stock') return view;
  const c = unique(state.containers, item.container, 'CONTAINER');
  const l = unique(state.locations, c.loc, 'LOCATION');
  return { ...view, container: c.code, location: l.code };
}
function containerView(state, code) {
  const c = unique(state.containers, code, 'CONTAINER');
  return { code, location: c.loc || null, items: state.items.filter(i => i.status === 'in_stock' && i.container === code).map(i => i.code).sort() };
}
function locationView(state, code) {
  unique(state.locations, code, 'LOCATION');
  const containers = state.containers.filter(c => c.loc === code).map(c => c.code).sort();
  return { code, containers, items: containers.flatMap(c => containerView(state, c).items).sort() };
}
function oldMaterialFingerprint(state) {
  return JSON.stringify({ materials: state.materials, transactions: state.transactions, workorders: state.workorders, txnSeq: state.txnSeq });
}
module.exports = { itemView, containerView, locationView, oldMaterialFingerprint };
