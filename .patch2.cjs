const fs = require('fs');
const p = '/srv/416mes/lib/item-ui.js';
let s = fs.readFileSync(p, 'utf8');
const a = "  const cnts={pending:0,needs_attention:0,done:0,other:0};\n  commands.forEach(c=>{if(c.status==='pending')cnts.pending++;else if(c.status==='needs_attention')cnts.needs_attention++;else if(['APPLIED','REJECTED'].includes(c.status))cnts.done++;else cnts.other++;});";
const b = "  /* 已完结命令不进 commands（见 pending 开头过滤），done 分支随之消失 */\n  const cnts={pending:0,needs_attention:0,other:0};\n  commands.forEach(c=>{if(c.status==='pending')cnts.pending++;else if(c.status==='needs_attention')cnts.needs_attention++;else cnts.other++;});";
if (!s.includes(a)) { console.error('PATTERN A NOT FOUND'); process.exit(1); }
s = s.replace(a, b);
const c = "(cnts.done?' \u00b7 \u5df2\u7ed3\u675f '+cnts.done:'')";
if (s.includes(c)) { s = s.replace(c, ''); console.log('removed done summary'); }
fs.writeFileSync(p, s);
console.log('patched');