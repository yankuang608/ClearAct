// SPDX-License-Identifier: MIT
export const observerStyles = `
:host,:host([data-clearact-theme=dark]){
  all:initial;position:fixed;inset:0;z-index:2147483000;pointer-events:none;
  font:13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;
  color:var(--island-ink);color-scheme:dark;
  --island-ink:#f0f1f3;--island-muted:#c3c5ca;--island-quiet:#9d9fa5;
  --island-hover:#ffffff0d;--island-line:#ffffff1c;--island-accent:#eef0f3;
  --island-face:linear-gradient(112deg,#ffffff25 0%,#e5e7eb09 41%,#11131519 72%,#ffffff1f 100%);
  --island-rim:linear-gradient(124deg,#ffffffb8 0%,#ffffff30 24%,#a5a7ad0a 40%,#ffffff99 57%,#11131870 76%,#f4f4f55e 100%);
  --island-track:#ffffff30;--island-thumb:#f5f5f6;--island-shadow:#000000a1;
  --history-face:linear-gradient(123deg,#353638f2,#26272bf5 64%,#3a3b3df0);
  --detail-face:#00000017;--island-text-shadow:0 1px 1px #00000040;
  --lens-tint:#ffffff;--lens-o1:.145;--lens-o2:.035;--lens-o3:.065;--lens-o4:.12;
  --lens-edge-light:#ffffff;--lens-edge-dark:#18191c;--lens-edge-o1:.72;--lens-edge-o2:.09;--lens-edge-o3:.48;
}
:host([data-clearact-theme=light]){
  color-scheme:light;--island-ink:#25272c;--island-muted:#52565e;--island-quiet:#73767d;
  --island-hover:#20212409;--island-line:#24272c1d;--island-accent:#34363d;
  --island-face:linear-gradient(112deg,#ffffff70 0%,#ffffff1c 41%,#e2e3e51c 72%,#ffffff59 100%);
  --island-rim:linear-gradient(124deg,#ffffffed 0%,#ffffffa3 24%,#a5a7ad0a 40%,#ffffffc7 57%,#45484e55 76%,#ffffffba 100%);
  --island-track:#25283135;--island-thumb:#3e4148;--island-shadow:#15181c4d;
  --history-face:linear-gradient(123deg,#fffffff7,#eceef0f5 64%,#fffffff7);
  --detail-face:#ffffff70;--island-text-shadow:0 1px 0 #ffffff73;
  --lens-o1:.44;--lens-o2:.11;--lens-o3:.10;--lens-o4:.35;
  --lens-edge-light:#ffffff;--lens-edge-dark:#505359;--lens-edge-o1:.94;--lens-edge-o2:.35;--lens-edge-o3:.58;
}
*{box-sizing:border-box}button,input{font:inherit}button{cursor:pointer}button:disabled{opacity:.5;cursor:not-allowed}
button:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid var(--island-accent);outline-offset:3px}
[hidden]{display:none!important}.orbit-icon{display:block;width:18px;height:18px;flex:none;overflow:visible}
.panel{
  position:fixed;pointer-events:auto;top:16px;left:0;
  width:600px;max-width:calc(100vw - 24px);max-height:calc(100dvh - 24px);
  display:flex;flex-direction:column;isolation:isolate;color:var(--island-ink);z-index:5;
  border:0;background:none;border-radius:17px;
}
/* The distant shadow leaves an air gap; it never catches page input. */
.panel:before{content:'';position:absolute;pointer-events:none;z-index:-2;left:46px;right:18px;top:calc(100% + 17px);height:9px;border-radius:50%;background:var(--island-shadow);filter:blur(8px);transform:translate(24px,10px) skewX(-8deg)}
.panel:after{content:'';position:absolute;pointer-events:none;z-index:-1;left:14px;right:14px;bottom:-1px;height:4px;border-radius:0 0 16px 16px;background:linear-gradient(180deg,#f0f1f348,#17181c4d 58%,transparent)}
:host([data-clearact-theme=light]) .panel:after{background:linear-gradient(180deg,#ffffff99,#85878c55 58%,transparent)}
.island-content{
  position:relative;isolation:isolate;display:flex;flex-direction:column;min-height:0;
  max-height:inherit;padding:8px 14px 7px;border-radius:17px;
  box-shadow:8px 13px 15px -13px #000000aa;touch-action:pan-y;cursor:grab;
}
/* Only the narrow perimeter fades. The center stays clear and readable. */
.island-content:before{
  content:'';position:absolute;pointer-events:none;inset:0;z-index:-2;border-radius:17px;
  background:linear-gradient(176deg,#ffffff23,transparent 10px),var(--island-face);
  backdrop-filter:blur(2.5px) saturate(102%) contrast(1.025);-webkit-backdrop-filter:blur(2.5px) saturate(102%) contrast(1.025);
  box-shadow:inset 0 1px 0 #ffffff45,inset 0 -1px 0 #00000030;
  mask-image:linear-gradient(90deg,transparent,#000 1.5px,#000 calc(100% - 1.5px),transparent),linear-gradient(180deg,transparent,#000 1.5px,#000 calc(100% - 1.5px),transparent);mask-composite:intersect;
  -webkit-mask-image:linear-gradient(90deg,transparent,#000 1.5px,#000 calc(100% - 1.5px),transparent),linear-gradient(180deg,transparent,#000 1.5px,#000 calc(100% - 1.5px),transparent);-webkit-mask-composite:source-in;
}
.island-content:after{
  content:'';position:absolute;pointer-events:none;inset:.5px;padding:1px;z-index:-1;border-radius:16.5px;background:var(--island-rim);
  mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);mask-composite:exclude;
  -webkit-mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);-webkit-mask-composite:xor;
}
:host([data-clearact-theme=light]) .island-content{box-shadow:7px 11px 13px -12px #1d202563}
:host([data-clearact-theme=light]) .island-content:before{box-shadow:inset 0 1px 0 #ffffff9c,inset 0 -1px 0 #4a4d5428}
.island-header{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:26px;flex:none;min-width:0;touch-action:none}
.header-left{display:flex;align-items:center;gap:9px;min-width:0;flex:none}
.drag-handle{display:flex;align-items:center;gap:6px;border:0;padding:0;color:var(--island-ink);background:none;cursor:grab;touch-action:none;user-select:none;font-weight:600;font-size:10px;white-space:nowrap;text-shadow:var(--island-text-shadow)}
.drag-handle:active,.island-content:active{cursor:grabbing}.mark{display:grid;place-items:center;width:22px;height:22px;flex:none;color:var(--island-ink);background:none}.drag-dots{color:var(--island-quiet);font-size:11px;margin-left:1px}
.connection{font-size:8px;color:var(--island-muted);display:flex;gap:4px;align-items:center;white-space:nowrap}
.connection:before{content:'';width:4px;height:4px;border-radius:50%;background:var(--island-accent);opacity:.7}
.panel[data-agent-mode=disconnected] .connection:before,.panel[data-agent-mode=stopped] .connection:before{opacity:.35}.panel[data-agent-mode=approval] .connection:before{background:#d7b676;opacity:1}
.control-actions{display:flex;gap:5px;align-items:center;flex:none}
.tool,.toggle{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:24px;border:0;background:transparent;color:var(--island-muted);border-radius:6px;font-size:9px;padding:0 5px;white-space:nowrap}
.tool:hover,.toggle:hover,.tool[aria-expanded=true]{background:var(--island-hover);color:var(--island-ink)}
.history-count{font-size:8px;color:var(--island-quiet)}.toggle{height:24px;width:22px;padding:0;font-size:14px}
.stop,.resume{height:26px;border-radius:7px;padding:0 9px;font-size:10px;line-height:24px;font-weight:650;white-space:nowrap;cursor:pointer}
.stop{background:linear-gradient(148deg,#c4596b,#a7364e);border:1px solid #f5a0ad70;color:#fff7f8;box-shadow:0 2px 4px #16010738,inset 0 1px 0 #ffc3cd2e}
.stop:before{content:'■';font-size:7px;margin-right:5px}.stop:hover{background:linear-gradient(148deg,#d46c7d,#b9445b)}
.resume{background:linear-gradient(148deg,#63686e,#454950);border:1px solid #d7d9de55;color:#fff}.resume:hover{background:linear-gradient(148deg,#757b82,#555a62)}
.frequency{display:flex;align-items:center;gap:6px;min-width:0;margin-left:auto;padding:0 2px;color:var(--island-muted);font-size:8px;flex:none;cursor:default}
.frequency label{font-size:8px;white-space:nowrap}.frequency-value{font-size:8px;max-width:68px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums;color:var(--island-muted)}
.frequency-slider{display:flex;align-items:center;gap:5px;min-width:0}.frequency-slider span{font-size:7px;color:var(--island-quiet);white-space:nowrap}
.frequency input{appearance:none;-webkit-appearance:none;display:block;width:64px;min-width:38px;height:3px;margin:0;border:0;border-radius:3px;background:var(--island-track);cursor:ew-resize;accent-color:var(--island-thumb);touch-action:auto}
.frequency input::-webkit-slider-thumb{appearance:none;-webkit-appearance:none;width:9px;height:9px;border-radius:50%;border:0;background:var(--island-thumb);box-shadow:0 1px 3px #00000044,0 0 0 1px #ffffff33;cursor:ew-resize}
.frequency input::-moz-range-thumb{width:9px;height:9px;border-radius:50%;border:0;background:var(--island-thumb);box-shadow:0 1px 3px #00000044;cursor:ew-resize}
.island-body{padding:5px 2px 0;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--island-track) transparent;cursor:default;touch-action:pan-y}
.narrative-row{display:flex;align-items:center;gap:7px;min-height:18px;cursor:grab;user-select:none;touch-action:none}
.activity{width:7px;height:7px;border:1px solid var(--island-track);border-top-color:var(--island-accent);border-radius:50%;flex:none;animation:ca-spin 1.2s linear infinite}
.control-status{margin:0;font-size:12px;line-height:18px;font-weight:430;color:var(--island-ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;text-shadow:var(--island-text-shadow)}
.panel[data-agent-mode=ready] .activity,.panel[data-agent-mode=stopped] .activity,.panel[data-agent-mode=disconnected] .activity,.panel[data-agent-mode=approval] .activity{width:4px;height:4px;margin-inline:1px;border:0;background:var(--island-quiet);animation:none}
.panel[data-agent-mode=stopped] .control-status{color:var(--island-muted)}
.error{font-size:11px;line-height:1.8;color:#f0b4ba;overflow-wrap:anywhere}.control-error:empty{display:none}.control-error{padding:0 2px;margin-top:7px;max-height:25vh;overflow:auto;cursor:text;touch-action:pan-y;flex:none}
:host([data-clearact-theme=light]) .error{color:#a13648}
.approval{margin-top:10px;padding:11px;border:1px solid var(--island-line);background:var(--detail-face);border-radius:9px;color:var(--island-ink);font-size:11px;cursor:default;touch-action:pan-y}
.approval>.status{display:block;font-size:10px;font-weight:600;margin-bottom:6px;color:var(--island-ink)}.approval p{margin:0 0 8px;overflow-wrap:anywhere}.buttons{display:flex;gap:7px;justify-content:flex-end;flex-wrap:wrap;margin-top:10px}
.buttons button,.retry{border:1px solid var(--island-line);background:var(--island-hover);color:var(--island-ink);border-radius:6px;font-size:11px;padding:5px 11px}
.buttons .primary{background:var(--island-ink);color:#2b2d32;border-color:transparent}:host([data-clearact-theme=light]) .buttons .primary{color:#fff}
.buttons button:hover,.retry:hover{filter:brightness(1.15)}.detail{font-size:11px;color:var(--island-muted);overflow-wrap:anywhere}
details{margin-top:8px;cursor:default}summary{cursor:pointer;font-size:10px;color:var(--island-muted)}pre{font:11px/1.8 ui-monospace,SFMono-Regular,monospace;white-space:pre-wrap;overflow-wrap:anywhere;max-height:155px;overflow:auto;background:var(--detail-face);border:1px solid var(--island-line);padding:9px;border-radius:6px;color:var(--island-muted);touch-action:pan-y}
.history-menu{position:absolute;top:calc(100% + 34px);right:0;width:286px;max-width:calc(100vw - 24px);max-height:var(--history-height,55vh);overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--island-track) transparent;pointer-events:auto;background:var(--history-face);border:1px solid var(--island-line);border-radius:13px;box-shadow:17px 27px 19px #0000004d,inset 0 1px 0 #ffffff24;color:var(--island-ink);backdrop-filter:blur(7px);-webkit-backdrop-filter:blur(7px);z-index:3;cursor:default;touch-action:pan-y}
:host([data-clearact-theme=light]) .history-menu{border-color:#ffffffba;box-shadow:17px 27px 19px #1c222b29,inset 0 1px 0 #fff}
.history-header{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:9px 11px 3px;font-size:9px;color:var(--island-muted)}.history-header small{font-size:8px;color:var(--island-quiet);margin-left:6px}.history-close{border:0;border-radius:5px;background:none;color:var(--island-muted);font-size:15px;width:20px;height:20px;padding:0}.history-close:hover{background:var(--island-hover)}
.history-list{display:flex;align-items:center;gap:4px;padding:4px 12px 9px;min-height:28px;flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none}
.history-item{position:relative;display:block;flex:0 0 17px;width:17px;height:20px;padding:0;border:0;border-radius:5px;background:none;color:var(--island-muted);font-size:0;white-space:nowrap}
.history-item:before{content:'';position:absolute;top:8px;left:6px;width:5px;height:5px;background:currentColor;border-radius:50%;opacity:.4;transition:opacity .15s,box-shadow .15s}
.history-item:hover:before{opacity:.9}.history-item[aria-pressed=true]:before{opacity:1;background:var(--island-accent);box-shadow:0 0 0 3px var(--island-hover)}.history-item .status{display:none}
.history-detail{padding:11px 13px 13px;border-top:1px solid var(--island-line)}.history-detail .title{font-size:12px;font-weight:550;color:var(--island-ink);margin-bottom:7px}.history-detail p{font-size:11px;line-height:1.8;margin:7px 0;color:var(--island-muted);overflow-wrap:anywhere}.history-detail .error{color:#f0b4ba}:host([data-clearact-theme=light]) .history-detail .error{color:#a13648}
.history-detail button{border:0;border-radius:4px;background:none;color:var(--island-muted);font-size:9px;padding:2px 0;margin-top:6px;cursor:pointer}.history-detail button:hover{color:var(--island-ink)}.history-menu .empty{font-size:10px;color:var(--island-quiet);margin:2px 0 5px;line-height:1.8}
/* The dock is a separate, small hit area; the full expanded panel is hidden by the layout controller. */
.island-dock{position:fixed;left:0;top:0;width:76px;height:28px;padding:0;border:0;background:none;color:var(--island-ink);z-index:6;pointer-events:auto;cursor:pointer;isolation:isolate;touch-action:manipulation;filter:drop-shadow(3px 6px 5px #00000050);outline-offset:3px}
.island-dock .dock-outline{position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none}.island-dock>.orbit-icon{position:absolute;left:50%;top:43%;width:19px;height:19px;transform:translate(-50%,-50%);pointer-events:none}
.island-dock:hover{filter:drop-shadow(3px 7px 6px #00000066) brightness(1.08)}.island-dock:focus-visible{outline:1px solid var(--island-accent);border-radius:0 0 18px 18px}
.island-morph{position:fixed;z-index:7;pointer-events:none;isolation:isolate;will-change:left,top,width,height,transform;transform-origin:center center;color:var(--island-ink);filter:drop-shadow(12px 19px 10px #00000050)}
.morph-outline{position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none}
.morph-content{position:absolute;left:0;top:0;display:flex;flex-direction:column;padding:8px 14px 7px;min-height:0;border-radius:17px;transform-origin:50% 50%;pointer-events:none;color:var(--island-ink)}.morph-content *{pointer-events:none!important}
.morph-logo{position:absolute;left:50%;top:43%;width:19px;height:19px;transform:translate(-50%,-50%);color:var(--island-ink);pointer-events:none;opacity:0}.morph-logo .orbit-icon{width:100%;height:100%}
.action-frame{position:fixed;pointer-events:none;z-index:2;border:1px solid #7caf8b13;background:#72a98004;color:#69a07d}.action-frame i{position:absolute;width:14px;height:14px;border:2px solid currentColor}.action-frame i:nth-child(1){top:0;left:0;border-right:0;border-bottom:0}.action-frame i:nth-child(2){top:0;right:0;border-left:0;border-bottom:0}.action-frame i:nth-child(3){bottom:0;left:0;border-right:0;border-top:0}.action-frame i:nth-child(4){bottom:0;right:0;border-left:0;border-top:0}.action-frame.acquiring i{animation:ca-lock .55s ease-out}.action-frame[data-phase=approval]{color:#baa06a;background:#d6bc8405}.action-frame[data-phase=approval] i{animation:none}
@keyframes ca-spin{to{transform:rotate(360deg)}}@keyframes ca-lock{from{opacity:.15;transform:scale(1.4)}to{opacity:1;transform:scale(1)}}
@media(max-width:620px){.connection{display:none}.header-left{gap:5px}.drag-dots{display:none}.island-content,.morph-content{padding-inline:12px}.island-header{gap:6px}.frequency{gap:5px;padding:0}.frequency input{width:60px}.frequency-value{max-width:62px}.control-actions{gap:4px}.tool{padding-inline:4px}}
@media(max-width:480px){.panel{top:12px}.island-header{flex-wrap:wrap;gap:5px 7px}.header-left{margin-right:auto}.control-actions{margin-left:auto}.frequency{order:3;flex:0 1 auto;margin:3px 0 1px 28px;max-width:calc(100% - 28px)}.frequency input{width:72px}.frequency-value{max-width:95px}.control-status{font-size:11px;line-height:17px}.narrative-row{min-height:17px}.stop,.resume{padding-inline:7px;font-size:9px}.tool{font-size:8px}.history-header small{font-size:8px}}
@media(max-height:260px){.panel{top:8px;max-height:calc(100dvh - 16px)}.island-content,.morph-content{padding-top:6px;padding-bottom:6px}.approval{margin-top:6px;padding:8px}}
@media(prefers-reduced-motion:reduce){.activity,.action-frame i{animation:none!important}.history-item:before{transition:none}.island-morph{display:none!important}}
`;
