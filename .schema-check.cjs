
const S = require('/srv/416mes/lib/item-schema.js');
// 复刻线上真实 schema：locations 缺 库位角色 / 所属容器码
const online = {
  items: [{name:'物品码',type:1},{name:'容器码',type:1},{name:'状态',type:3,options:['unknown','pending','in_stock','out','retired']},{name:'库位码',type:1},{name:'业务版本',type:2},{name:'最后操作ID',type:1},{name:'最后更新时间',type:1002}],
  containers: [{name:'容器码',type:1},{name:'当前库位码',type:1},{name:'状态',type:3,options:['active','disabled']},{name:'业务版本',type:2},{name:'最后操作ID',type:1},{name:'最后更新时间',type:1002}],
  locations: [{name:'库位码',type:1},{name:'状态',type:3,options:['active','disabled','unknown']},{name:'最后更新时间',type:1002},{name:'类型',type:3,options:['货架','工位','站点','模块区','空地']},{name:'说明',type:1},{name:'授权人员',type:1}],
  itemOperations: [{name:'操作ID',type:1},{name:'操作类型',type:3,options:['receive','issue','transfer','placeContainer','moveContainer','verifyLegacy','retire','activateLocation','activateContainer','registerItem','registerLocation','registerContainer','receiveBatch','issueBatch']},{name:'物品码',type:1},{name:'容器码',type:1},{name:'请求内容',type:1},{name:'请求摘要',type:1},{name:'操作前快照',type:1},{name:'目标快照',type:1},{name:'处理阶段',type:3,options:['PREPARED','APPLIED','REJECTED','REPAIR_REQUIRED']},{name:'执行进度',type:1},{name:'操作人',type:1},{name:'设备',type:1},{name:'受理时间',type:5},{name:'完成时间',type:5},{name:'错误与恢复说明',type:1},{name:'最后更新时间',type:1002}]
};
const tables = { items: 't1', containers: 't2', locations: 't3', itemOperations: 't4' };
const r = S.validate(online, tables);
console.log('schemaValid:', r.schemaValid);
console.log('problems:', JSON.stringify(r.problems));
console.log('warnings:', JSON.stringify(r.warnings));
