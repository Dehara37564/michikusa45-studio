import React, { useEffect, useRef, useState } from 'react';
import { BRUSH_DEFINITIONS, type BrushKind } from './shared/brushes';
import type { Tool } from './shared/project';

type Props = {
  brush: BrushKind; color: string; colorPresets: string[]; opacity: number; width: number; tool: Tool;
  selectionMode: 'transform' | 'marquee';
  zoomCompensatedInputWidth: boolean;
  onBrushChange: (brush: BrushKind) => void; onColorChange: (color: string) => void;
  onOpacityChange: (opacity: number) => void; onWidthChange: (width: number) => void;
  onToolChange: (tool: Tool) => void;
  onSelectionModeChange: (mode: 'transform' | 'marquee') => void;
  onRegisterColor: () => void;
  onStartEyedropper: () => void;
  onZoomCompensatedInputWidthChange: (enabled: boolean) => void;
};

const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));
const TOOLBOX_LAYOUT_KEY = 'illustration-toolbox-layout';
const loadToolboxLayout = (): { position: { x: number; y: number }; collapsed: boolean } => {
  try {
    const saved = JSON.parse(localStorage.getItem(TOOLBOX_LAYOUT_KEY) ?? 'null') as { position?: { x?: number; y?: number }; collapsed?: boolean } | null;
    return {
      position: { x: Number(saved?.position?.x ?? 0), y: Number(saved?.position?.y ?? 0) },
      collapsed: saved?.collapsed === true,
    };
  } catch {
    return { position: { x: 0, y: 0 }, collapsed: false };
  }
};
const hexToRgb = (hex: string) => { const value = Number.parseInt(hex.slice(1), 16); return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 }; };
const rgbToHex = (r: number, g: number, b: number) => `#${[r, g, b].map((value) => Math.round(value).toString(16).padStart(2, '0')).join('')}`;
const rgbToHsv = (r: number, g: number, b: number) => {
  const [red, green, blue] = [r / 255, g / 255, b / 255]; const maximum = Math.max(red, green, blue); const minimum = Math.min(red, green, blue); const delta = maximum - minimum; let hue = 0;
  if (delta) { if (maximum === red) hue = 60 * (((green - blue) / delta) % 6); else if (maximum === green) hue = 60 * ((blue - red) / delta + 2); else hue = 60 * ((red - green) / delta + 4); }
  return { h: hue < 0 ? hue + 360 : hue, s: maximum ? delta / maximum : 0, v: maximum };
};
const hsvToRgb = (h: number, s: number, v: number) => {
  const chroma = v * s; const section = h / 60; const x = chroma * (1 - Math.abs((section % 2) - 1));
  const [red, green, blue] = section < 1 ? [chroma, x, 0] : section < 2 ? [x, chroma, 0] : section < 3 ? [0, chroma, x] : section < 4 ? [0, x, chroma] : section < 5 ? [x, 0, chroma] : [chroma, 0, x]; const match = v - chroma;
  return { r: (red + match) * 255, g: (green + match) * 255, b: (blue + match) * 255 };
};

export function IllustrationToolbox(props: Props): React.JSX.Element {
  const initialLayout = useRef(loadToolboxLayout()).current;
  const [collapsed, setCollapsed] = useState(initialLayout.collapsed);
  const [position, setPosition] = useState(initialLayout.position);
  const dragRef = useRef<{ x: number; y: number; originX: number; originY: number } | undefined>(undefined);
  const rgb = hexToRgb(props.color); const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);

  useEffect(() => {
    localStorage.setItem(TOOLBOX_LAYOUT_KEY, JSON.stringify({ position, collapsed }));
  }, [position, collapsed]);
  const setHsv = (h: number, s: number, v: number) => { const next = hsvToRgb(h, s, v); props.onColorChange(rgbToHex(next.r, next.g, next.b)); };
  const updatePalette = (event: React.PointerEvent<HTMLDivElement>) => { const rect = event.currentTarget.getBoundingClientRect(); setHsv(hsv.h, clamp((event.clientX - rect.left) / rect.width, 0, 1), 1 - clamp((event.clientY - rect.top) / rect.height, 0, 1)); event.currentTarget.setPointerCapture(event.pointerId); };

  return <aside className={`illustration-toolbox${collapsed ? ' collapsed' : ''}`} style={{ transform: `translate(${position.x}px, ${position.y}px)` }}>
    <div className="illustration-toolbox-header" onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); dragRef.current = { x: event.clientX, y: event.clientY, originX: position.x, originY: position.y }; }} onPointerMove={(event) => { const drag = dragRef.current; if (drag) setPosition({ x: drag.originX + event.clientX - drag.x, y: drag.originY + event.clientY - drag.y }); }} onPointerUp={() => { dragRef.current = undefined; }} onPointerCancel={() => { dragRef.current = undefined; }}>
      {!collapsed && <h2>描画ツール</h2>}<button onPointerDown={(event) => event.stopPropagation()} onClick={() => setCollapsed((value) => !value)}>{collapsed ? '描画ツール ＋' : '−'}</button>
    </div>
    {!collapsed && <div className="illustration-toolbox-body">
      <section className="illustration-quick-section illustration-tool-section"><h3>ツール</h3><div className="illustration-tool-grid">
        <button className={props.tool === 'select' ? 'active' : ''} onClick={() => props.onToolChange('select')}><span className="select-preview">↖</span><span>選択</span></button>
        <button className={props.tool === 'pen' ? 'active' : ''} onClick={() => props.onToolChange('pen')}><span className="brush-preview brush-preview-pen" /><span>ペン</span></button>
        <button className={props.tool === 'eraser' ? 'active' : ''} onClick={() => props.onToolChange('eraser')}><span className="eraser-preview" /><span>消しゴム</span></button>
      </div></section>

      {props.tool === 'pen' && <section className="illustration-quick-section"><h3>ペンの種類</h3><div className="illustration-subtool-grid">
        {BRUSH_DEFINITIONS.map((definition) => <button key={definition.id} className={props.brush === definition.id ? 'active' : ''} onClick={() => props.onBrushChange(definition.id)}><span className={`brush-preview brush-preview-${definition.id}`} /><span>{definition.label}</span></button>)}
      </div></section>}
      {props.tool === 'select' && <section className="illustration-quick-section"><h3>選択方法</h3><div className="illustration-subtool-grid selection-subtools">
        <button className={props.selectionMode === 'transform' ? 'active' : ''} onClick={() => props.onSelectionModeChange('transform')}>移動・拡縮</button>
        <button className={props.selectionMode === 'marquee' ? 'active' : ''} onClick={() => props.onSelectionModeChange('marquee')}>範囲選択</button>
      </div></section>}

      {props.tool !== 'eraser' && <section className="illustration-quick-section"><h3>{props.tool === 'select' ? '選択した線の色' : '色'}</h3>
        <div className="illustration-sv-picker" style={{ backgroundColor: `hsl(${hsv.h} 100% 50%)` }} onPointerDown={updatePalette} onPointerMove={(event) => { if (event.buttons === 1) updatePalette(event); }}><span style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }} /></div>
        <div className="illustration-hue-row"><button type="button" className="eyedropper-icon" title="スポイト" aria-label="スポイト" onClick={props.onStartEyedropper}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m19.4 3.2 1.4 1.4a2 2 0 0 1 0 2.8l-3.1 3.1 1.1 1.1-1.9 1.9-1.1-1.1-7.7 7.7-4.2.7.7-4.2 7.7-7.7-1.1-1.1 1.9-1.9 1.1 1.1 3.1-3.1a2 2 0 0 1 2.8 0ZM6.4 17.5l-.3 1.4 1.4-.3 7-7-1.1-1.1Z" /></svg></button><span className="illustration-current-color" style={{ backgroundColor: props.color }} /><input type="range" min="0" max="359" value={Math.round(hsv.h)} onChange={(event) => setHsv(Number(event.target.value), hsv.s, hsv.v)} aria-label="色相" /></div>
        <div className="illustration-color-presets">{props.colorPresets.slice(0, 10).map((preset) => <button key={preset} className={preset.toLowerCase() === props.color.toLowerCase() ? 'active' : ''} style={{ backgroundColor: preset }} onClick={() => props.onColorChange(preset)} aria-label="プリセット色" />)}</div>
        <button className="register-current-color" onClick={props.onRegisterColor}>現在の色を登録</button>
      </section>}

      <section className="illustration-quick-section illustration-adjustments"><h3>線</h3>
        <label><span>太さ</span><input type="range" min="0.1" max="48" step="0.1" value={props.width} onChange={(event) => props.onWidthChange(Number(event.target.value))} /><span className="number-with-unit"><input type="number" min="0.1" max="48" step="0.1" value={props.width} onChange={(event) => props.onWidthChange(clamp(Number(event.target.value), 0.1, 48))} />px</span></label>
        <label className="zoom-width-toggle"><input type="checkbox" checked={props.zoomCompensatedInputWidth} onChange={(event) => props.onZoomCompensatedInputWidthChange(event.target.checked)} /><span>ズーム時も指定幅で描画</span></label>
        {props.tool !== 'eraser' && <label><span>透明度</span><input type="range" min="5" max="100" step="1" value={Math.round(props.opacity * 100)} onChange={(event) => props.onOpacityChange(Number(event.target.value) / 100)} /><span className="number-with-unit"><input type="number" min="5" max="100" step="1" value={Math.round(props.opacity * 100)} onChange={(event) => props.onOpacityChange(clamp(Number(event.target.value), 5, 100) / 100)} />%</span></label>}
      </section>
    </div>}
  </aside>;
}
