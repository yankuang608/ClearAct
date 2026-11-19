// SPDX-License-Identifier: MIT
import type {ContentBlock} from '@modelcontextprotocol/sdk/types.js';

/** Page-owned visual observations; no URI fetching, filesystem access or extra tool authority. */
export function operationContent(value:unknown):ContentBlock[]{
 const operation=value as any;
 if(operation?.status!=='succeeded'||!Array.isArray(operation?.result?.media))return [{type:'text',text:JSON.stringify(value)}];
 const images:ContentBlock[]=[];
 const media=operation.result.media.map((item:any)=>{
  if(item?.type==='image'&&['image/png','image/jpeg','image/webp'].includes(item.mimeType)&&typeof item.data==='string'&&item.data.length>0&&item.data.length<=128*1024&&/^[A-Za-z0-9+/]+={0,2}$/.test(item.data)&&images.length<2){
   images.push({type:'image',mimeType:item.mimeType,data:item.data});
   return {type:'image',mimeType:item.mimeType,availableAsImage:true};
  }
  return {type:'unsupported_media',availableAsImage:false};
 });
 return [{type:'text',text:JSON.stringify({...operation,result:{...operation.result,media}})},...images];
}
