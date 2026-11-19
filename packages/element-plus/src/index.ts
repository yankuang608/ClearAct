// SPDX-License-Identifier: MIT
import {useClearActView} from '@clearact/vue';
import type {PageViewRegistration,RenderedReader,RenderedNode} from '@clearact/core';

/** Verified against Element Plus 2.11.5, ordinary Table / basic Form / Dialog. */
export const elementPlusSupport = {
  version:'2.11.5',
  supported:['ElTable (ordinary)','ElForm / ElFormItem (basic controls)','ElDialog (including Teleport)'],
  unsupported:['Table V2','unpresented virtual rows','cascader / date / select / custom composite widgets'],
} as const;

const unsupportedWidgets:Array<[string,string]> = [
  ['.el-table-v2','element_plus_table_v2'],
  ['.el-date-editor','element_plus_date_picker'],
  ['.el-cascader','element_plus_cascader'],
  ['.el-tree-select','element_plus_tree_select'],
  ['.el-select','element_plus_select'],
  ['.el-autocomplete','element_plus_autocomplete'],
  ['.el-input-number,.el-color-picker,.el-transfer,.el-slider,.el-rate,.el-upload,.el-mention','element_plus_composite_control'],
  ['[role="combobox"]:not(select),[role="tree"],[role="listbox"]','element_plus_composite_control'],
];

/** Keep unsupported widgets visible as gaps; never serialize their cached options/models. */
function markUnsupportedWidgets(reader:RenderedReader,tree:RenderedNode):RenderedNode {
  const boundary=tree.element as Element;
  const seen=new Set<Element>();
  const markerFor=(element:Element):{element:Element;reason:string}|undefined=> {
    for(const [selector,reason] of unsupportedWidgets) {
      const marker=element.closest(selector);
      if(marker&&(marker===boundary||boundary.contains(marker)))return {element:marker,reason};
    }
    return undefined;
  };
  const unsupported=(marker:{element:Element;reason:string}):RenderedNode=>({element:marker.element,kind:'unsupported',name:reader.name(marker.element),unsupported:{reason:marker.reason}});
  const visit=(node:RenderedNode):RenderedNode|null=> {
    const marker=markerFor(node.element as Element);
    if(marker) {
      if(seen.has(marker.element))return null;
      seen.add(marker.element);
      return unsupported(marker);
    }
    if(node.children)node.children=node.children.map(visit).filter((child):child is RenderedNode=>child!==null);
    return node;
  };
  const rootMarker=markerFor(boundary);
  if(rootMarker)tree.children=[unsupported(rootMarker)];
  else if(tree.children)tree.children=tree.children.map(visit).filter((child):child is RenderedNode=>child!==null);
  return tree;
}

export function readElementPlusTable(reader:RenderedReader):RenderedNode {
  return markUnsupportedWidgets(reader,reader.table(undefined,{headers:'.el-table__header-wrapper th',rows:'.el-table__body-wrapper tr.el-table__row',cells:'td'}));
}
export function readElementPlusForm(reader:RenderedReader):RenderedNode {
  const form = markUnsupportedWidgets(reader,reader.form());
  const visit = (node:RenderedNode):void => {
    if (node.kind === 'field') {
      const element = node.element as Element;
      const item = element.closest('.el-form-item');
      if (item) {
        const label = reader.elements('.el-form-item__label',item)[0];
        if (label) { node.name = reader.text(label); node.required = reader.requiredIndicator(label,'::before'); }
        const errors = reader.elements('.el-form-item__error',item);
        if (errors.length) node.messages = errors.map(error=>reader.text(error));
      }
    }
    for (const child of node.children??[]) visit(child);
  };
  visit(form);
  return form;
}
export function readElementPlusDialog(reader:RenderedReader):RenderedNode {return markUnsupportedWidgets(reader,reader.dialog());}

/** Bind a DOM root or the component's public $el. Never pass data/form-model copies. */
export function useClearActElementPlusView(view:Omit<PageViewRegistration,'kind'|'read'> & {kind:'table'|'form'|'dialog'}):string {
  const read = view.kind === 'table' ? readElementPlusTable : view.kind === 'form' ? readElementPlusForm : readElementPlusDialog;
  const root = view.kind === 'dialog' ? () => {
    const element = view.root() as Element|null;
    // 2.11.5 puts modal ARIA on this public Teleport wrapper, above the panel.
    return element?.closest('.el-overlay-dialog[role="dialog"]') ?? element;
  } : view.root;
  return useClearActView({...view,root,read});
}
