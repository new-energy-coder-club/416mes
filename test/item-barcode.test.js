'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const barcode=require('../lib/item-barcode'),fixture=require('./fixtures/item-code128.json');
function raster(f){const modules=f.patterns.reduce((n,p)=>n+[...p].reduce((s,c)=>s+Number(c),0),f.quietModules*2),width=modules*f.modulePixels,height=f.height,data=new Uint8ClampedArray(width*height*4);data.fill(255);let x=f.quietModules*f.modulePixels;for(const p of f.patterns){let black=true;for(const digit of p){const length=Number(digit)*f.modulePixels;if(black)for(let dx=0;dx<length;dx++)for(let y=0;y<height;y++){const i=(y*width+x+dx)*4;data[i]=data[i+1]=data[i+2]=0;}x+=length;black=!black;}}return {width,height,data};}
test('actual ZXing Code128 decodes synthetic pixel fixture, not mocked text',()=>{assert.equal(barcode.decode(raster(fixture)),fixture.text);});
