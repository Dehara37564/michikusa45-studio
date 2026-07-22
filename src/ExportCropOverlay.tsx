import React, { useRef, useState } from 'react';

export type CropRect = { x: number; y: number; width: number; height: number };
export type ExportCropRequest = CropRect & { outputWidth: number; outputHeight: number };
type Props = { canvasWidth: number; canvasHeight: number; onCancel: () => void; onExport: (crop: ExportCropRequest) => void; onPanCanvas: (dx: number, dy: number) => void };
type DragMode = 'pan' | 'n' | 'e' | 's' | 'w' | 'nw' | 'ne' | 'sw' | 'se';
const MIN_SIZE = 32;
const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));

export function ExportCropOverlay({ canvasWidth, canvasHeight, onCancel, onExport, onPanCanvas }: Props): React.JSX.Element {
  const [crop, setCrop] = useState<CropRect>(() => {
    let width = canvasWidth * .8; let height = width * 9 / 16;
    if (height > canvasHeight * .8) { height = canvasHeight * .8; width = height * 16 / 9; }
    return { x: Math.round((canvasWidth - width) / 2), y: Math.round((canvasHeight - height) / 2), width: Math.round(width), height: Math.round(height) };
  });
  const [outputSize, setOutputSize] = useState({ width: 1920, height: 1080 });
  const dragRef = useRef<{ mode: DragMode; pointerX: number; pointerY: number; origin: CropRect; originOutput: { width: number; height: number } } | undefined>(undefined);
  const normalize = (next: CropRect): CropRect => ({ x: clamp(Math.round(next.x), 0, Math.max(0, canvasWidth - MIN_SIZE)), y: clamp(Math.round(next.y), 0, Math.max(0, canvasHeight - MIN_SIZE)), width: clamp(Math.round(next.width), MIN_SIZE, canvasWidth - clamp(Math.round(next.x), 0, canvasWidth - MIN_SIZE)), height: clamp(Math.round(next.height), MIN_SIZE, canvasHeight - clamp(Math.round(next.y), 0, canvasHeight - MIN_SIZE)) });
  const startDrag = (mode: DragMode, event: React.PointerEvent<HTMLElement>) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); dragRef.current = { mode, pointerX: event.clientX, pointerY: event.clientY, origin: crop, originOutput: outputSize }; };
  const drag = (event: React.PointerEvent<HTMLElement>) => {
    const state = dragRef.current; if (!state) return; const dx = event.clientX - state.pointerX; const dy = event.clientY - state.pointerY; const origin = state.origin;
    if (state.mode === 'pan') {
      onPanCanvas(dx, dy);
      dragRef.current = { ...state, pointerX: event.clientX, pointerY: event.clientY };
    }
    else {
      const left = state.mode.endsWith('w') ? clamp(origin.x + dx, 0, origin.x + origin.width - MIN_SIZE) : origin.x;
      const top = state.mode.startsWith('n') ? clamp(origin.y + dy, 0, origin.y + origin.height - MIN_SIZE) : origin.y;
      const right = state.mode.endsWith('e') ? clamp(origin.x + origin.width + dx, origin.x + MIN_SIZE, canvasWidth) : origin.x + origin.width;
      const bottom = state.mode.startsWith('s') ? clamp(origin.y + origin.height + dy, origin.y + MIN_SIZE, canvasHeight) : origin.y + origin.height;
      const next = { x: left, y: top, width: right - left, height: bottom - top };
      setCrop(next);
      setOutputSize({
        width: clamp(Math.round(state.originOutput.width * next.width / origin.width), 32, 16384),
        height: clamp(Math.round(state.originOutput.height * next.height / origin.height), 32, 16384),
      });
    }
  };
  const stopDrag = () => {
    dragRef.current = undefined;
  };
  const updateOutputSize = (width: number, height: number) => {
    const safeWidth = clamp(Math.round(width), 32, 16384); const safeHeight = clamp(Math.round(height), 32, 16384);
    setOutputSize({ width: safeWidth, height: safeHeight });
    const aspect = safeWidth / safeHeight;
    setCrop((current) => {
      let nextWidth = current.width;
      let nextHeight = nextWidth / aspect;
      if (nextHeight > canvasHeight) { nextHeight = canvasHeight; nextWidth = nextHeight * aspect; }
      if (nextWidth > canvasWidth) { nextWidth = canvasWidth; nextHeight = nextWidth / aspect; }
      return normalize({
        x: (canvasWidth - nextWidth) / 2,
        y: (canvasHeight - nextHeight) / 2,
        width: nextWidth,
        height: nextHeight,
      });
    });
  };

  return <div className="export-crop-overlay">
    <div className="export-crop-controls">
      <div className="export-resolution-controls">
        <button onClick={() => updateOutputSize(1920, 1080)}>FHD</button>
        <button onClick={() => updateOutputSize(3840, 2160)}>4K</button>
        <label><span>出力幅</span><input type="number" min="32" max="16384" value={outputSize.width} onChange={(event) => updateOutputSize(Number(event.target.value), outputSize.height)} /><small>px</small></label>
        <label><span>出力高さ</span><input type="number" min="32" max="16384" value={outputSize.height} onChange={(event) => updateOutputSize(outputSize.width, Number(event.target.value))} /><small>px</small></label>
      </div>
      <button onClick={onCancel}>キャンセル</button><button className="primary" onClick={() => onExport({ ...crop, outputWidth: outputSize.width, outputHeight: outputSize.height })}>PNG保存</button>
    </div>
    <div className="export-crop-selection" style={{ left: crop.x, top: crop.y, width: crop.width, height: crop.height }} onPointerDown={(event) => startDrag('pan', event)} onPointerMove={drag} onPointerUp={stopDrag} onPointerCancel={stopDrag}>
      {(['n', 'e', 's', 'w', 'nw', 'ne', 'sw', 'se'] as const).map((mode) => <i key={mode} className={`crop-handle crop-${mode}`} onPointerDown={(event) => { event.stopPropagation(); startDrag(mode, event); }} onPointerMove={drag} onPointerUp={stopDrag} onPointerCancel={stopDrag} />)}
    </div>
  </div>;
}
