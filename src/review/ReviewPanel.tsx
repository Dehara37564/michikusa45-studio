import React, { useRef, useState } from 'react';
import type { ReviewData, StampDefinition } from '../shared/project';

type Props = {
  review: ReviewData;
  selectedDefinitionId?: string;
  onSelect: (id: string) => void;
  onAddDefinition: (name: string, color: string) => void;
  onUpdateDefinition: (definition: StampDefinition) => void;
  onDeleteDefinition: (id: string) => void;
  onReplaceDefinitions: (definitions: StampDefinition[]) => void;
  onToggleFarthestPath: () => void;
  onShowSummary: () => void;
};

type StampTemplate = { id: string; name: string; definitions: Array<{ name: string; color: string; order: number; size?: number }> };

const loadTemplates = (): StampTemplate[] => {
  try { return JSON.parse(localStorage.getItem('stamp-templates') ?? '[]'); } catch { return []; }
};

export function ReviewPanel(props: Props): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(false);
  const [templates, setTemplates] = useState<StampTemplate[]>(loadTemplates);
  const [creatingDefinition, setCreatingDefinition] = useState(false);
  const [editingNameId, setEditingNameId] = useState<string>();
  const [draftName, setDraftName] = useState('');
  const [draftColor, setDraftColor] = useState('#1a73e8');
  const [templateName, setTemplateName] = useState('');
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [panelPosition, setPanelPosition] = useState({ x: 0, y: 0 });
  const panelDragRef = useRef<{ pointerX: number; pointerY: number; originX: number; originY: number } | undefined>(undefined);

  const openDefinitionCreator = (): void => {
    setCreatingDefinition(true);
    setDraftName('');
    setDraftColor('#1a73e8');
  };

  const saveNewDefinition = (): void => {
    const name = draftName.trim();
    if (!name || !/^#[0-9a-f]{6}$/i.test(draftColor)) return;
    props.onAddDefinition(name, draftColor);
    setCreatingDefinition(false);
  };

  const finishNameEdit = (definition: StampDefinition, name: string): void => {
    const trimmedName = name.trim();
    if (trimmedName && trimmedName !== definition.name) props.onUpdateDefinition({ ...definition, name: trimmedName });
    setEditingNameId(undefined);
  };

  const saveTemplate = (): void => {
    const name = templateName.trim();
    if (!name) return;
    const next = [...templates, { id: crypto.randomUUID(), name, definitions: props.review.stampDefinitions.filter((definition) => definition.kind === 'custom').map(({ name: stampName, color, order, size }) => ({ name: stampName, color, order, size })) }];
    localStorage.setItem('stamp-templates', JSON.stringify(next));
    setTemplates(next);
    setTemplateName('');
    setSavingTemplate(false);
    setSelectedTemplateId(next[next.length - 1].id);
  };

  const applyTemplate = (templateId: string): void => {
    setSelectedTemplateId(templateId);
    if (templateId === 'new') {
      setSavingTemplate(true);
      return;
    }
    setSavingTemplate(false);
    const template = templates.find((item) => item.id === templateId);
    if (template) props.onReplaceDefinitions(template.definitions.map((definition, index) => ({ ...definition, id: crypto.randomUUID(), kind: 'custom', order: index + 1 })));
  };

  return <aside className={`review-panel ${collapsed ? 'collapsed' : ''}`} style={{ transform: `translate(${panelPosition.x}px, ${panelPosition.y}px)` }}>
    <div className="review-panel-header" onPointerDown={(event) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      panelDragRef.current = { pointerX: event.clientX, pointerY: event.clientY, originX: panelPosition.x, originY: panelPosition.y };
    }} onPointerMove={(event) => {
      const drag = panelDragRef.current;
      if (!drag) return;
      setPanelPosition({ x: drag.originX + event.clientX - drag.pointerX, y: drag.originY + event.clientY - drag.pointerY });
    }} onPointerUp={() => { panelDragRef.current = undefined; }} onPointerCancel={() => { panelDragRef.current = undefined; }}>
      {!collapsed && <h2>スタンプ箱</h2>}
      <button className="review-collapse" onPointerDown={(event) => event.stopPropagation()} onClick={() => setCollapsed((value) => !value)}>{collapsed ? 'スタンプ箱 ›' : '‹'}</button>
    </div>
    {!collapsed && <>
      <section className="template-controls"><h3>テンプレート</h3>
        <div className="template-picker"><select value={selectedTemplateId} onChange={(event) => applyTemplate(event.target.value)}><option value="">テンプレートを選択</option><option value="new">＋ 新規保存</option>{templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</select>
          {selectedTemplateId && selectedTemplateId !== 'new' && <button className="danger" title="選択中のテンプレートを削除" onClick={() => { const next = templates.filter((item) => item.id !== selectedTemplateId); localStorage.setItem('stamp-templates', JSON.stringify(next)); setTemplates(next); setSelectedTemplateId(''); }}>×</button>}
        </div>
        {savingTemplate && <div className="template-save"><input value={templateName} onChange={(event) => setTemplateName(event.target.value)} placeholder="テンプレート名" autoFocus /><button disabled={!templateName.trim()} onClick={saveTemplate}>現在の分類を保存</button></div>}
      </section>
      <div className="stamp-list">
        {[...props.review.stampDefinitions].sort((a, b) => a.order - b.order).map((definition) => <div className={`stamp-definition ${definition.kind === 'theme' ? 'theme-definition' : ''} ${props.selectedDefinitionId === definition.id ? 'selected' : ''}`} key={definition.id}>
          <button className="stamp-choice" onClick={() => props.onSelect(definition.id)}>
            <span className="stamp-shape" style={{ backgroundColor: definition.color }} />
            {editingNameId === definition.id
              ? <input className="stamp-name-input" defaultValue={definition.name} autoFocus onClick={(event) => event.stopPropagation()} onBlur={(event) => finishNameEdit(definition, event.target.value)} onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
                if (event.key === 'Escape') {
                  event.currentTarget.value = definition.name;
                  event.currentTarget.blur();
                }
              }} />
              : definition.kind === 'theme'
                ? <span>{definition.name}</span>
                : <span title="ダブルクリックで名前を変更" onDoubleClick={(event) => { event.stopPropagation(); setEditingNameId(definition.id); }}>{definition.name}</span>}
          </button>
          <label className="definition-color" title={`${definition.name}の色を変更`}>
            <input type="color" value={definition.color} onChange={(event) => props.onUpdateDefinition({ ...definition, color: event.target.value })} />
          </label>
          {definition.kind === 'theme'
            ? <span className="stamp-action-placeholder" aria-hidden="true" />
            : <button className="danger stamp-delete" title="削除" onClick={() => { if (window.confirm(`${definition.name}を削除しますか？`)) props.onDeleteDefinition(definition.id); }}>×</button>}
        </div>)}
      </div>
      <button onClick={openDefinitionCreator}>＋ スタンプを作る</button>
      {creatingDefinition && <div className="stamp-editor">
        <h3>スタンプを作る</h3>
        <label>分類名<input value={draftName} onChange={(event) => setDraftName(event.target.value)} maxLength={40} /></label>
        <label>色<div className="stamp-color-input"><input type="color" value={draftColor} onChange={(event) => setDraftColor(event.target.value)} /><input value={draftColor} onChange={(event) => setDraftColor(event.target.value)} /></div></label>
        <div className="stamp-editor-actions"><button onClick={() => setCreatingDefinition(false)}>キャンセル</button><button className="primary" disabled={!draftName.trim() || !/^#[0-9a-f]{6}$/i.test(draftColor)} onClick={saveNewDefinition}>保存</button></div>
      </div>}
      <label className="review-value-toggle"><input type="checkbox" checked={props.review.displaySettings.showFarthestPath} onChange={props.onToggleFarthestPath} />道草値を表示</label>
      <button className="show-summary-button" onClick={props.onShowSummary}>集計</button>
    </>}
  </aside>;
}
