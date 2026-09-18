(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('@zxing/library'));else root.ItemBarcode=factory(root.ZXing);})(typeof globalThis!=='undefined'?globalThis:this,function(Z){
'use strict';
function decode(image){if(!Z)throw Error('一维解码库不可用，请使用扫码枪或手输');const {width,height,data}=image;const pixels=new Uint8ClampedArray(width*height);for(let i=0;i<pixels.length;i++)pixels[i]=(data[i*4]+2*data[i*4+1]+data[i*4+2])/4;
 const source=new Z.RGBLuminanceSource(pixels,width,height),bitmap=new Z.BinaryBitmap(new Z.HybridBinarizer(source));const hints=new Map();hints.set(Z.DecodeHintType.POSSIBLE_FORMATS,[Z.BarcodeFormat.CODE_128]);const result=new Z.MultiFormatReader();result.setHints(hints);return result.decode(bitmap).getText();}
async function frame(image){return decode(image);}
return {decode,frame};
});
