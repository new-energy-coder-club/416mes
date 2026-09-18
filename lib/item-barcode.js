(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('@zxing/library'));else root.ItemBarcode=factory(root.ZXing);})(typeof globalThis!=='undefined'?globalThis:this,function(Z){
'use strict';
/* 阶段C：一维码 hints 从仅 CODE_128 扩到实物常见码制。
   确认卡承担了误读把关（用户确认才填入），扩码制不会绕过人工确认。 */
const FORMATS=Z?[Z.BarcodeFormat.CODE_128,Z.BarcodeFormat.CODE_39,Z.BarcodeFormat.CODE_93,
 Z.BarcodeFormat.EAN_13,Z.BarcodeFormat.EAN_8,Z.BarcodeFormat.UPC_A,Z.BarcodeFormat.UPC_E,
 Z.BarcodeFormat.ITF,Z.BarcodeFormat.CODABAR]:[];
function formatName(fmt){if(!Z)return '条形码';const k=Object.keys(Z.BarcodeFormat).find(n=>Z.BarcodeFormat[n]===fmt);return k?k.replace(/_/g,'-'):'条形码';}
function decode(image){if(!Z)throw Error('一维解码库不可用，请使用扫码枪或手输');const {width,height,data}=image;const pixels=new Uint8ClampedArray(width*height);for(let i=0;i<pixels.length;i++)pixels[i]=(data[i*4]+2*data[i*4+1]+data[i*4+2])/4;
 const source=new Z.RGBLuminanceSource(pixels,width,height),bitmap=new Z.BinaryBitmap(new Z.HybridBinarizer(source));const hints=new Map();hints.set(Z.DecodeHintType.POSSIBLE_FORMATS,FORMATS);const reader=new Z.MultiFormatReader();reader.setHints(hints);const result=reader.decode(bitmap);return {text:result.getText(),format:formatName(result.getBarcodeFormat())};}
async function frame(image){return decode(image);}
return {decode,frame,FORMATS};
});
