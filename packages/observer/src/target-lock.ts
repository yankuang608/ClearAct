// SPDX-License-Identifier: MIT
import type {ClearActOperation} from '@clearact/core';

/** Tracks a resolved target without delaying execution or changing page styles. */
export class TargetLock {
  private operation?: ClearActOperation;
  private frame?: number;
  private disposed=false;
  constructor(private readonly element:HTMLElement,private readonly resolve:(operation:ClearActOperation)=>HTMLElement|null) {}
  track(operation:ClearActOperation,phase:string):void {
    const changed=this.operation?.id!==operation.id;
    this.operation=operation;
    this.element.dataset.operationId=operation.id;this.element.dataset.phase=phase;
    if(changed)this.element.classList.remove('acquiring');
    this.update();
    if(changed)this.element.classList.add('acquiring');
    if(this.frame===undefined)this.tick();
  }
  private update():void {
    try {
      const target=this.operation&&this.resolve(this.operation),rect=target?.getBoundingClientRect(),style=target&&getComputedStyle(target);
      if(document.hidden||!target?.isConnected||!rect?.width||!rect.height||!target.getClientRects().length||style?.display==='none'||style?.visibility!=='visible'||style.opacity==='0'||rect.bottom<0||rect.right<0||rect.top>innerHeight||rect.left>innerWidth||(target.checkVisibility&&!target.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))) {this.element.hidden=true;return;}
      // Keep every corner visible even when the business target is taller than the page.
      const left=Math.max(6,rect.left-8),top=Math.max(6,rect.top-8);
      const right=Math.min(innerWidth-6,rect.right+8),bottom=Math.min(innerHeight-6,rect.bottom+8);
      if(right<=left||bottom<=top){this.element.hidden=true;return;}
      Object.assign(this.element.style,{left:`${left}px`,top:`${top}px`,width:`${right-left}px`,height:`${bottom-top}px`});
      this.element.hidden=false;
    }catch{this.element.hidden=true;}
  }
  private tick():void {
    if(this.disposed||!this.operation)return;
    try{this.frame=requestAnimationFrame(()=>{this.frame=undefined;this.update();this.tick();});}catch{this.clear();}
  }
  clear():void {
    this.operation=undefined;
    if(this.frame!==undefined){try{cancelAnimationFrame(this.frame);}catch{/* Visual cleanup never gates business execution. */}this.frame=undefined;}
    this.element.hidden=true;delete this.element.dataset.operationId;delete this.element.dataset.phase;
  }
  dispose():void{this.disposed=true;this.clear();}
}
