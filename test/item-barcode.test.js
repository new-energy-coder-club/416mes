'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const barcode=require('../lib/item-barcode'),fixture=require('./fixtures/item-code128.json');

/* 通用光栅化：把黑白模块行渲染成 RGBA 图像 */
function raster(modules,width,height){const data=new Uint8ClampedArray(width*height*4);data.fill(255);for(let x=0;x<width;x++)for(let y=0;y<height;y++)if(modules[x]){const i=(y*width+x)*4;data[i]=data[i+1]=data[i+2]=0;}return {width,height,data};}
function raster128(f){const modules=f.patterns.reduce((n,p)=>n+[...p].reduce((s,c)=>s+Number(c),0),f.quietModules*2),width=modules*f.modulePixels,height=f.height,data=new Uint8ClampedArray(width*height*4);data.fill(255);let x=f.quietModules*f.modulePixels;for(const p of f.patterns){let black=true;for(const digit of p){const length=Number(digit)*f.modulePixels;if(black)for(let dx=0;dx<length;dx++)for(let y=0;y<height;y++){const i=(y*width+x+dx)*4;data[i]=data[i+1]=data[i+2]=0;}x+=length;black=!black;}}return {width,height,data};}

test('actual ZXing Code128 decodes synthetic pixel fixture with format name',()=>{
  const r=barcode.decode(raster128(fixture));
  assert.equal(r.text,fixture.text);
  assert.equal(r.format,'CODE-128');
});

/* ---- Code39：编码表取自 ZXing Code39Reader.CHARACTER_ENCODINGS（Apache-2.0） ---- */
const C39_ALPHABET='0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%';
const C39_ENC=[
 0x034,0x121,0x061,0x160,0x031,0x130,0x070,0x025,0x124,0x064,
 0x109,0x049,0x148,0x019,0x118,0x058,0x00D,0x10C,0x04C,0x01C,
 0x103,0x043,0x142,0x013,0x112,0x052,0x007,0x106,0x046,0x016,
 0x181,0x0C1,0x1C0,0x091,0x190,0x0D0,0x085,0x184,0x0C4,0x0A8,
 0x0A2,0x08A,0x02A];
const C39_STAR=0x094;
function code39Image(text){
  const narrow=1,wide=3,mp=3,quiet=10*mp,inter=1*mp,h=120;
  const bits=[];
  const pushChar=enc=>{for(let i=8;i>=0;i--)bits.push({black:i%2===0,w:(enc>>i&1)?wide:narrow});};
  pushChar(C39_STAR);
  for(const ch of text)pushChar(C39_ENC[C39_ALPHABET.indexOf(ch)]);
  pushChar(C39_STAR);
  const totalModules=bits.reduce((s,b)=>s+b.w,0)+(Math.floor(bits.length/9)-1)*1;
  const width=quiet*2+totalModules*mp;
  const modules=new Array(width).fill(false);
  let x=quiet;
  bits.forEach((b,idx)=>{
    for(let dx=0;dx<b.w*mp;dx++)modules[x+dx]=b.black;
    // 字符间的窄间隔：每 9 个元素（一个字符）之后才有，字符内部的条/空是连续的
    const isCharBoundary=(idx+1)%9===0;
    x+=b.w*mp+((isCharBoundary&&idx<bits.length-1)?inter:0);
  });
  return raster(modules,width,h);
}
test('Code39 synthetic barcode decodes (WP-001), not just CODE_128',()=>{
  const r=barcode.decode(code39Image('WP-001'));
  assert.equal(r.text,'WP-001');
  assert.equal(r.format,'CODE-39');
});

/* ---- EAN-13：L/G/R 模块表与奇偶规则（同 ZXing EAN13Reader 语义） ---- */
const L=['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'];
const R=L.map(s=>[...s].map(c=>c==='0'?'1':'0').join(''));
const G=R.map(s=>[...s].reverse().join(''));
const PARITY=['LLLLLL','LLGLGG','LLGGLG','LLGGGL','LGLLGG','LGGLLG','LGGGLL','LGLGLG','LGLGGL','LGGLGL'];
function ean13Image(text){
  assert.equal(text.length,13);
  const sum=[...text.slice(0,12)].reduce((s,c,i)=>s+Number(c)*(i%2?3:1),0);
  assert.equal((10-sum%10)%10,Number(text[12]),'fixture 自带校验位必须正确');
  const parity=PARITY[Number(text[0])];
  let bits='101';
  for(let i=0;i<6;i++){const d=Number(text[1+i]);bits+=(parity[i]==='L'?L:G)[d];}
  bits+='01010';
  for(let i=0;i<6;i++)bits+=R[Number(text[7+i])];
  bits+='101';
  const mp=3,quiet=11*mp,h=120,width=quiet*2+bits.length*mp;
  const modules=new Array(width).fill(false);
  for(let i=0;i<bits.length;i++)if(bits[i]==='1')for(let dx=0;dx<mp;dx++)modules[quiet+i*mp+dx]=true;
  return raster(modules,width,h);
}
test('EAN-13 synthetic barcode decodes (5901234123457)',()=>{
  const r=barcode.decode(ean13Image('5901234123457'));
  assert.equal(r.text,'5901234123457');
  assert.equal(r.format,'EAN-13');
});
