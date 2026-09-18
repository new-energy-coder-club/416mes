(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('@zxing/library'));else root.ItemBarcode=factory(root.ZXing);})(typeof globalThis!=='undefined'?globalThis:this,function(Z){
'use strict';
/* 一维码 hints：实物常见码制；TRY_HARDER 让 ZXing 多扫几行（低位/高位/模糊时显著更稳）。
   确认卡承担了误读把关（用户确认才填入），扩码制不会绕过人工确认。 */
const FORMATS=Z?[Z.BarcodeFormat.CODE_128,Z.BarcodeFormat.CODE_39,Z.BarcodeFormat.CODE_93,
 Z.BarcodeFormat.EAN_13,Z.BarcodeFormat.EAN_8,Z.BarcodeFormat.UPC_A,Z.BarcodeFormat.UPC_E,
 Z.BarcodeFormat.ITF,Z.BarcodeFormat.CODABAR]:[];
function formatName(fmt){if(!Z)return '条形码';const k=Object.keys(Z.BarcodeFormat).find(n=>Z.BarcodeFormat[n]===fmt);return k?k.replace(/_/g,'-'):'条形码';}
function decodeBitmap(image){const {width,height,data}=image;const pixels=new Uint8ClampedArray(width*height);for(let i=0;i<pixels.length;i++)pixels[i]=(data[i*4]+2*data[i*4+1]+data[i*4+2])/4;
 const source=new Z.RGBLuminanceSource(pixels,width,height),bitmap=new Z.BinaryBitmap(new Z.HybridBinarizer(source));const hints=new Map();hints.set(Z.DecodeHintType.POSSIBLE_FORMATS,FORMATS);hints.set(Z.DecodeHintType.TRY_HARDER,true);const reader=new Z.MultiFormatReader();reader.setHints(hints);const result=reader.decode(bitmap);return {text:result.getText(),format:formatName(result.getBarcodeFormat())};}
/* 整帧失败时退回中间横带（与浮层扫描线区域一致）——标签在画面中占比小/偏下时全帧二值化常失败 */
function variants(image){if(!image||image.height<40)return [image];
 const top=Math.floor(image.height*0.25),h=Math.floor(image.height*0.5),rowBytes=image.width*4;
 const data=new Uint8ClampedArray(image.width*h*4);
 data.set(image.data.subarray(top*rowBytes,(top+h)*rowBytes));
 return [image,{width:image.width,height:h,data}];}
function decode(image){if(!Z)throw Error('一维解码库不可用，请使用扫码枪或手输');let lastErr=null;
 for(const v of variants(image)){try{return decodeBitmap(v);}catch(e){lastErr=e;}}
 throw lastErr||Error('未识别到条形码');}
async function frame(image){return decode(image);}
return {decode,frame,FORMATS};
});
