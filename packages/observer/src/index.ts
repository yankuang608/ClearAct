// SPDX-License-Identifier: MIT
import type {ClearActRuntime, ClearActOperation} from '@clearact/core';
import {ClearActCursor, cursorStyles} from './cursor.ts';
import {TargetLock} from './target-lock.ts';
import {observerStyles} from './styles.ts';
import {createOrbitIcon} from './icons.ts';
import {IslandLayout} from './island-layout.ts';
import {observePageTheme, type ObserverTheme} from './theme.ts';

export interface ClearActObserverOptions {
  /** Defaults to the host page background; override for application-specific themes. */
  theme?: ObserverTheme;
  /** Disable only the virtual pointer; target locking remains available. */
  cursor?: boolean;
  resolveTarget?: (operation:ClearActOperation)=>HTMLElement|null;
  styleNonce?: string;
  /** Human-readable approval preview through the application's normal permissions. */
  describeOperation?: (operation:ClearActOperation)=>string|Promise<string>;
}
type Preview={status:'loading'|'ready'|'error';text?:string};
const labels:Record<ClearActOperation['status'],string>={waiting_approval:'等待人工审批',queued:'排队中',executing:'正在执行',succeeded:'已完成',failed:'执行失败',rejected:'已拒绝',cancelled:'已取消'};
const terminal=new Set(['succeeded','failed','rejected','cancelled']);
function node<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string,className?:string){
  const element=document.createElement(tag);
  if(text!==undefined)element.textContent=text;
  if(className)element.className=className;
  return element;
}
function button(text:string,className?:string,label?:string){
  const element=node('button',text,className);element.type='button';
  if(label)element.setAttribute('aria-label',label);
  return element;
}

/** Renders broker facts and Agent intent; history never replaces the live operation. */
export function mountClearActObserver(runtime:ClearActRuntime,container?:HTMLElement,options:ClearActObserverOptions={}):()=>void{
  let disposed=false,collapsed=false,historyOpen=false,selectedHistory:string|undefined;
  let controlBusy=false,controlRequest=0,controlError='';
  let renderedHistory:string|undefined,renderedDetail:string|undefined;
  const previews=new Map<string,Preview>(),decisions=new Set<string>(),decisionErrors=new Map<string,string>();
  const active=new Map<string,{operation:ClearActOperation;phase:'preparing'|'executing'}>();
  const host=node('div');host.dataset.clearactObserver='true';(container??document.body).append(host);
  const shadow=host.attachShadow({mode:'open'}),style=node('style');
  if(options.styleNonce)style.nonce=options.styleNonce;
  style.textContent=cursorStyles+observerStyles+' .target-glow{display:none!important} .action-frame{inset:auto;box-shadow:none}';
  const panel=node('aside',undefined,'panel');panel.id='clearact-island';panel.setAttribute('aria-label','ClearAct 顶岛控制台');
  const surface=node('div',undefined,'island-content');
  const header=node('header',undefined,'island-header'),headerLeft=node('div',undefined,'header-left');
  const handle=button('','drag-handle','拖动 ClearAct 顶岛');handle.title='拖动顶岛；方向键移动';
  const mark=node('span',undefined,'mark');mark.append(createOrbitIcon());
  handle.append(mark,node('span','ClearAct'),node('span','⠿','drag-dots'));
  const connection=node('div',undefined,'connection'),connectionText=node('span');connection.append(connectionText);headerLeft.append(handle,connection);
  const controlActions=node('div',undefined,'control-actions');
  const historyToggle=button('回看','tool','选择历史操作'),historyCount=node('span','0','history-count');historyToggle.append(historyCount);historyToggle.setAttribute('aria-controls','clearact-history');
  const stop=button('Shut Down','stop','终止 Agent 操作');stop.title='立即停止后续 Agent 操作';
  const toggle=button('⌃','toggle','收起顶岛');toggle.title='收起顶岛';toggle.setAttribute('aria-controls','clearact-island-body');
  controlActions.append(historyToggle,stop,toggle);
  const body=node('div',undefined,'island-body');body.id='clearact-island-body';
  const row=node('div',undefined,'narrative-row'),activity=node('span',undefined,'activity');activity.setAttribute('aria-hidden','true');
  const controlStatus=node('p',undefined,'control-status');controlStatus.setAttribute('aria-live','polite');row.append(activity,controlStatus);
  const frequency=node('div',undefined,'frequency'),frequencyLabel=node('label','频率');frequencyLabel.htmlFor='operation-frequency';
  const frequencySlider=node('div',undefined,'frequency-slider'),frequencyInput=node('input');frequencyInput.id='operation-frequency';frequencyInput.type='range';frequencyInput.min='0';frequencyInput.max='100';frequencyInput.step='1';frequencyInput.setAttribute('aria-label','操作频率');
  const frequencyValue=node('span',undefined,'frequency-value');frequencyValue.id='clearact-frequency-value';frequencyInput.setAttribute('aria-describedby',frequencyValue.id);
  frequencySlider.append(node('span','慢'),frequencyInput,node('span','快'));frequency.append(frequencyLabel,frequencySlider,frequencyValue);
  const approval=node('section',undefined,'approval');approval.setAttribute('aria-label','本次操作确认');approval.hidden=true;
  header.append(headerLeft,frequency,controlActions);body.append(row,approval);
  const controlFailure=node('div',undefined,'error control-error');controlFailure.setAttribute('role','alert');
  const history=node('section',undefined,'history-menu');history.id='clearact-history';history.setAttribute('aria-label','历史操作');history.hidden=true;
  const historyHeader=node('header',undefined,'history-header'),historyHeading=node('span','历史回看');
  const closeHistory=button('×','history-close','关闭历史操作');historyHeader.append(historyHeading,closeHistory);
  const historyList=node('div',undefined,'history-list'),historyDetail=node('section',undefined,'history-detail');historyDetail.setAttribute('aria-label','历史操作详情');historyDetail.hidden=true;
  history.append(historyHeader,historyList,historyDetail);surface.append(header,body,controlFailure);panel.append(surface,history);
  const dock=button('','island-dock','展开顶岛');dock.append(createOrbitIcon());dock.setAttribute('aria-controls',panel.id);dock.hidden=true;
  const frame=node('div',undefined,'action-frame');frame.dataset.clearactFrame='true';frame.setAttribute('aria-hidden','true');frame.hidden=true;for(let n=0;n<4;n++)frame.append(node('i'));
  shadow.append(style,frame,panel,dock);
  const untheme=observePageTheme(host,options.theme);
  const resolveTarget=(operation:ClearActOperation):HTMLElement|null=>{
    if(runtime.contextMode==='page'){const trigger=runtime.getOperationTarget(operation);return trigger instanceof HTMLElement?trigger:null;}
    if(options.resolveTarget)return options.resolveTarget(operation);
    const target=runtime.getActions().find(action=>action.name===operation.action)?.target;
    return target?document.querySelector<HTMLElement>(target):null;
  };
  const cursor=new ClearActCursor(shadow,resolveTarget),lock=new TargetLock(frame,resolveTarget);
  const metadata=(operation:ClearActOperation)=>runtime.getActions().find(action=>action.name===operation.action);
  const details=(summary:string,value:unknown,open=false)=>{const element=node('details');element.open=open;element.append(node('summary',summary),node('pre',JSON.stringify(value,null,2)));return element;};
  const updateFrequency=()=>{
    const ms=runtime.getOperationIntervalMs();frequencyInput.value=String(100-ms/50);
    const rate=Number((1000/ms).toFixed(2));
    frequencyValue.textContent=ms===0?'尽快':`${rate}/s`;
    frequencyInput.setAttribute('aria-valuetext',ms===0?'尽快':`最多 ${rate} 次/秒`);
  };
  frequencyInput.addEventListener('input',()=>{runtime.setOperationIntervalMs(Math.round((100-Number(frequencyInput.value))*50));updateFrequency();});

  const placeIsland=()=>{
    if(disposed||!historyOpen||panel.hidden)return;
    const box=panel.getBoundingClientRect(),below=innerHeight-box.bottom-22,above=box.top-22;
    let top:number,height:number;
    if(below>=180||(below>=80&&below>=above)){top=box.bottom+10;height=Math.min(360,below);}
    else if(above>=80){height=Math.min(360,above);top=box.top-10-height;}
    else {top=Math.max(12,header.getBoundingClientRect().bottom+10);height=Math.max(0,innerHeight-top-12);}
    history.style.top=`${top-box.top}px`;history.style.setProperty('--history-height',`${height}px`);
    const width=Math.min(286,innerWidth-24);
    history.style.right=`${Math.min(0,box.right-width-12)}px`;
  };
  const layout=new IslandLayout({panel,surface,handle,dock,onCollapsedChange:value=>{collapsed=value;if(value)historyOpen=false;},onLayout:placeIsland});

  const renderApproval=(operation?:ClearActOperation)=>{
    approval.replaceChildren();approval.hidden=!operation||operation.status!=='waiting_approval';
    if(approval.hidden||!operation)return;
    if(options.describeOperation&&!previews.has(operation.id)){
      const preview:Preview={status:'loading'};previews.set(operation.id,preview);
      if(previews.size>100)previews.delete(previews.keys().next().value!);
      Promise.resolve().then(()=>options.describeOperation!(structuredClone(operation))).then(text=>{
        if(typeof text!=='string'||!text.trim())throw new Error('审批对象说明为空');preview.status='ready';preview.text=text;
      }).catch(error=>{preview.status='error';preview.text=error instanceof Error?error.message:String(error);}).finally(render);
    }
    const preview=previews.get(operation.id);
    approval.append(node('span',labels.waiting_approval,'status waiting_approval'));
    if(preview?.status==='ready')approval.append(node('p',preview.text));
    if(preview?.status==='loading')approval.append(node('p','正在读取审批对象…','detail'));
    if(preview?.status==='error'){
      approval.append(node('p',`暂不能批准：${preview.text}`,'error'));const retry=button('重新读取对象','retry');retry.addEventListener('click',()=>{previews.delete(operation.id);render();});approval.append(retry);
    }
    approval.append(details('核对操作参数',operation.arguments,true),node('p','核对目标与参数后，允许这次操作。','detail'));
    const buttons=node('div',undefined,'buttons');
    for(const decision of ['approve','reject'] as const){
      const control=button(decision==='approve'?'批准执行':'拒绝',decision==='approve'?'primary':undefined);
      control.disabled=!runtime.options.approvalToken||decisions.has(operation.id)||(decision==='approve'&&!!options.describeOperation&&preview?.status!=='ready');
      control.addEventListener('click',async()=>{
        if(decisions.has(operation.id))return;decisions.add(operation.id);decisionErrors.delete(operation.id);
        for(const sibling of Array.from(buttons.querySelectorAll('button')))sibling.disabled=true;
        try{await runtime[decision](operation.id);}catch(error){decisionErrors.set(operation.id,error instanceof Error?error.message:String(error));}finally{decisions.delete(operation.id);render();}
      });buttons.append(control);
    }
    approval.append(buttons);
    if(decisionErrors.has(operation.id))approval.append(node('p',decisionErrors.get(operation.id),'error'));
    if(!runtime.options.approvalToken)approval.append(node('p','请在具有人类审批权限的会话中处理。','detail'));
  };
  const renderHistory=(operations:ClearActOperation[])=>{
    const records=operations.filter(operation=>terminal.has(operation.status)).slice(0,12);
    if(!records.some(operation=>operation.id===selectedHistory))selectedHistory=undefined;
    historyCount.textContent=String(records.length);history.hidden=!historyOpen;historyToggle.setAttribute('aria-expanded',String(historyOpen));
    const listKey=JSON.stringify(records.map(operation=>[operation.id,operation.status,operation.intent,metadata(operation)?.title]));
    if(listKey!==renderedHistory){
      renderedHistory=listKey;historyList.replaceChildren();
      if(!records.length)historyList.append(node('p','操作完成后会记录在这里。','empty'));
      for(const operation of records){
        const item=button('','history-item',`查看${operation.intent||metadata(operation)?.title||operation.action}`);item.dataset.historyOperation=operation.id;
        item.title=`${labels[operation.status]} · ${operation.intent||metadata(operation)?.title||operation.action}`;
        item.addEventListener('click',()=>{selectedHistory=selectedHistory===operation.id?undefined:operation.id;render();});historyList.append(item);
      }
    }
    for(const item of Array.from(historyList.querySelectorAll<HTMLButtonElement>('[data-history-operation]'))){item.setAttribute('aria-expanded',String(item.dataset.historyOperation===selectedHistory));item.setAttribute('aria-pressed',String(item.dataset.historyOperation===selectedHistory));}
    const operation=records.find(record=>record.id===selectedHistory);
    const detailKey=JSON.stringify(operation?[operation.id,operation.updatedAt,operation.status,metadata(operation)?.title]:null);
    historyDetail.hidden=!operation;
    if(detailKey===renderedDetail)return;
    renderedDetail=detailKey;historyDetail.replaceChildren();
    if(operation){
      historyDetail.append(node('div',metadata(operation)?.title??operation.action,'title'),node('p',operation.intent));
      if(operation.error)historyDetail.append(node('p',operation.error,'error'));
      if(operation.result!==undefined)historyDetail.append(details('查看真实执行结果',operation.result));
      historyDetail.append(details('查看操作参数',operation.arguments));
      const close=button('收起详情');close.addEventListener('click',()=>{selectedHistory=undefined;render();});historyDetail.append(close);
    }
  };
  const render=()=>{
    if(disposed)return;
    const operations=runtime.getOperations(),current=active.values().next().value;
    const waitingApproval=operations.find(operation=>operation.status==='waiting_approval');
    const pending=current?.operation??waitingApproval??operations.find(operation=>operation.status==='queued'||operation.status==='executing');
    const enabled=runtime.isAgentEnabled(),connected=runtime.isConnected();
    const awaitingResult=!enabled&&pending?.status==='executing';
    const mode=!enabled?(awaitingResult?'stopping':'stopped'):!connected?'disconnected':current?.phase??(pending?.status==='waiting_approval'?'approval':pending?.status==='queued'?'queued':pending?'executing':'ready');
    if(collapsed&&enabled&&connected&&waitingApproval)layout.setCollapsed(false,{animate:false});
    panel.dataset.agentMode=mode;
    connectionText.textContent={stopping:'等待结果',stopped:'已停止',disconnected:'未连接',preparing:'定位中',executing:'执行中',approval:'等你确认',queued:'排队中',ready:'已就绪'}[mode];
    toggle.title='收起顶岛';toggle.setAttribute('aria-label',toggle.title);toggle.setAttribute('aria-expanded',String(!collapsed));
    stop.textContent=enabled?'Shut Down':'重新开启';stop.className=enabled?'stop':'resume';stop.setAttribute('aria-label',enabled?'终止 Agent 操作':'重新允许 Agent 操作');stop.title=enabled?'立即停止后续 Agent 操作':'允许 Agent 继续操作';stop.disabled=controlBusy&&!enabled;
    const latest=operations[0];
    const narrative=!enabled?(awaitingResult?`已停止后续操作，仍在等待这次操作的结果：${pending.intent}`:'已停下来，页面交还给你。'):!connected?'还没有连接上 Agent，页面可以照常使用。':pending?pending.intent||'正在处理这次操作。':!latest?'已连接。交给 Agent 的操作会在这里告诉你。':latest.status==='failed'?'刚才的操作未能完成，可以展开历史查看原因。':latest.status==='rejected'?'这次操作已拒绝，页面已就绪。':latest.status==='cancelled'?'这次操作已取消，页面已就绪。':'刚才的操作已返回结果，页面已就绪。';
    controlStatus.textContent=narrative;controlStatus.title=narrative;dock.title=`展开 ClearAct · ${narrative}`;dock.setAttribute('aria-description',narrative);controlFailure.textContent=controlError;
    if(enabled&&connected&&(current||pending?.status==='waiting_approval'))lock.track(current?.operation??pending!,current?.phase??'approval');else lock.clear();
    renderApproval(enabled&&connected?waitingApproval:undefined);renderHistory(operations);updateFrequency();layout.refresh();placeIsland();
  };
  toggle.addEventListener('click',()=>{layout.setCollapsed(true,{focus:true});render();});
  dock.addEventListener('click',render);
  historyToggle.addEventListener('click',()=>{historyOpen=!historyOpen;render();});
  closeHistory.addEventListener('click',()=>{historyOpen=false;render();historyToggle.focus();});
  const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&historyOpen){historyOpen=false;render();historyToggle.focus();}};document.addEventListener('keydown',escape);
  stop.addEventListener('click',async()=>{
    if(disposed||(controlBusy&&!runtime.isAgentEnabled()))return;
    const request=++controlRequest;controlBusy=true;controlError='';
    try{const pending=runtime.isAgentEnabled()?runtime.stop():runtime.resume();render();await pending;}
    catch(error){if(request===controlRequest)controlError=error instanceof Error?error.message:String(error);}
    finally{if(request===controlRequest){controlBusy=false;render();}}
  });
  const unhook=runtime.addBeforeExecuteHook((operation,context)=>{
    if(disposed||options.cursor===false||active.values().next().value?.operation.id!==operation.id)return;
    return cursor.prepare(operation,context.signal);
  });
  const unsubscribe=runtime.subscribe(event=>{
    if(event.type==='execution'&&event.operation){
      if(event.phase==='settled'){active.delete(event.operation.id);cursor.settled(event.operation);}
      else if(event.phase==='preparing'||event.phase==='executing'){active.set(event.operation.id,{operation:event.operation,phase:event.phase});if(event.phase==='executing')cursor.executing(event.operation);}
    }else if(event.type==='connection'&&!event.connected){active.clear();cursor.clear();}
    else if(event.type==='control'&&!event.enabled){cursor.clear();}
    render();
  });
  render();
  return()=>{disposed=true;unsubscribe();unhook();cursor.dispose();lock.dispose();active.clear();layout.dispose();untheme();document.removeEventListener('keydown',escape);host.remove();};
}
