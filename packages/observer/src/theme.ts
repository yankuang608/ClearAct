// SPDX-License-Identifier: MIT
export type ObserverTheme='auto'|'light'|'dark';
type Color={r:number;g:number;b:number;a:number};
const clamp=(value:number,max=1)=>Math.max(0,Math.min(max,value));

function rgbColor(value:string):Color|null{
  if(value==='transparent')return {r:0,g:0,b:0,a:0};
  const match=/^rgba?\(([^)]+)\)$/i.exec(value);
  if(!match)return null;
  const parts=match[1].trim().split(/[\s,/]+/);
  if(parts.length<3||parts.length>4)return null;
  const channel=(part:string)=>clamp(Number.parseFloat(part)*(part.endsWith('%')?2.55:1),255);
  const [r,g,b]=parts.slice(0,3).map(channel);
  const alpha=parts[3],a=alpha===undefined?1:clamp(Number.parseFloat(alpha)/(alpha.endsWith('%')?100:1));
  return [r,g,b,a].every(Number.isFinite)?{r,g,b,a}:null;
}

/** Follows the host's background layers without inspecting page content. */
export function observePageTheme(host:HTMLElement,preference:ObserverTheme='auto'):()=>void{
  if(preference==='light'||preference==='dark'){
    host.dataset.clearactTheme=preference;
    return ()=>{};
  }
  const document=host.ownerDocument,view=document.defaultView;
  if(!view){host.dataset.clearactTheme='light';return ()=>{};}
  const media=view.matchMedia('(prefers-color-scheme: dark)');
  let disposed=false,frame=0;
  let observed:HTMLElement[]=[];
  let context:CanvasRenderingContext2D|null|undefined;
  const readColor=(value:string):Color|null=>{
    const rgb=rgbColor(value);
    if(rgb)return rgb;
    // Let the browser convert modern CSS colors instead of maintaining a color library.
    try{
      if(context===undefined)context=document.createElement('canvas').getContext('2d',{willReadFrequently:true});
      if(!context)return null;
      context.clearRect(0,0,1,1);context.fillStyle='transparent';context.fillStyle=value;context.fillRect(0,0,1,1);
      const [r,g,b,a]=context.getImageData(0,0,1,1).data;
      return {r,g,b,a:a/255};
    }catch{return null;}
  };
  const ancestors=()=>{
    // Default mounts are body siblings of SPA roots. Read the rendered surface
    // below the island as well as its ancestors, without inspecting its content.
    const panel=host.shadowRoot?.querySelector<HTMLElement>('.panel'),box=panel?.getBoundingClientRect();
    const width=box?.width||600,left=box?.width?box.left:Number.parseFloat(panel?.style.left||'')||((view.innerWidth-width)/2);
    const top=box?.height?box.top:Number.parseFloat(panel?.style.top||'')||40,height=box?.height||64;
    const x=Math.max(0,Math.min(view.innerWidth-1,left+width/2)),y=Math.max(0,Math.min(view.innerHeight-1,top+height/2));
    const rendered=typeof document.elementsFromPoint==='function'?document.elementsFromPoint(x,y).find(element=>element!==host&&!host.contains(element)&&element instanceof HTMLElement):undefined;
    const elements:HTMLElement[]=[];
    for(let element:HTMLElement|null=(rendered as HTMLElement|undefined)??host.parentElement??document.body??document.documentElement;element;element=element.parentElement){
      if(element!==host&&!elements.includes(element))elements.push(element);
    }
    for(let element=host.parentElement;element;element=element.parentElement)if(!elements.includes(element))elements.push(element);
    if(!elements.includes(document.documentElement)&&document.documentElement!==host)elements.push(document.documentElement);
    return elements;
  };
  const observer=new MutationObserver(()=>schedule());
  const update=()=>{
    frame=0;
    if(disposed)return;
    const elements=ancestors();
    if(elements.length!==observed.length||elements.some((element,index)=>element!==observed[index])){
      observer.disconnect();observed=elements;
      for(const element of elements)observer.observe(element,{attributes:true,attributeFilter:['class','style','data-theme','data-color-scheme'],childList:true});
    }
    let r=0,g=0,b=0,remaining=1,scheme='';
    for(const element of elements){
      const style=view.getComputedStyle(element);
      if(!scheme&&style.colorScheme&&style.colorScheme!=='normal')scheme=style.colorScheme;
      const color=readColor(style.backgroundColor);
      if(!color||color.a===0)continue;
      const contribution=remaining*color.a;
      r+=color.r*contribution;g+=color.g*contribution;b+=color.b*contribution;
      remaining*=1-color.a;
      if(remaining<=.001)break;
    }
    let theme:'light'|'dark';
    if(remaining===1){
      const tokens=scheme.toLowerCase().split(/\s+/),dark=tokens.includes('dark'),light=tokens.includes('light');
      theme=dark!==light?(dark?'dark':'light'):(media.matches?'dark':'light');
    }else{
      // Transparent ancestor backgrounds are composited over the browser's white canvas.
      const linear=(channel:number)=>{const value=(channel+255*remaining)/255;return value<=.04045?value/12.92:((value+.055)/1.055)**2.4;};
      const luminance=.2126*linear(r)+.7152*linear(g)+.0722*linear(b);
      theme=luminance>.179?'light':'dark';
    }
    if(host.dataset.clearactTheme!==theme)host.dataset.clearactTheme=theme;
  };
  function schedule(){if(!disposed&&!frame)frame=view!.requestAnimationFrame(update);}
  update();schedule();
  media.addEventListener('change',schedule);
  view.addEventListener('resize',schedule);document.addEventListener('scroll',schedule,true);host.addEventListener('pointerup',schedule);
  return ()=>{
    disposed=true;observer.disconnect();
    if(frame)view.cancelAnimationFrame(frame);
    frame=0;observed=[];context=null;
    media.removeEventListener('change',schedule);
    view.removeEventListener('resize',schedule);document.removeEventListener('scroll',schedule,true);host.removeEventListener('pointerup',schedule);
  };
}
