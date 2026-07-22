import React, { useEffect, useRef, useState } from 'react';
import type { LayerDefinition } from '../shared/project';

type Props = {
  layers: LayerDefinition[];
  activeLayerId: string;
  onSelect: (id: string) => void;
  onToggleVisibility: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onAdd: () => void;
  onDelete: (id: string) => void;
};

export function LayerPanel(props: Props): React.JSX.Element {
  const savedLayout = useRef((() => { try { return JSON.parse(localStorage.getItem('layer-panel-layout') ?? 'null') as { position?: { x: number; y: number }; collapsed?: boolean } | null; } catch { return null; } })()).current;
  const [collapsed, setCollapsed] = useState(savedLayout?.collapsed === true);
  const [editingId, setEditingId] = useState<string>();
  const [position, setPosition] = useState(savedLayout?.position ?? { x: 0, y: 360 });
  const dragRef = useRef<{ pointerX: number; pointerY: number; originX: number; originY: number } | undefined>(undefined);

  useEffect(() => { localStorage.setItem('layer-panel-layout', JSON.stringify({ position, collapsed })); }, [position, collapsed]);

  return <aside className={`layer-panel ${collapsed ? 'collapsed' : ''}`} style={{ transform: `translate(${position.x}px, ${position.y}px)` }}>
    <div className="layer-panel-header" onPointerDown={(event) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = { pointerX: event.clientX, pointerY: event.clientY, originX: position.x, originY: position.y };
    }} onPointerMove={(event) => {
      const drag = dragRef.current;
      if (!drag) return;
      setPosition({ x: drag.originX + event.clientX - drag.pointerX, y: drag.originY + event.clientY - drag.pointerY });
    }} onPointerUp={() => { dragRef.current = undefined; }} onPointerCancel={() => { dragRef.current = undefined; }}>
      {!collapsed && <h2>レイヤー</h2>}
      <button onPointerDown={(event) => event.stopPropagation()} onClick={() => setCollapsed((value) => !value)}>{collapsed ? 'レイヤー ‹' : '›'}</button>
    </div>
    {!collapsed && <>
      <div className="layer-list">{[...props.layers].sort((a, b) => b.order - a.order).map((layer) => <div className={`layer-row ${props.activeLayerId === layer.id ? 'selected' : ''}`} key={layer.id}>
        <button className="layer-visibility" title={layer.visible ? '非表示にする' : '表示する'} onClick={() => props.onToggleVisibility(layer.id)}>{layer.visible ? '●' : '○'}</button>
        <button className="layer-choice" onClick={() => props.onSelect(layer.id)}>
          {editingId === layer.id
            ? <input defaultValue={layer.name} autoFocus onClick={(event) => event.stopPropagation()} onBlur={(event) => { const name = event.target.value.trim(); if (name) props.onRename(layer.id, name); setEditingId(undefined); }} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { event.currentTarget.value = layer.name; event.currentTarget.blur(); } }} />
            : <span title="ダブルクリックで名前を変更" onDoubleClick={(event) => { event.stopPropagation(); setEditingId(layer.id); }}>{layer.name}</span>}
        </button>
        <button className="danger" disabled={props.layers.length === 1} title="削除" onClick={() => props.onDelete(layer.id)}>×</button>
      </div>)}</div>
      <button className="add-layer-button" onClick={props.onAdd}>＋ レイヤーを追加</button>
    </>}
  </aside>;
}
