import React, { useEffect, useRef, useState } from 'react';
import {
  DEFAULT_CANVAS_BACKGROUND_COLOR,
  DEFAULT_CANVAS_BACKGROUND_PATTERN,
  DEFAULT_CANVAS_BACKGROUND_SPACING,
  type Camera,
  type CanvasBackgroundColor,
  type CanvasBackgroundPattern,
  type LayerDefinition,
  type ImportedCanvasImage,
  type PlacedStamp,
  type Point,
  type ProjectFile,
  type ReviewData,
  type StampDefinition,
  type Stroke,
  type Tool,
} from '../shared/project';
import {
  RecordingManager,
  type RecordingQuality,
  type RecordingSettings,
  type RecordingState,
} from '../recording/RecordingManager';
import { createDefaultReviewData } from '../shared/migration';
import { ReviewPanel } from '../review/ReviewPanel';
import { calculateMichikusa, calculateMichikusaScore, calculatePercentages } from '../review/analysis';
import { LayerPanel } from '../layers/LayerPanel';
import { IllustrationToolbox } from '../IllustrationToolbox';
import { ExportCropOverlay, type ExportCropRequest } from '../ExportCropOverlay';
import { BRUSH_DEFINITIONS, getBrushDefinition, type BrushKind } from '../shared/brushes';

const MIN_ZOOM = 0.15;
const MAX_ZOOM = 8;
const DEFAULT_WIDTH = 3;
const DEFAULT_COLOR = '#202124';
const DEFAULT_BRUSH: BrushKind = 'pen';
const DEFAULT_OPACITY = 1;
type DrawingSettingKey = BrushKind | 'eraser';
type DrawingSetting = { width: number; opacity: number; color: string };
const createDefaultDrawingSettings = (): Record<DrawingSettingKey, DrawingSetting> => ({
  pen: { width: DEFAULT_WIDTH, opacity: 1, color: DEFAULT_COLOR },
  pencil: { width: 3, opacity: 0.8, color: DEFAULT_COLOR },
  marker: { width: 12, opacity: 0.5, color: '#F4C542' },
  brush: { width: 8, opacity: 1, color: DEFAULT_COLOR },
  eraser: { width: 24, opacity: 1, color: DEFAULT_COLOR },
});
const MIN_POINT_DISTANCE_SCREEN = 0.45;
const SMOOTHING_DISTANCE_SCREEN = 18;
const DEFAULT_LAYER_ID = 'layer-1';
const DEFAULT_STAMP_SIZE = 50;
const DEFAULT_BACKGROUND_COLOR = DEFAULT_CANVAS_BACKGROUND_COLOR;
const DEFAULT_BACKGROUND_PATTERN = DEFAULT_CANVAS_BACKGROUND_PATTERN;
const DEFAULT_BACKGROUND_SPACING = DEFAULT_CANVAS_BACKGROUND_SPACING;
const ZOOM_COMPENSATED_WIDTH_STORAGE_KEY = 'zoom-compensated-input-width';
const loadZoomCompensatedInputWidth = (): boolean => {
  try { return localStorage.getItem(ZOOM_COMPENSATED_WIDTH_STORAGE_KEY) === 'true'; } catch { return false; }
};
const MIN_BACKGROUND_SPACING = 8;
const MAX_BACKGROUND_SPACING = 96;
const WRAP_NOTE_INSET = 44;
const WRAP_NOTE_TOP = 414;
const WRAP_NOTE_BOTTOM = 32;

const createDefaultLayers = (): LayerDefinition[] => [
  { id: DEFAULT_LAYER_ID, name: 'レイヤー1', visible: true, order: 0 },
];

type RecordingUiSettings = RecordingSettings & {
  showDuration: boolean;
  showAudioMeter: boolean;
};

type WrapNoteStroke = { points: Array<{ x: number; y: number }>; color: string; width: number };
type EditableSelection = { kind: 'stroke' | 'image'; id: string };
type EditableSnapshot = { strokes: Array<{ id: string; baseWidth: number; points: Point[] }>; images: Array<{ id: string; x: number; y: number; width: number; height: number }> };

const WORKSPACE_MODES = [
  { id: 'create', label: '思考' },
  { id: 'review', label: '分析' },
  { id: 'illustration', label: 'イラスト' },
] as const;

type WorkspaceMode = (typeof WORKSPACE_MODES)[number]['id'];

const DEFAULT_RECORDING_SETTINGS: RecordingUiSettings = {
  microphoneEnabled: true,
  audioDeviceId: '',
  quality: '1080p',
  videoBitsPerSecond: 8_000_000,
  fps: 30,
  showDuration: true,
  showAudioMeter: true,
};

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const hexToRgb = (hex: string): { r: number; g: number; b: number } => {
  const value = Number.parseInt(hex.slice(1), 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
};

const rgbToHex = (r: number, g: number, b: number): string =>
  `#${[r, g, b].map((value) => Math.round(value).toString(16).padStart(2, '0')).join('')}`;

const rgbToHsv = (r: number, g: number, b: number): { h: number; s: number; v: number } => {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const delta = maximum - minimum;
  let hue = 0;
  if (delta > 0) {
    if (maximum === red) hue = 60 * (((green - blue) / delta) % 6);
    else if (maximum === green) hue = 60 * ((blue - red) / delta + 2);
    else hue = 60 * ((red - green) / delta + 4);
  }
  return {
    h: hue < 0 ? hue + 360 : hue,
    s: maximum === 0 ? 0 : delta / maximum,
    v: maximum,
  };
};

const hsvToRgb = (h: number, s: number, v: number): { r: number; g: number; b: number } => {
  const chroma = v * s;
  const section = h / 60;
  const secondary = chroma * (1 - Math.abs((section % 2) - 1));
  const [red, green, blue] = section < 1 ? [chroma, secondary, 0]
    : section < 2 ? [secondary, chroma, 0]
      : section < 3 ? [0, chroma, secondary]
        : section < 4 ? [0, secondary, chroma]
          : section < 5 ? [secondary, 0, chroma]
            : [chroma, 0, secondary];
  const match = v - chroma;
  return { r: (red + match) * 255, g: (green + match) * 255, b: (blue + match) * 255 };
};

const makeId = (): string =>
  `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const makeSeekableWebm = async (blob: Blob): Promise<Blob> => {
  const originalBuffer = await blob.arrayBuffer();
  const ebml = window.EBML;
  if (!ebml) {
    throw new Error('WebM処理ライブラリを読み込めませんでした。');
  }

  const decoder = new ebml.Decoder();
  const reader = new ebml.Reader();

  reader.logging = false;
  reader.drop_default_duration = false;

  const elements = decoder.decode(originalBuffer);
  for (const element of elements) {
    reader.read(element);
  }
  reader.stop();

  if (
    reader.metadataSize <= 0 ||
    reader.metadataSize >= originalBuffer.byteLength ||
    reader.duration <= 0
  ) {
    throw new Error('WebMの時間情報を解析できませんでした。');
  }

  const refinedMetadata = ebml.tools.makeMetadataSeekable(
    reader.metadatas,
    reader.duration,
    reader.cues,
  );
  const mediaBody = originalBuffer.slice(reader.metadataSize);

  return new Blob([refinedMetadata, mediaBody], {
    type: blob.type || 'video/webm',
  });
};

const cloneStrokes = (strokes: Stroke[]): Stroke[] =>
  strokes.map((stroke) => ({
    ...stroke,
    points: stroke.points.map((point) => ({ ...point })),
  }));

const smoothIncomingPoint = (
  previous: Point,
  incoming: Point,
  zoom: number,
): Point => {
  const dx = incoming.x - previous.x;
  const dy = incoming.y - previous.y;
  const distanceScreen = Math.hypot(dx, dy) * zoom;

  // Slow movement is filtered more strongly, while fast strokes remain responsive.
  const positionBlend = clamp(
    distanceScreen / SMOOTHING_DISTANCE_SCREEN,
    0.2,
    0.82,
  );
  const pressureBlend = clamp(positionBlend * 0.75, 0.16, 0.62);

  return {
    x: previous.x + dx * positionBlend,
    y: previous.y + dy * positionBlend,
    pressure:
      previous.pressure +
      (incoming.pressure - previous.pressure) * pressureBlend,
  };
};

const midpoint = (first: Point, second: Point): Point => ({
  x: (first.x + second.x) / 2,
  y: (first.y + second.y) / 2,
  pressure: (first.pressure + second.pressure) / 2,
});

const drawStrokePath = (context: CanvasRenderingContext2D, stroke: Stroke, widthScale = 1): void => {
  if (stroke.points.length < 2) return;
  context.save();
  context.strokeStyle = stroke.color;
  const brushDefinition = getBrushDefinition(stroke.brush);
  context.globalAlpha = clamp((stroke.opacity ?? 1) * brushDefinition.opacityMultiplier, 0.02, 1);
  context.lineCap = stroke.brush === 'marker' ? 'butt' : 'round';
  context.lineJoin = stroke.brush === 'marker' ? 'bevel' : 'round';
  const points = stroke.points;
  const widthAt = (pressure: number, progress: number, segmentIndex: number): number => {
    const pressureFactor = stroke.brush === 'marker' ? 1 : Math.max(0.15, pressure);
    const shapeFactor = stroke.brush === 'brush'
      ? 0.18 + 0.82 * Math.pow(Math.sin(Math.PI * clamp(progress, 0.02, 0.98)), 0.35)
      : stroke.brush === 'pencil' ? 0.82 + 0.18 * Math.sin(segmentIndex * 2.17) : 1;
    return stroke.baseWidth * brushDefinition.widthMultiplier * widthScale * pressureFactor * shapeFactor;
  };
  if (points.length === 2) {
    context.lineWidth = widthAt((points[0].pressure + points[1].pressure) / 2, .5, 0);
    context.beginPath();
    context.moveTo(points[0].x, points[0].y);
    context.lineTo(points[1].x, points[1].y);
    context.stroke();
    context.restore();
    return;
  }
  if (stroke.brush !== 'brush') {
    const averagePressure = points.reduce((sum, point) => sum + point.pressure, 0) / points.length;
    context.lineWidth = widthAt(averagePressure, .5, 0);
    context.beginPath();
    context.moveTo(points[0].x, points[0].y);
    for (let index = 1; index < points.length - 1; index += 1) {
      const control = points[index];
      const end = midpoint(control, points[index + 1]);
      context.quadraticCurveTo(control.x, control.y, end.x, end.y);
    }
    const beforeLast = points[points.length - 2];
    const last = points[points.length - 1];
    context.quadraticCurveTo(beforeLast.x, beforeLast.y, last.x, last.y);
    context.stroke();
    context.restore();
    return;
  }
  let segmentStart = points[0];
  for (let index = 1; index < points.length - 1; index += 1) {
    const control = points[index];
    const segmentEnd = midpoint(control, points[index + 1]);
    context.lineWidth = widthAt((segmentStart.pressure + control.pressure + segmentEnd.pressure) / 3, index / (points.length - 1), index);
    context.beginPath();
    context.moveTo(segmentStart.x, segmentStart.y);
    context.quadraticCurveTo(control.x, control.y, segmentEnd.x, segmentEnd.y);
    context.stroke();
    segmentStart = segmentEnd;
  }
  const last = points[points.length - 1];
  const beforeLast = points[points.length - 2];
  context.lineWidth = widthAt((beforeLast.pressure + last.pressure) / 2, 1, points.length - 1);
  context.beginPath();
  context.moveTo(segmentStart.x, segmentStart.y);
  context.quadraticCurveTo(beforeLast.x, beforeLast.y, last.x, last.y);
  context.stroke();
  context.restore();
};

const distancePointToSegment = (
  point: Point,
  start: Point,
  end: Point,
): number => {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared === 0) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }

  const t = Math.max(
    0,
    Math.min(
      1,
      ((point.x - start.x) * dx + (point.y - start.y) * dy) /
        lengthSquared,
    ),
  );

  const projectionX = start.x + t * dx;
  const projectionY = start.y + t * dy;
  return Math.hypot(point.x - projectionX, point.y - projectionY);
};

export function Whiteboard(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const redoRef = useRef<Stroke[]>([]);
  const activeStrokeRef = useRef<Stroke | null>(null);
  const cameraRef = useRef<Camera>({ x: 0, y: 0, zoom: 1 });
  const backgroundColorRef = useRef<CanvasBackgroundColor>(DEFAULT_BACKGROUND_COLOR);
  const backgroundPatternRef = useRef<CanvasBackgroundPattern>(DEFAULT_BACKGROUND_PATTERN);
  const backgroundSpacingRef = useRef(DEFAULT_BACKGROUND_SPACING);
  const isSpaceDownRef = useRef(false);
  const isPanningRef = useRef(false);
  const isErasingRef = useRef(false);
  const lastScreenPointRef = useRef<{ x: number; y: number } | null>(null);
  const zoomAnchorRef = useRef<{ x: number; y: number } | null>(null);
  const isPointerOverCanvasRef = useRef(false);
  const createdAtRef = useRef(new Date().toISOString());
  const recordingManagerRef = useRef<RecordingManager | null>(null);
  const recordingSceneVersionRef = useRef(0);
  const lastRenderedRecordingVersionRef = useRef(-1);
  const recordingStateRef = useRef<RecordingState>('idle');
  const recordingElapsedRef = useRef(0);
  const reviewRef = useRef<ReviewData>(createDefaultReviewData());
  const michikusaScoreCacheRef = useRef<{ review: ReviewData; score: number } | undefined>(undefined);
  const reviewUndoRef = useRef<ReviewData[]>([]);
  const reviewRedoRef = useRef<ReviewData[]>([]);
  const workspaceModeRef = useRef<WorkspaceMode>('create');
  const placementDefinitionRef = useRef<string | undefined>(undefined);
  const selectedStampRef = useRef<string | undefined>(undefined);
  const draggingStampRef = useRef<string | undefined>(undefined);
  const selectedEditablesRef = useRef<EditableSelection[]>([]);
  const editableGestureRef = useRef<{ mode: 'move' | 'scale' | 'marquee'; start: Point; snapshot?: EditableSnapshot; bounds?: { x: number; y: number; width: number; height: number } } | undefined>(undefined);
  const marqueeRectRef = useRef<{ x: number; y: number; width: number; height: number } | undefined>(undefined);
  const selectionModeRef = useRef<'transform' | 'marquee'>('transform');
  const layersRef = useRef<LayerDefinition[]>(createDefaultLayers());
  const importedImagesRef = useRef<ImportedCanvasImage[]>([]);
  const imageElementCacheRef = useRef(new Map<string, HTMLImageElement>());
  const activeLayerIdRef = useRef(DEFAULT_LAYER_ID);
  const showReviewSummaryRef = useRef(false);
  const showWrapSummaryRef = useRef(false);
  const wrapNoteStrokesRef = useRef<WrapNoteStroke[]>([]);
  const activeWrapNoteStrokeRef = useRef<WrapNoteStroke | undefined>(undefined);
  const reviewSummaryPositionRef = useRef({ x: 0, y: 0 });
  const reviewSummaryDragRef = useRef<{ pointerX: number; pointerY: number; originX: number; originY: number } | undefined>(undefined);

  const toolRef = useRef<Tool>('pen');
  const colorRef = useRef(DEFAULT_COLOR);
  const widthRef = useRef(DEFAULT_WIDTH);
  const brushRef = useRef<BrushKind>(DEFAULT_BRUSH);
  const opacityRef = useRef(DEFAULT_OPACITY);
  const zoomCompensatedInputWidthRef = useRef(loadZoomCompensatedInputWidth());
  const drawingSettingsRef = useRef<Record<DrawingSettingKey, DrawingSetting>>(createDefaultDrawingSettings());
  const activeDrawingSettingKeyRef = useRef<DrawingSettingKey>('pen');
  const eyedropperTargetRef = useRef<{ kind: 'pen' } | { kind: 'stamp'; definitionId: string } | undefined>(undefined);

  const [tool, setTool] = useState<Tool>('pen');
  const [selectionMode, setSelectionMode] = useState<'transform' | 'marquee'>('transform');
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [lineWidth, setLineWidth] = useState(DEFAULT_WIDTH);
  const [brush, setBrush] = useState<BrushKind>(DEFAULT_BRUSH);
  const [strokeOpacity, setStrokeOpacity] = useState(DEFAULT_OPACITY);
  const [zoomCompensatedInputWidth, setZoomCompensatedInputWidth] = useState(() => zoomCompensatedInputWidthRef.current);
  const [isEyedropping, setIsEyedropping] = useState(false);
  const [showImageExport, setShowImageExport] = useState(false);
  const [backgroundColor, setBackgroundColor] = useState<CanvasBackgroundColor>(DEFAULT_BACKGROUND_COLOR);
  const [backgroundPattern, setBackgroundPattern] = useState<CanvasBackgroundPattern>(DEFAULT_BACKGROUND_PATTERN);
  const [backgroundSpacing, setBackgroundSpacing] = useState(DEFAULT_BACKGROUND_SPACING);
  const [isSpaceDown, setIsSpaceDown] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [zoomLabel, setZoomLabel] = useState('100%');
  const [currentPath, setCurrentPath] = useState<string | undefined>();
  const [isDirty, setIsDirty] = useState(false);
  const [historyTick, setHistoryTick] = useState(0);
  const [statusMessage, setStatusMessage] = useState('準備完了');
  const [recordingState, setRecordingState] =
    useState<RecordingState>('idle');
  const [recordingElapsed, setRecordingElapsed] = useState(0);
  const [recordingSettings, setRecordingSettings] =
    useState<RecordingUiSettings>(() => {
      try {
        const saved = localStorage.getItem('recording-settings');
        return saved
          ? { ...DEFAULT_RECORDING_SETTINGS, ...JSON.parse(saved) }
          : DEFAULT_RECORDING_SETTINGS;
      } catch {
        return DEFAULT_RECORDING_SETTINGS;
      }
    });
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [audioLevel, setAudioLevel] = useState(0);
  const [showRecordingSettings, setShowRecordingSettings] = useState(false);
  const [showReviewSummary, setShowReviewSummary] = useState(false);
  const [showWrapSummary, setShowWrapSummary] = useState(false);
  const [reviewSummaryPosition, setReviewSummaryPosition] = useState({ x: 0, y: 0 });
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>('create');
  const [review, setReview] = useState<ReviewData>(createDefaultReviewData);
  const [placementDefinitionId, setPlacementDefinitionId] = useState<string>();
  const [selectedStampId, setSelectedStampId] = useState<string>();
  const [toolbarStampDefinitionId, setToolbarStampDefinitionId] = useState('theme');
  const [layers, setLayers] = useState<LayerDefinition[]>(createDefaultLayers);
  const [activeLayerId, setActiveLayerId] = useState(DEFAULT_LAYER_ID);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [fileMenuPage, setFileMenuPage] = useState<'root' | 'settings' | 'pen'>('root');
  const [colorPresets, setColorPresets] = useState<string[]>([]);
  const [widthPresets, setWidthPresets] = useState<number[]>([]);

  const refreshMenuPresets = async (): Promise<void> => {
    const presets = await window.michikusa.getMenuPresets();
    setColorPresets(presets.colors);
    setWidthPresets(presets.widths);
  };

  useEffect(() => {
    void refreshMenuPresets();
  }, []);

  useEffect(() => { reviewRef.current = review; }, [review]);
  useEffect(() => { workspaceModeRef.current = workspaceMode; }, [workspaceMode]);
  useEffect(() => { placementDefinitionRef.current = placementDefinitionId; }, [placementDefinitionId]);
  useEffect(() => { selectedStampRef.current = selectedStampId; }, [selectedStampId]);
  useEffect(() => { layersRef.current = layers; }, [layers]);
  useEffect(() => { activeLayerIdRef.current = activeLayerId; }, [activeLayerId]);
  useEffect(() => { recordingStateRef.current = recordingState; }, [recordingState]);
  useEffect(() => { recordingElapsedRef.current = recordingElapsed; }, [recordingElapsed]);

  useEffect(() => {
    if (openMenu !== 'color-picker' && openMenu !== 'stamp-color-picker') return;
    const closeColorPickerOutside = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Element && target.closest('.color-picker-control')) return;
      setOpenMenu(null);
    };
    document.addEventListener('pointerdown', closeColorPickerOutside);
    return () => document.removeEventListener('pointerdown', closeColorPickerOutside);
  }, [openMenu]);

  const refreshAudioDevices = async (): Promise<void> => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    setAudioDevices(devices.filter((device) => device.kind === 'audioinput'));
  };

  useEffect(() => {
    localStorage.setItem(
      'recording-settings',
      JSON.stringify(recordingSettings),
    );
  }, [recordingSettings]);

  useEffect(() => {
    void refreshAudioDevices();
    navigator.mediaDevices.addEventListener('devicechange', refreshAudioDevices);
    return () => {
      navigator.mediaDevices.removeEventListener(
        'devicechange',
        refreshAudioDevices,
      );
    };
  }, []);

  const requestHistoryRefresh = (): void => {
    setHistoryTick((value) => value + 1);
  };

  const markDirty = (): void => {
    setIsDirty(true);
  };

  const changeZoomCompensatedInputWidth = (enabled: boolean): void => {
    zoomCompensatedInputWidthRef.current = enabled;
    setZoomCompensatedInputWidth(enabled);
    localStorage.setItem(ZOOM_COMPENSATED_WIDTH_STORAGE_KEY, String(enabled));
    markDirty();
  };

  const loadCanvasImage = (item: ImportedCanvasImage): Promise<HTMLImageElement> => {
    const cached = imageElementCacheRef.current.get(item.id);
    if (cached?.complete) return Promise.resolve(cached);
    return new Promise((resolve, reject) => {
      const image = cached ?? new Image();
      imageElementCacheRef.current.set(item.id, image);
      image.onload = () => { window.dispatchEvent(new CustomEvent('michikusa-redraw')); resolve(image); };
      image.onerror = () => reject(new Error(`画像を読み込めませんでした: ${item.name}`));
      if (!cached) image.src = item.dataUrl;
    });
  };

  const drawImportedImages = (context: CanvasRenderingContext2D): void => {
    const visibleLayerIds = new Set(layersRef.current.filter((layer) => layer.visible !== false).map((layer) => layer.id));
    importedImagesRef.current.forEach((item) => {
      if (!visibleLayerIds.has(item.layerId ?? DEFAULT_LAYER_ID)) return;
      const image = imageElementCacheRef.current.get(item.id);
      if (image?.complete && image.naturalWidth > 0) context.drawImage(image, item.x, item.y, item.width, item.height);
    });
  };

  const getEditableBounds = (selection = selectedEditablesRef.current): { x: number; y: number; width: number; height: number } | undefined => {
    const rectangles: Array<{ left: number; top: number; right: number; bottom: number }> = [];
    selection.forEach((selected) => {
      if (selected.kind === 'image') {
        const image = importedImagesRef.current.find((item) => item.id === selected.id);
        if (image) rectangles.push({ left: image.x, top: image.y, right: image.x + image.width, bottom: image.y + image.height });
      } else {
        const stroke = strokesRef.current.find((item) => item.id === selected.id);
        if (stroke?.points.length) {
          const xs = stroke.points.map((point) => point.x); const ys = stroke.points.map((point) => point.y); const inset = stroke.baseWidth / 2;
          rectangles.push({ left: Math.min(...xs) - inset, top: Math.min(...ys) - inset, right: Math.max(...xs) + inset, bottom: Math.max(...ys) + inset });
        }
      }
    });
    if (!rectangles.length) return undefined;
    const left = Math.min(...rectangles.map((item) => item.left)); const top = Math.min(...rectangles.map((item) => item.top));
    const right = Math.max(...rectangles.map((item) => item.right)); const bottom = Math.max(...rectangles.map((item) => item.bottom));
    return { x: left, y: top, width: right - left, height: bottom - top };
  };

  const snapshotEditableSelection = (): EditableSnapshot => ({
    strokes: selectedEditablesRef.current.flatMap((selected) => selected.kind === 'stroke' ? strokesRef.current.filter((stroke) => stroke.id === selected.id).map((stroke) => ({ id: stroke.id, baseWidth: stroke.baseWidth, points: stroke.points.map((point) => ({ ...point })) })) : []),
    images: selectedEditablesRef.current.flatMap((selected) => selected.kind === 'image' ? importedImagesRef.current.filter((image) => image.id === selected.id).map((image) => ({ id: image.id, x: image.x, y: image.y, width: image.width, height: image.height })) : []),
  });

  useEffect(() => {
    toolRef.current = tool;
  }, [tool]);

  useEffect(() => {
    colorRef.current = color;
    const current = drawingSettingsRef.current[activeDrawingSettingKeyRef.current];
    drawingSettingsRef.current[activeDrawingSettingKeyRef.current] = { ...current, color };
  }, [color]);

  useEffect(() => {
    widthRef.current = lineWidth;
  }, [lineWidth]);

  useEffect(() => { brushRef.current = brush; }, [brush]);
  useEffect(() => {
    opacityRef.current = strokeOpacity;
    drawingSettingsRef.current[activeDrawingSettingKeyRef.current] = { width: widthRef.current, opacity: strokeOpacity, color: colorRef.current };
  }, [strokeOpacity]);
  useEffect(() => {
    drawingSettingsRef.current[activeDrawingSettingKeyRef.current] = { width: lineWidth, opacity: opacityRef.current, color: colorRef.current };
  }, [lineWidth]);

  useEffect(() => {
    if (tool === 'select') return;
    const previousKey = activeDrawingSettingKeyRef.current;
    drawingSettingsRef.current[previousKey] = { width: widthRef.current, opacity: opacityRef.current, color: colorRef.current };
    const nextKey: DrawingSettingKey = tool === 'eraser' ? 'eraser' : brush;
    activeDrawingSettingKeyRef.current = nextKey;
    const next = drawingSettingsRef.current[nextKey];
    widthRef.current = next.width;
    opacityRef.current = next.opacity;
    colorRef.current = next.color;
    setLineWidth(next.width);
    setStrokeOpacity(next.opacity);
    setColor(next.color);
  }, [tool, brush]);

  const buildProject = (): ProjectFile => {
    const now = new Date().toISOString();
    return {
      format: 'm45',
      version: 2,
      createdAt: createdAtRef.current,
      updatedAt: now,
      canvas: {
        background: backgroundPatternRef.current,
        backgroundColor: backgroundColorRef.current,
        backgroundSpacing: backgroundSpacingRef.current,
        strokes: cloneStrokes(strokesRef.current),
        layers,
        activeLayerId,
        importedImages: structuredClone(importedImagesRef.current),
      },
      camera: { ...cameraRef.current },
      settings: {
        selectedColor: colorRef.current,
        selectedWidth: widthRef.current,
        selectedBrush: brushRef.current,
        selectedOpacity: opacityRef.current,
        zoomCompensatedInputWidth: zoomCompensatedInputWidthRef.current,
        drawingSettings: structuredClone(drawingSettingsRef.current),
      },
      review,
    };
  };

  const confirmDiscard = (): boolean => {
    if (!isDirty) return true;
    return window.confirm(
      '保存されていない変更があります。破棄して続けますか？',
    );
  };

  const save = async (saveAs = false): Promise<void> => {
    try {
      const result = await window.michikusa.saveProject(
        buildProject(),
        currentPath,
        saveAs,
      );

      if (result.canceled) return;

      setCurrentPath(result.filePath);
      setIsDirty(false);
      setStatusMessage(`保存しました: ${result.filePath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      window.alert(`保存に失敗しました。\n${message}`);
    }
  };

  const openProject = async (): Promise<void> => {
    if (!confirmDiscard()) return;

    try {
      const result = await window.michikusa.openProject();
      if (result.canceled) return;

      const project = result.project;
      const openedLayers = project.canvas.layers?.length ? project.canvas.layers : createDefaultLayers();
      const openedLayerIds = new Set(openedLayers.map((layer) => layer.id));
      const openedActiveLayerId = project.canvas.activeLayerId && openedLayerIds.has(project.canvas.activeLayerId) ? project.canvas.activeLayerId : openedLayers[0].id;
      strokesRef.current = cloneStrokes(project.canvas.strokes).map((stroke) => ({ ...stroke, layerId: stroke.layerId && openedLayerIds.has(stroke.layerId) ? stroke.layerId : openedLayers[0].id }));
      importedImagesRef.current = structuredClone(project.canvas.importedImages ?? []).map((item) => ({ ...item, layerId: item.layerId && openedLayerIds.has(item.layerId) ? item.layerId : openedLayers[0].id }));
      imageElementCacheRef.current.clear();
      importedImagesRef.current.forEach((item) => { void loadCanvasImage(item); });
      redoRef.current = [];
      activeStrokeRef.current = null;
      selectedEditablesRef.current = [];
      cameraRef.current = { ...project.camera };
      const openedBackgroundColor = project.canvas.backgroundColor ?? DEFAULT_BACKGROUND_COLOR;
      const openedBackgroundPattern = project.canvas.background ?? DEFAULT_BACKGROUND_PATTERN;
      const openedBackgroundSpacing = clamp(project.canvas.backgroundSpacing ?? DEFAULT_BACKGROUND_SPACING, MIN_BACKGROUND_SPACING, MAX_BACKGROUND_SPACING);
      backgroundColorRef.current = openedBackgroundColor;
      backgroundPatternRef.current = openedBackgroundPattern;
      backgroundSpacingRef.current = openedBackgroundSpacing;
      setBackgroundColor(openedBackgroundColor);
      setBackgroundPattern(openedBackgroundPattern);
      setBackgroundSpacing(openedBackgroundSpacing);
      createdAtRef.current = project.createdAt;

      const openedBrush = project.settings.selectedBrush ?? DEFAULT_BRUSH;
      const openedOpacity = clamp(project.settings.selectedOpacity ?? DEFAULT_OPACITY, 0.05, 1);
      const openedZoomCompensatedInputWidth = project.settings.zoomCompensatedInputWidth ?? loadZoomCompensatedInputWidth();
      zoomCompensatedInputWidthRef.current = openedZoomCompensatedInputWidth;
      setZoomCompensatedInputWidth(openedZoomCompensatedInputWidth);
      localStorage.setItem(ZOOM_COMPENSATED_WIDTH_STORAGE_KEY, String(openedZoomCompensatedInputWidth));
      const defaultDrawingSettings = createDefaultDrawingSettings();
      const savedDrawingSettings = project.settings.drawingSettings;
      drawingSettingsRef.current = Object.fromEntries(Object.entries(defaultDrawingSettings).map(([key, defaults]) => [key, { ...defaults, ...(savedDrawingSettings?.[key as DrawingSettingKey] ?? {}) }])) as Record<DrawingSettingKey, DrawingSetting>;
      if (!savedDrawingSettings) drawingSettingsRef.current[openedBrush] = { width: project.settings.selectedWidth, opacity: openedOpacity, color: project.settings.selectedColor };
      activeDrawingSettingKeyRef.current = openedBrush;
      const openedDrawingSetting = drawingSettingsRef.current[openedBrush];
      brushRef.current = openedBrush;
      widthRef.current = openedDrawingSetting.width;
      opacityRef.current = openedDrawingSetting.opacity;
      colorRef.current = openedDrawingSetting.color;
      setBrush(openedBrush);
      setLineWidth(openedDrawingSetting.width);
      setStrokeOpacity(openedDrawingSetting.opacity);
      setColor(openedDrawingSetting.color);
      setZoomLabel(`${Math.round(project.camera.zoom * 100)}%`);
      setCurrentPath(result.filePath);
      setIsDirty(false);
      setReview(project.review);
      reviewRef.current = project.review;
      reviewUndoRef.current = [];
      reviewRedoRef.current = [];
      setPlacementDefinitionId(undefined);
      setSelectedStampId(undefined);
      setToolbarStampDefinitionId(project.review.stampDefinitions.find((definition) => definition.kind === 'theme')?.id ?? 'theme');
      setLayers(openedLayers);
      layersRef.current = openedLayers;
      setActiveLayerId(openedActiveLayerId);
      activeLayerIdRef.current = openedActiveLayerId;
      requestHistoryRefresh();
      setStatusMessage(`開きました: ${result.filePath}`);
      window.dispatchEvent(new CustomEvent('michikusa-redraw'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      window.alert(`ファイルを開けませんでした。\n${message}`);
    }
  };

  const newProject = (): void => {
    if (!confirmDiscard()) return;

    strokesRef.current = [];
    importedImagesRef.current = [];
    imageElementCacheRef.current.clear();
    redoRef.current = [];
    activeStrokeRef.current = null;
    selectedEditablesRef.current = [];
    cameraRef.current = { x: 0, y: 0, zoom: 1 };
    backgroundColorRef.current = DEFAULT_BACKGROUND_COLOR;
    backgroundPatternRef.current = DEFAULT_BACKGROUND_PATTERN;
    backgroundSpacingRef.current = DEFAULT_BACKGROUND_SPACING;
    createdAtRef.current = new Date().toISOString();

    setColor(DEFAULT_COLOR);
    setTool('pen');
    setLineWidth(DEFAULT_WIDTH);
    brushRef.current = DEFAULT_BRUSH;
    opacityRef.current = DEFAULT_OPACITY;
    drawingSettingsRef.current = createDefaultDrawingSettings();
    activeDrawingSettingKeyRef.current = DEFAULT_BRUSH;
    setBrush(DEFAULT_BRUSH);
    setStrokeOpacity(DEFAULT_OPACITY);
    setBackgroundColor(DEFAULT_BACKGROUND_COLOR);
    setBackgroundPattern(DEFAULT_BACKGROUND_PATTERN);
    setBackgroundSpacing(DEFAULT_BACKGROUND_SPACING);
    setZoomLabel('100%');
    setCurrentPath(undefined);
    setIsDirty(false);
    setReview(createDefaultReviewData());
    reviewUndoRef.current = [];
    reviewRedoRef.current = [];
    setWorkspaceMode('create');
    setPlacementDefinitionId(undefined);
    setSelectedStampId(undefined);
    setToolbarStampDefinitionId('theme');
    const defaultLayers = createDefaultLayers();
    setLayers(defaultLayers);
    layersRef.current = defaultLayers;
    setActiveLayerId(DEFAULT_LAYER_ID);
    activeLayerIdRef.current = DEFAULT_LAYER_ID;
    setStatusMessage('新しいプロジェクト');
    requestHistoryRefresh();
    window.dispatchEvent(new CustomEvent('michikusa-redraw'));
  };

  const undo = (): void => {
    if (workspaceModeRef.current === 'review' && reviewUndoRef.current.length > 0) {
      const previous = reviewUndoRef.current.pop()!;
      reviewRedoRef.current.push(structuredClone(reviewRef.current));
      reviewRef.current = previous;
      setReview(previous);
      markDirty();
      requestHistoryRefresh();
      window.dispatchEvent(new CustomEvent('michikusa-redraw'));
      return;
    }
    const last = strokesRef.current.pop();
    if (!last) return;
    redoRef.current.push(last);
    markDirty();
    requestHistoryRefresh();
    window.dispatchEvent(new CustomEvent('michikusa-redraw'));
  };

  const redo = (): void => {
    if (workspaceModeRef.current === 'review' && reviewRedoRef.current.length > 0) {
      const next = reviewRedoRef.current.pop()!;
      reviewUndoRef.current.push(structuredClone(reviewRef.current));
      reviewRef.current = next;
      setReview(next);
      markDirty();
      requestHistoryRefresh();
      window.dispatchEvent(new CustomEvent('michikusa-redraw'));
      return;
    }
    const restored = redoRef.current.pop();
    if (!restored) return;
    strokesRef.current.push(restored);
    markDirty();
    requestHistoryRefresh();
    window.dispatchEvent(new CustomEvent('michikusa-redraw'));
  };

  const zoomFromMenu = (nextZoom: number): void => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const camera = cameraRef.current;
    const clampedZoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
    const anchorX = canvas.clientWidth / 2;
    const anchorY = canvas.clientHeight / 2;
    const worldX = (anchorX - camera.x) / camera.zoom;
    const worldY = (anchorY - camera.y) / camera.zoom;

    camera.zoom = clampedZoom;
    camera.x = anchorX - worldX * clampedZoom;
    camera.y = anchorY - worldY * clampedZoom;
    setZoomLabel(`${Math.round(clampedZoom * 100)}%`);
    markDirty();
    window.dispatchEvent(new CustomEvent('michikusa-redraw'));
  };

  const changeBackground = (
    nextColor: CanvasBackgroundColor = backgroundColorRef.current,
    nextPattern: CanvasBackgroundPattern = backgroundPatternRef.current,
  ): void => {
    backgroundColorRef.current = nextColor;
    backgroundPatternRef.current = nextPattern;
    setBackgroundColor(nextColor);
    setBackgroundPattern(nextPattern);
    markDirty();
    setOpenMenu(null);
    window.dispatchEvent(new CustomEvent('michikusa-redraw'));
  };

  const changeBackgroundSpacing = (nextSpacing: number): void => {
    const normalizedSpacing = clamp(nextSpacing, MIN_BACKGROUND_SPACING, MAX_BACKGROUND_SPACING);
    backgroundSpacingRef.current = normalizedSpacing;
    setBackgroundSpacing(normalizedSpacing);
    markDirty();
    window.dispatchEvent(new CustomEvent('michikusa-redraw'));
  };

  const updateColorFromPalette = (event: React.PointerEvent<HTMLDivElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect();
    const saturation = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const brightness = 1 - clamp((event.clientY - rect.top) / rect.height, 0, 1);
    const { h } = rgbToHsv(...Object.values(hexToRgb(color)) as [number, number, number]);
    const next = hsvToRgb(h, saturation, brightness);
    setColor(rgbToHex(next.r, next.g, next.b));
    markDirty();
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const startEyedropper = (target: { kind: 'pen' } | { kind: 'stamp'; definitionId: string }): void => {
    eyedropperTargetRef.current = target;
    setIsEyedropping(true);
    setOpenMenu(null);
    setStatusMessage('スポイト：色を取得する場所をクリック');
  };

  const updateReview = (updater: (current: ReviewData) => ReviewData): void => {
    const current = reviewRef.current;
    reviewUndoRef.current.push(structuredClone(current));
    reviewRedoRef.current = [];
    const next = updater(current);
    reviewRef.current = next;
    setReview(next);
    markDirty();
    requestHistoryRefresh();
    window.dispatchEvent(new CustomEvent('michikusa-redraw'));
  };

  const addStampDefinition = (name: string, stampColor: string): void => {
    const definitionId = crypto.randomUUID();
    updateReview((current) => {
      const inheritedSize = current.stampDefinitions.find((definition) => definition.id === toolbarStampDefinitionId)?.size ?? DEFAULT_STAMP_SIZE;
      const definition: StampDefinition = {
        id: definitionId, name, color: stampColor, kind: 'custom',
        order: Math.max(0, ...current.stampDefinitions.map((item) => item.order)) + 1,
        size: inheritedSize,
      };
      return { ...current, stampDefinitions: [...current.stampDefinitions, definition], visibility: { ...current.visibility, [definition.id]: true } };
    });
    setToolbarStampDefinitionId(definitionId);
    setPlacementDefinitionId(definitionId);
    placementDefinitionRef.current = definitionId;
    setSelectedStampId(undefined);
    selectedStampRef.current = undefined;
  };

  const deleteStampDefinition = (definitionId: string): void => {
    updateReview((current) => ({
      ...current,
      stampDefinitions: current.stampDefinitions.filter((definition) => definition.id !== definitionId),
      placedStamps: current.placedStamps.filter((stamp) => stamp.definitionId !== definitionId),
      visibility: Object.fromEntries(Object.entries(current.visibility).filter(([id]) => id !== definitionId)),
    }));
    if (placementDefinitionId === definitionId) setPlacementDefinitionId(undefined);
    if (toolbarStampDefinitionId === definitionId) setToolbarStampDefinitionId('theme');
  };

  const replaceCustomDefinitions = (definitions: StampDefinition[]): void => {
    updateReview((current) => {
      const theme = current.stampDefinitions.find((definition) => definition.kind === 'theme')!;
      const customIds = new Set(current.stampDefinitions.filter((definition) => definition.kind === 'custom').map((definition) => definition.id));
      return { ...current, stampDefinitions: [theme, ...definitions], placedStamps: current.placedStamps.filter((stamp) => !customIds.has(stamp.definitionId)), visibility: { theme: current.visibility.theme !== false, ...Object.fromEntries(definitions.map((definition) => [definition.id, true])) } };
    });
  };

  useEffect(() => {
    return window.michikusa.onMenuCommand((command) => {
      switch (command.type) {
        case 'project:new':
          newProject();
          break;
        case 'project:open':
          void openProject();
          break;
        case 'project:save':
          void save(false);
          break;
        case 'project:save-as':
          void save(true);
          break;
        case 'edit:undo':
          undo();
          break;
        case 'edit:redo':
          redo();
          break;
        case 'tool:select':
          setTool(command.tool);
          break;
        case 'tool:color':
          setColor(command.color);
          markDirty();
          break;
        case 'tool:color-picker':
          setOpenMenu('color-picker');
          break;
        case 'tool:register-color':
          void window.michikusa.addMenuPreset({
            type: 'color',
            value: colorRef.current,
          });
          break;
        case 'tool:width':
          setLineWidth(command.width);
          markDirty();
          break;
        case 'tool:register-width':
          void window.michikusa.addMenuPreset({
            type: 'width',
            value: widthRef.current,
          });
          break;
        case 'view:zoom-in':
          zoomFromMenu(cameraRef.current.zoom * 1.2);
          break;
        case 'view:zoom-out':
          zoomFromMenu(cameraRef.current.zoom / 1.2);
          break;
        case 'view:reset-zoom':
          zoomFromMenu(1);
          break;
      }
    });
  });

  const renderRecordingFrame = (context: CanvasRenderingContext2D, targetWidth: number, targetHeight: number): void => {
    if (lastRenderedRecordingVersionRef.current === recordingSceneVersionRef.current) return;
    lastRenderedRecordingVersionRef.current = recordingSceneVersionRef.current;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const viewportWidth = canvas.clientWidth;
    const viewportHeight = canvas.clientHeight;
    const targetAspect = targetWidth / targetHeight;
    const recordingWidth = Math.max(viewportWidth, viewportHeight * targetAspect);
    const recordingHeight = Math.max(viewportHeight, viewportWidth / targetAspect);
    const viewportOffsetX = (recordingWidth - viewportWidth) / 2;
    const viewportOffsetY = (recordingHeight - viewportHeight) / 2;
    const outputScaleX = targetWidth / recordingWidth;
    const outputScaleY = targetHeight / recordingHeight;
    const camera = cameraRef.current;
    const recordingCameraX = camera.x + viewportOffsetX;
    const recordingCameraY = camera.y + viewportOffsetY;
    const backgroundFill = backgroundColorRef.current === 'black' ? '#111111' : backgroundColorRef.current === 'paper' ? '#F5EEDC' : '#ffffff';
    const patternColor = backgroundColorRef.current === 'black' ? 'rgba(255,255,255,0.18)' : 'rgba(70,90,110,0.18)';
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.scale(outputScaleX, outputScaleY);
    context.fillStyle = backgroundFill;
    context.fillRect(0, 0, recordingWidth, recordingHeight);
    const rawPatternStep = backgroundSpacingRef.current * camera.zoom;
    const patternStep = rawPatternStep < 4 ? rawPatternStep * Math.ceil(4 / rawPatternStep) : rawPatternStep;
    const patternStartX = ((recordingCameraX % patternStep) + patternStep) % patternStep;
    const patternStartY = ((recordingCameraY % patternStep) + patternStep) % patternStep;
    context.fillStyle = patternColor;
    context.strokeStyle = patternColor;
    context.lineWidth = 1;
    if (backgroundPatternRef.current === 'dots') {
      const radius = clamp(1.4 * camera.zoom, .7, 2.5);
      for (let y = patternStartY; y < recordingHeight; y += patternStep) for (let x = patternStartX; x < recordingWidth; x += patternStep) {
        context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2); context.fill();
      }
    } else if (backgroundPatternRef.current === 'ruled' || backgroundPatternRef.current === 'grid') {
      context.beginPath();
      for (let y = patternStartY; y < recordingHeight; y += patternStep) { context.moveTo(0, y); context.lineTo(recordingWidth, y); }
      if (backgroundPatternRef.current === 'grid') for (let x = patternStartX; x < recordingWidth; x += patternStep) { context.moveTo(x, 0); context.lineTo(x, recordingHeight); }
      context.stroke();
    }
    context.save();
    context.translate(recordingCameraX, recordingCameraY);
    context.scale(camera.zoom, camera.zoom);
    drawImportedImages(context);
    const visibleLayerIds = new Set(layersRef.current.filter((layer) => layer.visible !== false).map((layer) => layer.id));
    strokesRef.current.forEach((stroke) => { if (visibleLayerIds.has(stroke.layerId ?? DEFAULT_LAYER_ID)) drawStrokePath(context, stroke); });
    if (activeStrokeRef.current) drawStrokePath(context, activeStrokeRef.current);
    context.restore();
    if (workspaceModeRef.current === 'review') reviewRef.current.placedStamps.forEach((stamp) => {
      const definition = reviewRef.current.stampDefinitions.find((item) => item.id === stamp.definitionId);
      if (!definition) return;
      const x = recordingCameraX + stamp.x * camera.zoom;
      const y = recordingCameraY + stamp.y * camera.zoom;
      const size = definition.size ?? DEFAULT_STAMP_SIZE;
      const radius = size * (definition.kind === 'theme' ? .94 : .86) / 2;
      context.save(); context.fillStyle = backgroundColorRef.current === 'black' ? '#202733' : '#F7F3EB'; context.strokeStyle = definition.color; context.lineWidth = 2; context.beginPath();
      if (definition.kind === 'theme') { context.moveTo(x, y - radius); context.lineTo(x + radius, y); context.lineTo(x, y + radius); context.lineTo(x - radius, y); context.closePath(); } else context.arc(x, y, radius, 0, Math.PI * 2);
      context.fill(); context.stroke(); context.fillStyle = backgroundColorRef.current === 'black' ? '#F7F3EB' : '#202733';
      const fontSize = Math.max(14, Math.round(size * .72)); context.font = `${definition.kind === 'theme' ? 600 : 500} ${fontSize}px "BIZ UDPGothic", "Yu Gothic", Meiryo, sans-serif`; context.fillText(definition.name, x + radius + 9, y + fontSize * .35); context.restore();
    });
    context.restore();
  };

  const startRecording = async (): Promise<void> => {
    const canvas = canvasRef.current;
    if (!canvas || recordingState !== 'idle') return;

    try {
      setShowRecordingSettings(false);
      lastRenderedRecordingVersionRef.current = -1;
      const manager = new RecordingManager(canvas, {
        onStateChange: setRecordingState,
        onElapsedChange: setRecordingElapsed,
        onAudioLevelChange: setAudioLevel,
      }, recordingSettings, renderRecordingFrame);

      recordingManagerRef.current = manager;
      await manager.start();
      await refreshAudioDevices();
      setStatusMessage('録画中です');
    } catch (error) {
      recordingManagerRef.current = null;
      const message = error instanceof Error ? error.message : String(error);
      window.alert(
        `録画を開始できませんでした。\nマイクの使用許可と接続を確認してください。\n\n${message}`,
      );
      setStatusMessage('録画開始に失敗しました');
    }
  };

  const stopRecording = async (): Promise<void> => {
    const manager = recordingManagerRef.current;
    if (!manager || recordingState !== 'recording') return;

    try {
      const recordingResult = await manager.stop();
      recordingManagerRef.current = null;

      if (!recordingResult || recordingResult.blob.size === 0) {
        throw new Error('録画データが空です。');
      }

      setRecordingState('saving');
      setStatusMessage('シーク可能な動画へ仕上げています');

      const seekableBlob = await makeSeekableWebm(
        recordingResult.blob,
      );
      const bytes = new Uint8Array(await seekableBlob.arrayBuffer());
      const now = new Date();
      const stamp = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, '0'),
        String(now.getDate()).padStart(2, '0'),
        '-',
        String(now.getHours()).padStart(2, '0'),
        String(now.getMinutes()).padStart(2, '0'),
        String(now.getSeconds()).padStart(2, '0'),
      ].join('');

      const saveResult = await window.michikusa.saveRecording(
        bytes,
        `道草45-${stamp}.webm`,
      );

      if (saveResult.canceled) {
        setStatusMessage('録画の保存をキャンセルしました');
      } else {
        setStatusMessage(`録画を保存しました: ${saveResult.filePath}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      window.alert(`録画の停止または保存に失敗しました。\n${message}`);
      setStatusMessage('録画の保存に失敗しました');
    } finally {
      setRecordingState('idle');
      setRecordingElapsed(0);
    }
  };

  useEffect(() => {
    return () => {
      recordingManagerRef.current?.destroy();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const isModifier = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();

      if (event.key === 'Escape' && eyedropperTargetRef.current) {
        eyedropperTargetRef.current = undefined;
        setIsEyedropping(false);
        setStatusMessage('スポイトを解除しました');
        return;
      }

      if (workspaceModeRef.current === 'review') {
        if (event.key === 'Escape') {
          setPlacementDefinitionId(undefined);
          setSelectedStampId(undefined);
          placementDefinitionRef.current = undefined;
          selectedStampRef.current = undefined;
          window.dispatchEvent(new CustomEvent('michikusa-redraw'));
          return;
        }
        const target = event.target;
        const isEditing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
        if (!isEditing && (event.key === 'Delete' || event.key === 'Backspace') && selectedStampRef.current) {
          event.preventDefault();
          const stampId = selectedStampRef.current;
          updateReview((current) => ({ ...current, placedStamps: current.placedStamps.filter((stamp) => stamp.id !== stampId) }));
          setSelectedStampId(undefined);
          selectedStampRef.current = undefined;
          return;
        }
      }

      if (isModifier && key === 's') {
        event.preventDefault();
        void save(event.shiftKey);
        return;
      }

      if (isModifier && key === 'o') {
        event.preventDefault();
        void openProject();
        return;
      }

      if (isModifier && key === 'n') {
        event.preventDefault();
        newProject();
        return;
      }

      if (isModifier && key === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }

      if (isModifier && key === 'y') {
        event.preventDefault();
        redo();
        return;
      }

      if (event.code === 'Space') {
        event.preventDefault();
        isSpaceDownRef.current = true;
        setIsSpaceDown(true);
        return;
      }

      const target = event.target;
      const isEditingField = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
      if (workspaceModeRef.current === 'illustration' && !isModifier && !isEditingField) {
        if ((key === 'delete' || key === 'backspace') && selectedEditablesRef.current.length) {
          event.preventDefault();
          const strokeIds = new Set(selectedEditablesRef.current.filter((item) => item.kind === 'stroke').map((item) => item.id));
          const imageIds = new Set(selectedEditablesRef.current.filter((item) => item.kind === 'image').map((item) => item.id));
          strokesRef.current = strokesRef.current.filter((stroke) => !strokeIds.has(stroke.id));
          importedImagesRef.current = importedImagesRef.current.filter((image) => !imageIds.has(image.id));
          selectedEditablesRef.current = [];
          editableGestureRef.current = undefined;
          markDirty(); requestHistoryRefresh(); window.dispatchEvent(new CustomEvent('michikusa-redraw'));
          return;
        }
        const brushIndex = Number(event.key) - 1;
        if (brushIndex >= 0 && brushIndex < BRUSH_DEFINITIONS.length) {
          const nextBrush = BRUSH_DEFINITIONS[brushIndex].id;
          brushRef.current = nextBrush;
          setBrush(nextBrush);
          setTool('pen');
          markDirty();
          return;
        }
        if (event.key === '[' || event.key === ']') {
          event.preventDefault();
          const nextWidth = Math.round(clamp(widthRef.current + (event.key === ']' ? 0.1 : -0.1), 0.1, 48) * 10) / 10;
          widthRef.current = nextWidth;
          setLineWidth(nextWidth);
          markDirty();
          return;
        }
      }

      if (!isModifier && key === 'p') setTool('pen');
      if (!isModifier && key === 'e') setTool('eraser');
      if (workspaceModeRef.current === 'illustration' && !isModifier && key === 'v') setTool('select');
      if (!isModifier && key === 'r') {
        event.preventDefault();
        if (recordingState === 'idle') void startRecording();
        if (recordingState === 'recording') void stopRecording();
      }
    };

    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.code === 'Space') {
        isSpaceDownRef.current = false;
        setIsSpaceDown(false);
        isPanningRef.current = false;
        lastScreenPointRef.current = null;
        setIsPanning(false);
      }
    };

    const cancelPanning = (): void => {
      isSpaceDownRef.current = false;
      isPanningRef.current = false;
      lastScreenPointRef.current = null;
      setIsSpaceDown(false);
      setIsPanning(false);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', cancelPanning);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', cancelPanning);
    };
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext('2d');
    if (!context) throw new Error('2D canvas context could not be created.');

    const drawStroke = (stroke: Stroke): void => {
      if (stroke.points.length < 2) return;

      const camera = cameraRef.current;
      context.save();
      context.translate(camera.x, camera.y);
      context.scale(camera.zoom, camera.zoom);
      drawStrokePath(context, stroke);
      context.restore();
    };

    const drawReviewOverlay = (): void => {
      const current = reviewRef.current;
      const camera = cameraRef.current;
      const cachedMichikusaScore = michikusaScoreCacheRef.current;
      const michikusaScore = cachedMichikusaScore?.review === current
        ? cachedMichikusaScore.score
        : calculateMichikusaScore(current.placedStamps
          .filter((stamp) => current.stampDefinitions.some((definition) => definition.id === stamp.definitionId && definition.kind === 'custom'))
          .map(({ x, y }) => ({ x, y })));
      if (cachedMichikusaScore?.review !== current) {
        michikusaScoreCacheRef.current = { review: current, score: michikusaScore };
      }
      const drawFarthestPath = (): void => {
        const michikusa = calculateMichikusa(current.stampDefinitions, current.placedStamps);
        if (current.displaySettings.showFarthestPath && michikusa.available) {
        const themeDefinition = current.stampDefinitions.find((definition) => definition.kind === 'theme');
        const theme = themeDefinition && current.placedStamps.find((stamp) => stamp.definitionId === themeDefinition.id);
        const farthest = current.placedStamps.find((stamp) => stamp.id === michikusa.farthestStampId);
        if (theme && farthest) {
          const themeX = camera.x + theme.x * camera.zoom;
          const themeY = camera.y + theme.y * camera.zoom;
          const farthestX = camera.x + farthest.x * camera.zoom;
          const farthestY = camera.y + farthest.y * camera.zoom;
          context.save();
          context.strokeStyle = '#8B6A45';
          context.lineWidth = 1.5;
          context.lineCap = 'round';
          context.setLineDash([5, 5]);
          context.beginPath();
          context.moveTo(themeX, themeY);
          context.lineTo(farthestX, farthestY);
          context.stroke();
          context.setLineDash([]);
          context.fillStyle = '#F7F3EB';
          context.strokeStyle = '#8B6A45';
          context.lineWidth = 1.5;
          for (const point of [{ x: themeX, y: themeY }, { x: farthestX, y: farthestY }]) {
            context.beginPath();
            context.arc(point.x, point.y, 3.5, 0, Math.PI * 2);
            context.fill();
            context.stroke();
          }
          const middleX = (themeX + farthestX) / 2;
          const middleY = (themeY + farthestY) / 2;
          const valueLabel = `道草値  ${michikusaScore}`;
          context.font = '500 28px "IBM Plex Sans JP", "BIZ UDPGothic", "Yu Gothic UI", Meiryo, sans-serif';
          const labelWidth = context.measureText(valueLabel).width;
          context.fillStyle = 'rgba(247, 243, 235, .94)';
          context.strokeStyle = '#C8B9A8';
          context.lineWidth = 1;
          context.beginPath();
          context.roundRect(middleX - labelWidth / 2 - 16, middleY - 27, labelWidth + 32, 54, 6);
          context.fill();
          context.stroke();
          context.fillStyle = '#5D4633';
          context.textAlign = 'center';
          context.textBaseline = 'middle';
          context.fillText(valueLabel, middleX, middleY);
          context.restore();
        }
        }
      };

      const drawSummaryOverlay = (): void => {
        if (!showReviewSummaryRef.current) return;
        const percentages = calculatePercentages(current.stampDefinitions, current.placedStamps).filter((item) => item.count > 0);
        const panelWidth = Math.min(560, canvas.clientWidth - 32);
        const panelHeight = Math.min(Math.max(400, 255 + percentages.length * 30), canvas.clientHeight - 32);
        const position = reviewSummaryPositionRef.current;
        const panelX = canvas.clientWidth / 2 - panelWidth / 2 + position.x;
        const panelY = canvas.clientHeight / 2 - panelHeight / 2 + position.y;
        context.save();
        context.shadowColor = 'rgba(31,46,74,.12)';
        context.shadowBlur = 18;
        context.fillStyle = '#F7F3EB';
        context.strokeStyle = '#D8D5CE';
        context.lineWidth = 1;
        context.beginPath();
        context.roundRect(panelX, panelY, panelWidth, panelHeight, 14);
        context.fill();
        context.shadowBlur = 0;
        context.stroke();
        context.fillStyle = '#202733';
        context.textAlign = 'left';
        context.textBaseline = 'alphabetic';
        context.font = '600 30px "IBM Plex Sans JP", "BIZ UDPGothic", "Yu Gothic UI", Meiryo, sans-serif';
        context.fillText('集計', panelX + 26, panelY + 48);
        context.fillStyle = '#F7F3EB';
        context.strokeStyle = '#D8D5CE';
        context.lineWidth = 1.5;
        context.beginPath();
        context.roundRect(panelX + panelWidth - 52, panelY + 14, 38, 38, 8);
        context.fill();
        context.stroke();
        context.strokeStyle = '#59616D';
        context.lineWidth = 2.5;
        context.beginPath();
        context.moveTo(panelX + panelWidth - 38, panelY + 25);
        context.lineTo(panelX + panelWidth - 24, panelY + 39);
        context.moveTo(panelX + panelWidth - 24, panelY + 25);
        context.lineTo(panelX + panelWidth - 38, panelY + 39);
        context.stroke();
        context.font = '500 19px "IBM Plex Sans JP", "BIZ UDPGothic", "Yu Gothic UI", Meiryo, sans-serif';
        context.fillText('使用したスタンプ', panelX + 26, panelY + 92);
        const total = percentages.reduce((sum, item) => sum + item.count, 0);
        const chartX = panelX + 120;
        const chartY = panelY + 194;
        const chartRadius = 78;
        if (total === 0) {
          context.fillStyle = '#e5e7eb';
          context.beginPath();
          context.arc(chartX, chartY, chartRadius, 0, Math.PI * 2);
          context.fill();
        } else {
          let startAngle = -Math.PI / 2;
          percentages.forEach(({ definition, count }) => {
            const endAngle = startAngle + (count / total) * Math.PI * 2;
            context.fillStyle = definition.color;
            context.beginPath();
            context.moveTo(chartX, chartY);
            context.arc(chartX, chartY, chartRadius, startAngle, endAngle);
            context.closePath();
            context.fill();
            startAngle = endAngle;
          });
        }
        context.font = '17px "IBM Plex Sans JP", "BIZ UDPGothic", "Yu Gothic UI", Meiryo, sans-serif';
        percentages.slice(0, 8).forEach(({ definition, count, percentage }, index) => {
          const rowY = panelY + 129 + index * 30;
          context.fillStyle = definition.color;
          context.beginPath();
          context.arc(panelX + 235, rowY - 6, 8, 0, Math.PI * 2);
          context.fill();
          context.fillStyle = '#202733';
          context.fillText(`${definition.name}  ${count}件（${percentage}%）`, panelX + 252, rowY);
        });
        const footerY = panelY + panelHeight - 48;
        context.fillStyle = '#202733';
        context.font = '17px "IBM Plex Sans JP", "BIZ UDPGothic", "Yu Gothic UI", Meiryo, sans-serif';
        const largest = percentages[0];
        context.fillText(largest ? `最大割合：${largest.definition.name}（${largest.percentage}%）` : '使用したスタンプはありません', panelX + 20, footerY - 24);
        context.font = '500 28px "IBM Plex Sans JP", "BIZ UDPGothic", "Yu Gothic UI", Meiryo, sans-serif';
        context.fillStyle = '#5D4633';
        context.fillText(`道草値 ${michikusaScore}`, panelX + 20, footerY + 8);
        context.restore();
      };

      const drawWrapSummaryOverlay = (): void => {
        if (!showWrapSummaryRef.current) return;
        const michikusa = calculateMichikusa(current.stampDefinitions, current.placedStamps);
        const farthest = michikusa.available ? current.stampDefinitions.find((definition) => definition.id === michikusa.farthestDefinitionId) : undefined;
        const panelWidth = Math.min(560, canvas.clientWidth - 32);
        const panelHeight = Math.min(560, canvas.clientHeight - 32);
        const position = reviewSummaryPositionRef.current;
        const panelX = canvas.clientWidth / 2 - panelWidth / 2 + position.x;
        const panelY = canvas.clientHeight / 2 - panelHeight / 2 + position.y;
        context.save();
        context.shadowColor = 'rgba(47,43,37,.16)';
        context.shadowBlur = 24;
        context.shadowOffsetY = 7;
        context.fillStyle = '#F7F3EB';
        context.beginPath();
        context.rect(panelX, panelY, panelWidth, panelHeight);
        context.fill();
        context.shadowBlur = 0;
        context.shadowOffsetY = 0;
        context.fillStyle = '#242321';
        context.textAlign = 'left';
        context.textBaseline = 'alphabetic';
        context.font = '500 28px "Yu Gothic UI", "Noto Sans JP", sans-serif';
        context.fillText('今回のまとめ', panelX + 44, panelY + 58);
        context.strokeStyle = '#5e5a54';
        context.lineWidth = 1.5;
        context.beginPath();
        context.moveTo(panelX + panelWidth - 43, panelY + 29);
        context.lineTo(panelX + panelWidth - 29, panelY + 43);
        context.moveTo(panelX + panelWidth - 29, panelY + 29);
        context.lineTo(panelX + panelWidth - 43, panelY + 43);
        context.stroke();
        context.strokeStyle = '#D8D2C8';
        context.lineWidth = 1;
        for (const lineY of [214, 342]) {
          context.beginPath();
          context.moveTo(panelX + 44, panelY + lineY);
          context.lineTo(panelX + panelWidth - 44, panelY + lineY);
          context.stroke();
        }
        const drawNodeLabel = (label: string, y: number): void => {
          context.strokeStyle = '#57534e';
          context.lineWidth = 1.5;
          context.beginPath();
          context.arc(panelX + 51, panelY + y - 6, 6, 0, Math.PI * 2);
          context.stroke();
          context.fillStyle = '#5f5b55';
          context.font = '400 16px "Yu Gothic UI", "Noto Sans JP", sans-serif';
          context.fillText(label, panelX + 70, panelY + y);
        };
        drawNodeLabel('今日の道草値', 112);
        context.fillStyle = '#9A5F3A';
        context.font = '500 42px "Yu Gothic UI", "Noto Sans JP", sans-serif';
        context.fillText(`${michikusaScore}`, panelX + 44, panelY + 174);
        drawNodeLabel('今日の頭の中', 256);
        context.fillStyle = '#292826';
        context.font = '400 27px "Yu Gothic UI", "Noto Sans JP", sans-serif';
        context.fillText(farthest?.name ?? '記録なし', panelX + 44, panelY + 306);
        drawNodeLabel('今日のひとこと', 384);
        const noteX = panelX + WRAP_NOTE_INSET;
        const noteY = panelY + WRAP_NOTE_TOP;
        const noteWidth = panelWidth - WRAP_NOTE_INSET * 2;
        const noteHeight = panelHeight - WRAP_NOTE_TOP - WRAP_NOTE_BOTTOM;
        context.fillStyle = '#ffffff';
        context.fillRect(noteX, noteY, noteWidth, noteHeight);
        context.save();
        context.beginPath();
        context.rect(noteX, noteY, noteWidth, noteHeight);
        context.clip();
        context.lineCap = 'round';
        context.lineJoin = 'round';
        [...wrapNoteStrokesRef.current, ...(activeWrapNoteStrokeRef.current ? [activeWrapNoteStrokeRef.current] : [])].forEach((stroke) => {
          if (stroke.points.length < 2) return;
          context.strokeStyle = stroke.color;
          context.lineWidth = stroke.width;
          context.beginPath();
          context.moveTo(noteX + stroke.points[0].x, noteY + stroke.points[0].y);
          stroke.points.slice(1).forEach((point) => context.lineTo(noteX + point.x, noteY + point.y));
          context.stroke();
        });
        context.restore();
        context.restore();
      };

      current.placedStamps.forEach((stamp) => {
        const definition = current.stampDefinitions.find((item) => item.id === stamp.definitionId);
        if (!definition) return;
        const x = camera.x + stamp.x * camera.zoom;
        const y = camera.y + stamp.y * camera.zoom;
        // Stamp dimensions are screen pixels, intentionally independent of camera zoom.
        const stampSize = definition.size ?? DEFAULT_STAMP_SIZE;
        const visualSize = stampSize * (definition.kind === 'theme' ? 0.94 : 0.86);
        const radius = visualSize / 2;
        context.save();
        context.fillStyle = backgroundColorRef.current === 'black' ? '#202733' : '#F7F3EB';
        context.strokeStyle = definition.color;
        context.lineWidth = 2;
        if (selectedStampRef.current === stamp.id) {
          context.shadowColor = 'rgba(47, 79, 62, .28)';
          context.shadowBlur = 9;
        }
        if (definition.kind === 'theme') {
          context.beginPath();
          context.moveTo(x, y - radius);
          context.lineTo(x + radius, y);
          context.lineTo(x, y + radius);
          context.lineTo(x - radius, y);
          context.closePath();
          context.fill();
          context.stroke();
        } else {
          context.beginPath();
          context.arc(x, y, radius, 0, Math.PI * 2);
          context.fill();
          context.stroke();
        }
        context.shadowBlur = 0;
        context.fillStyle = backgroundColorRef.current === 'black' ? '#F7F3EB' : '#202733';
        const stampFontSize = Math.max(14, Math.round(stampSize * 0.72));
        const stampFontWeight = definition.kind === 'theme' ? 600 : 500;
        context.font = `${stampFontWeight} ${stampFontSize}px "BIZ UDPGothic", "Yu Gothic", Meiryo, sans-serif`;
        context.fillText(definition.name, x + radius + 9, y + stampFontSize * 0.35);
        context.restore();
      });
      drawFarthestPath();
      drawSummaryOverlay();
      drawWrapSummaryOverlay();
    };

    const redraw = (): void => {
      const ratio = window.devicePixelRatio || 1;
      const logicalWidth = canvas.clientWidth;
      const logicalHeight = canvas.clientHeight;

      context.save();
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.restore();

      context.save();
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      const backgroundFill = backgroundColorRef.current === 'black'
        ? '#111111'
        : backgroundColorRef.current === 'paper'
          ? '#F5EEDC'
          : '#ffffff';
      const patternColor = backgroundColorRef.current === 'black'
        ? 'rgba(255,255,255,0.18)'
        : 'rgba(70,90,110,0.18)';
      context.fillStyle = backgroundFill;
      context.fillRect(0, 0, logicalWidth, logicalHeight);
      context.fillStyle = patternColor;
      context.strokeStyle = patternColor;
      context.lineWidth = 1;
      const camera = cameraRef.current;
      const rawPatternStep = backgroundSpacingRef.current * camera.zoom;
      const patternStep = rawPatternStep < 4
        ? rawPatternStep * Math.ceil(4 / rawPatternStep)
        : rawPatternStep;
      const patternStartX = ((camera.x % patternStep) + patternStep) % patternStep;
      const patternStartY = ((camera.y % patternStep) + patternStep) % patternStep;
      if (backgroundPatternRef.current === 'dots') {
        const dotRadius = clamp(1.4 * camera.zoom, 0.7, 2.5);
        for (let y = patternStartY; y < logicalHeight; y += patternStep) {
          for (let x = patternStartX; x < logicalWidth; x += patternStep) {
            context.beginPath();
            context.arc(x, y, dotRadius, 0, Math.PI * 2);
            context.fill();
          }
        }
      } else if (backgroundPatternRef.current === 'ruled' || backgroundPatternRef.current === 'grid') {
        context.beginPath();
        for (let y = patternStartY; y < logicalHeight; y += patternStep) {
          context.moveTo(0, y);
          context.lineTo(logicalWidth, y);
        }
        if (backgroundPatternRef.current === 'grid') {
          for (let x = patternStartX; x < logicalWidth; x += patternStep) {
            context.moveTo(x, 0);
            context.lineTo(x, logicalHeight);
          }
        }
        context.stroke();
      }
      context.save();
      context.translate(camera.x, camera.y);
      context.scale(camera.zoom, camera.zoom);
      drawImportedImages(context);
      context.restore();
      const visibleLayerIds = new Set(layersRef.current.filter((layer) => layer.visible !== false).map((layer) => layer.id));
      strokesRef.current.forEach((stroke) => {
        if (visibleLayerIds.has(stroke.layerId ?? DEFAULT_LAYER_ID)) drawStroke(stroke);
      });
      if (activeStrokeRef.current) drawStroke(activeStrokeRef.current);
      if (workspaceModeRef.current === 'illustration') {
        const bounds = getEditableBounds();
        if (bounds) {
          context.save(); context.translate(camera.x, camera.y); context.scale(camera.zoom, camera.zoom);
          context.strokeStyle = '#2f6f55'; context.lineWidth = 1.5 / camera.zoom; context.setLineDash([5 / camera.zoom, 4 / camera.zoom]);
          context.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
          context.setLineDash([]); context.fillStyle = '#fff'; context.beginPath(); context.arc(bounds.x + bounds.width, bounds.y + bounds.height, 6 / camera.zoom, 0, Math.PI * 2); context.fill(); context.stroke(); context.restore();
        }
        const marquee = marqueeRectRef.current;
        if (marquee) {
          context.save(); context.translate(camera.x, camera.y); context.scale(camera.zoom, camera.zoom); context.fillStyle = 'rgba(47,111,85,.10)'; context.strokeStyle = '#2f6f55'; context.lineWidth = 1 / camera.zoom; context.setLineDash([4 / camera.zoom, 3 / camera.zoom]); context.fillRect(marquee.x, marquee.y, marquee.width, marquee.height); context.strokeRect(marquee.x, marquee.y, marquee.width, marquee.height); context.restore();
        }
      }
      drawReviewOverlay();
      context.restore();
      recordingSceneVersionRef.current += 1;
    };

    const resize = (): void => {
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(canvas.clientWidth * ratio));
      canvas.height = Math.max(1, Math.round(canvas.clientHeight * ratio));
      redraw();
    };

    const clientToCanvasPosition = (
      clientX: number,
      clientY: number,
    ): { x: number; y: number } => {
      const rect = canvas.getBoundingClientRect();
      const scaleX = rect.width > 0 ? canvas.clientWidth / rect.width : 1;
      const scaleY = rect.height > 0 ? canvas.clientHeight / rect.height : 1;
      return {
        x: (clientX - rect.left) * scaleX,
        y: (clientY - rect.top) * scaleY,
      };
    };

    const pointerPosition = (event: PointerEvent): { x: number; y: number } =>
      clientToCanvasPosition(event.clientX, event.clientY);

    const isInsideCanvas = (position: { x: number; y: number }): boolean =>
      position.x >= 0 &&
      position.y >= 0 &&
      position.x <= canvas.clientWidth &&
      position.y <= canvas.clientHeight;

    const sampleDisplayedColor = (position: { x: number; y: number }, target: { kind: 'pen' } | { kind: 'stamp'; definitionId: string } = { kind: 'pen' }): void => {
      const scaleX = canvas.width / canvas.clientWidth;
      const scaleY = canvas.height / canvas.clientHeight;
      const pixelX = clamp(Math.floor(position.x * scaleX), 0, canvas.width - 1);
      const pixelY = clamp(Math.floor(position.y * scaleY), 0, canvas.height - 1);
      const [red, green, blue] = context.getImageData(pixelX, pixelY, 1, 1).data;
      const sampledColor = rgbToHex(red, green, blue);
      if (target.kind === 'stamp') {
        updateReview((current) => ({ ...current, stampDefinitions: current.stampDefinitions.map((definition) => definition.id === target.definitionId ? { ...definition, color: sampledColor } : definition) }));
      } else {
        colorRef.current = sampledColor;
        setColor(sampledColor);
        markDirty();
      }
      eyedropperTargetRef.current = undefined;
      setIsEyedropping(false);
      setStatusMessage(`スポイト: ${sampledColor.toUpperCase()}`);
    };

    const rememberPointerPosition = (event: PointerEvent): void => {
      const position = pointerPosition(event);
      const isInside = isInsideCanvas(position);

      isPointerOverCanvasRef.current = isInside;
      zoomAnchorRef.current = isInside ? position : null;
    };

    const screenToWorld = (x: number, y: number): Point => {
      const camera = cameraRef.current;
      return {
        x: (x - camera.x) / camera.zoom,
        y: (y - camera.y) / camera.zoom,
        pressure: 0.5,
      };
    };

    const appendPointerPoint = (
      stroke: Stroke,
      pointerEvent: PointerEvent,
    ): void => {
      const position = pointerPosition(pointerEvent);
      const incoming = screenToWorld(position.x, position.y);
      incoming.pressure =
        pointerEvent.pointerType === 'pen' && pointerEvent.pressure > 0
          ? pointerEvent.pressure
          : 1;

      const previous = stroke.points[stroke.points.length - 1];
      if (!previous) {
        stroke.points.push(incoming);
        return;
      }

      const zoom = cameraRef.current.zoom;
      const distanceScreen =
        Math.hypot(incoming.x - previous.x, incoming.y - previous.y) * zoom;

      if (distanceScreen < MIN_POINT_DISTANCE_SCREEN) return;

      stroke.points.push(smoothIncomingPoint(previous, incoming, zoom));
    };

    const eraseAt = (world: Point): void => {
      const inputWidthScale = zoomCompensatedInputWidthRef.current ? 1 / cameraRef.current.zoom : 1;
      const radiusWorld = widthRef.current * inputWidthScale / 2;
      let changed = false;
      strokesRef.current = strokesRef.current.flatMap((stroke) => {
        if ((stroke.layerId ?? DEFAULT_LAYER_ID) !== activeLayerIdRef.current) return [stroke];
        const threshold = radiusWorld + stroke.baseWidth / 2;
        const samples: Point[] = [stroke.points[0]];
        for (let index = 1; index < stroke.points.length; index += 1) {
          const start = stroke.points[index - 1];
          const end = stroke.points[index];
          const distance = Math.hypot(end.x - start.x, end.y - start.y);
          const steps = Math.max(1, Math.ceil(distance / Math.max(radiusWorld * 0.3, 0.5)));
          for (let step = 1; step <= steps; step += 1) {
            const ratio = step / steps;
            samples.push({ x: start.x + (end.x - start.x) * ratio, y: start.y + (end.y - start.y) * ratio, pressure: start.pressure + (end.pressure - start.pressure) * ratio });
          }
        }
        if (!samples.some((point) => Math.hypot(world.x - point.x, world.y - point.y) <= threshold)) return [stroke];
        changed = true;
        const chunks: Point[][] = [];
        let chunk: Point[] = [];
        samples.forEach((point) => {
          if (Math.hypot(world.x - point.x, world.y - point.y) > threshold) chunk.push(point);
          else if (chunk.length > 1) { chunks.push(chunk); chunk = []; }
          else chunk = [];
        });
        if (chunk.length > 1) chunks.push(chunk);
        return chunks.map((points, index) => ({ ...stroke, id: index === 0 ? stroke.id : makeId(), points }));
      });

      if (changed) {
        redoRef.current = [];
        markDirty();
        requestHistoryRefresh();
        redraw();
      }
    };

    const onPointerDown = (event: PointerEvent): void => {
      rememberPointerPosition(event);
      canvas.setPointerCapture(event.pointerId);
      const screen = pointerPosition(event);

      if (event.button === 0 && eyedropperTargetRef.current) {
        sampleDisplayedColor(screen, eyedropperTargetRef.current);
        return;
      }

      if (isSpaceDownRef.current || event.button === 1) {
        isPanningRef.current = true;
        lastScreenPointRef.current = screen;
        setIsPanning(true);
        return;
      }

      if (event.button !== 0) return;

      const world = screenToWorld(screen.x, screen.y);

      if (workspaceModeRef.current === 'review') {
        if (showWrapSummaryRef.current) {
          const panelWidth = Math.min(560, canvas.clientWidth - 32);
          const panelHeight = Math.min(560, canvas.clientHeight - 32);
          const position = reviewSummaryPositionRef.current;
          const panelX = canvas.clientWidth / 2 - panelWidth / 2 + position.x;
          const panelY = canvas.clientHeight / 2 - panelHeight / 2 + position.y;
          const noteX = panelX + WRAP_NOTE_INSET;
          const noteY = panelY + WRAP_NOTE_TOP;
          const noteWidth = panelWidth - WRAP_NOTE_INSET * 2;
          const noteHeight = panelHeight - WRAP_NOTE_TOP - WRAP_NOTE_BOTTOM;
          if (screen.x >= noteX && screen.x <= noteX + noteWidth && screen.y >= noteY && screen.y <= noteY + noteHeight) {
            activeWrapNoteStrokeRef.current = { points: [{ x: screen.x - noteX, y: screen.y - noteY }], color: colorRef.current, width: widthRef.current };
            redraw();
          }
          if (screen.x >= panelX && screen.x <= panelX + panelWidth && screen.y >= panelY && screen.y <= panelY + panelHeight) return;
        }
        const definitionId = placementDefinitionRef.current;
        if (definitionId) {
          const definition = reviewRef.current.stampDefinitions.find((item) => item.id === definitionId);
          if (!definition) return;
          const existingTheme = definition.kind === 'theme'
            ? reviewRef.current.placedStamps.find((stamp) => stamp.definitionId === definitionId)
            : undefined;
          const stamp: PlacedStamp = existingTheme
            ? { ...existingTheme, x: world.x, y: world.y }
            : { id: crypto.randomUUID(), definitionId, x: world.x, y: world.y, createdAt: new Date().toISOString(), recordingTimeMs: recordingStateRef.current === 'recording' ? recordingElapsedRef.current : undefined };
          updateReview((current) => ({ ...current, placedStamps: existingTheme ? current.placedStamps.map((item) => item.id === stamp.id ? stamp : item) : [...current.placedStamps, stamp] }));
          return;
        }
        const hit = [...reviewRef.current.placedStamps].reverse().find((stamp) => {
          const definition = reviewRef.current.stampDefinitions.find((item) => item.id === stamp.definitionId);
          const hitRadius = (definition?.size ?? DEFAULT_STAMP_SIZE) / 2 + 4;
          return Math.hypot(stamp.x - world.x, stamp.y - world.y) * cameraRef.current.zoom <= hitRadius;
        });
        setSelectedStampId(hit?.id);
        selectedStampRef.current = hit?.id;
        if (hit) setToolbarStampDefinitionId(hit.definitionId);
        draggingStampRef.current = hit?.id;
        redraw();
        return;
      }

      if (workspaceModeRef.current === 'illustration' && toolRef.current === 'select') {
        const visibleLayerIds = new Set(layersRef.current.filter((layer) => layer.visible !== false).map((layer) => layer.id));
        if (selectionModeRef.current === 'marquee') {
          selectedEditablesRef.current = [];
          marqueeRectRef.current = { x: world.x, y: world.y, width: 0, height: 0 };
          editableGestureRef.current = { mode: 'marquee', start: world };
          redraw();
          return;
        }
        const currentBounds = getEditableBounds();
        if (currentBounds && Math.hypot(world.x - (currentBounds.x + currentBounds.width), world.y - (currentBounds.y + currentBounds.height)) <= 10 / cameraRef.current.zoom) {
          editableGestureRef.current = { mode: 'scale', start: world, snapshot: snapshotEditableSelection(), bounds: currentBounds };
          return;
        }
        const hitStroke = [...strokesRef.current].reverse().find((stroke) => {
          if (!visibleLayerIds.has(stroke.layerId ?? DEFAULT_LAYER_ID)) return false;
          const threshold = stroke.baseWidth / 2 + 6 / cameraRef.current.zoom;
          return stroke.points.some((point, index) => index > 0 && distancePointToSegment(world, stroke.points[index - 1], point) <= threshold);
        });
        const hitImage = !hitStroke ? [...importedImagesRef.current].reverse().find((image) => visibleLayerIds.has(image.layerId ?? DEFAULT_LAYER_ID) && world.x >= image.x && world.x <= image.x + image.width && world.y >= image.y && world.y <= image.y + image.height) : undefined;
        const hit: EditableSelection | undefined = hitStroke ? { kind: 'stroke', id: hitStroke.id } : hitImage ? { kind: 'image', id: hitImage.id } : undefined;
        if (hit) {
          const alreadySelected = selectedEditablesRef.current.some((item) => item.kind === hit.kind && item.id === hit.id);
          if (event.shiftKey) selectedEditablesRef.current = alreadySelected ? selectedEditablesRef.current.filter((item) => item.kind !== hit.kind || item.id !== hit.id) : [...selectedEditablesRef.current, hit];
          else if (!alreadySelected) selectedEditablesRef.current = [hit];
          editableGestureRef.current = { mode: 'move', start: world, snapshot: snapshotEditableSelection(), bounds: getEditableBounds() };
        } else {
          selectedEditablesRef.current = [];
          editableGestureRef.current = undefined;
        }
        redraw();
        return;
      }

      if (toolRef.current === 'eraser') {
        isErasingRef.current = true;
        eraseAt(world);
        return;
      }

      world.pressure =
        event.pointerType === 'pen' && event.pressure > 0
          ? event.pressure
          : 1;

      let drawableLayerId = activeLayerIdRef.current;
      let drawableLayer = layersRef.current.find((layer) => layer.id === drawableLayerId);
      if (!drawableLayer) {
        drawableLayer = layersRef.current[0];
        drawableLayerId = drawableLayer?.id ?? DEFAULT_LAYER_ID;
        activeLayerIdRef.current = drawableLayerId;
        setActiveLayerId(drawableLayerId);
      }
      if (drawableLayer && !drawableLayer.visible) {
        const visibleLayers = layersRef.current.map((layer) => layer.id === drawableLayerId ? { ...layer, visible: true } : layer);
        layersRef.current = visibleLayers;
        setLayers(visibleLayers);
      }

      activeStrokeRef.current = {
        id: makeId(),
        color: colorRef.current,
        baseWidth: widthRef.current * (zoomCompensatedInputWidthRef.current ? 1 / cameraRef.current.zoom : 1),
        brush: brushRef.current,
        opacity: opacityRef.current,
        layerId: drawableLayerId,
        points: [world],
      };
    };

    const onPointerMove = (event: PointerEvent): void => {
      rememberPointerPosition(event);
      const screen = pointerPosition(event);

      if (activeWrapNoteStrokeRef.current) {
        const panelWidth = Math.min(560, canvas.clientWidth - 32);
        const panelHeight = Math.min(560, canvas.clientHeight - 32);
        const position = reviewSummaryPositionRef.current;
        const noteX = canvas.clientWidth / 2 - panelWidth / 2 + position.x + WRAP_NOTE_INSET;
        const noteY = canvas.clientHeight / 2 - panelHeight / 2 + position.y + WRAP_NOTE_TOP;
        activeWrapNoteStrokeRef.current.points.push({ x: screen.x - noteX, y: screen.y - noteY });
        redraw();
        return;
      }

      if (isPanningRef.current && lastScreenPointRef.current) {
        const previous = lastScreenPointRef.current;
        cameraRef.current.x += screen.x - previous.x;
        cameraRef.current.y += screen.y - previous.y;
        lastScreenPointRef.current = screen;
        markDirty();
        redraw();
        return;
      }

      if (workspaceModeRef.current === 'review' && draggingStampRef.current) {
        const world = screenToWorld(screen.x, screen.y);
        const stampId = draggingStampRef.current;
        updateReview((current) => ({ ...current, placedStamps: current.placedStamps.map((stamp) => stamp.id === stampId ? { ...stamp, x: world.x, y: world.y } : stamp) }));
        return;
      }

      if (editableGestureRef.current) {
        const world = screenToWorld(screen.x, screen.y);
        const gesture = editableGestureRef.current;
        if (gesture.mode === 'marquee') {
          const left = Math.min(gesture.start.x, world.x); const top = Math.min(gesture.start.y, world.y); const right = Math.max(gesture.start.x, world.x); const bottom = Math.max(gesture.start.y, world.y);
          marqueeRectRef.current = { x: left, y: top, width: right - left, height: bottom - top };
          const candidates: EditableSelection[] = [
            ...strokesRef.current.filter((stroke) => layersRef.current.find((layer) => layer.id === (stroke.layerId ?? DEFAULT_LAYER_ID))?.visible !== false).map((stroke) => ({ kind: 'stroke' as const, id: stroke.id })),
            ...importedImagesRef.current.filter((image) => layersRef.current.find((layer) => layer.id === (image.layerId ?? DEFAULT_LAYER_ID))?.visible !== false).map((image) => ({ kind: 'image' as const, id: image.id })),
          ];
          selectedEditablesRef.current = candidates.filter((candidate) => { const bounds = getEditableBounds([candidate]); return bounds && bounds.x <= right && bounds.x + bounds.width >= left && bounds.y <= bottom && bounds.y + bounds.height >= top; });
          redraw(); return;
        }
        const snapshot = gesture.snapshot; const bounds = gesture.bounds;
        if (!snapshot || !bounds) return;
        const dx = world.x - gesture.start.x; const dy = world.y - gesture.start.y;
        const scaleX = gesture.mode === 'scale' ? Math.max(.05, (world.x - bounds.x) / Math.max(bounds.width, .001)) : 1;
        const scaleY = gesture.mode === 'scale' ? Math.max(.05, (world.y - bounds.y) / Math.max(bounds.height, .001)) : 1;
        strokesRef.current = strokesRef.current.map((stroke) => { const source = snapshot.strokes.find((item) => item.id === stroke.id); return source ? { ...stroke, baseWidth: gesture.mode === 'scale' ? source.baseWidth * Math.sqrt(scaleX * scaleY) : source.baseWidth, points: source.points.map((point) => ({ ...point, x: gesture.mode === 'scale' ? bounds.x + (point.x - bounds.x) * scaleX : point.x + dx, y: gesture.mode === 'scale' ? bounds.y + (point.y - bounds.y) * scaleY : point.y + dy })) } : stroke; });
        importedImagesRef.current = importedImagesRef.current.map((image) => { const source = snapshot.images.find((item) => item.id === image.id); return source ? { ...image, x: gesture.mode === 'scale' ? bounds.x + (source.x - bounds.x) * scaleX : source.x + dx, y: gesture.mode === 'scale' ? bounds.y + (source.y - bounds.y) * scaleY : source.y + dy, width: source.width * scaleX, height: source.height * scaleY } : image; });
        markDirty(); redraw(); return;
      }

      if (isErasingRef.current) {
        const coalescedEvents = event.getCoalescedEvents?.();
        const events = coalescedEvents?.length ? coalescedEvents : [event];
        for (const coalesced of events) {
          const position = pointerPosition(coalesced);
          eraseAt(screenToWorld(position.x, position.y));
        }
        return;
      }

      const stroke = activeStrokeRef.current;
      if (!stroke) return;

      const coalescedEvents = event.getCoalescedEvents?.();
      const events = coalescedEvents?.length ? coalescedEvents : [event];
      for (const coalesced of events) {
        appendPointerPoint(stroke, coalesced);
      }
      redraw();
    };

    const finishPointer = (event: PointerEvent): void => {
      rememberPointerPosition(event);

      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }

      if (isPanningRef.current) {
        isPanningRef.current = false;
        lastScreenPointRef.current = null;
        setIsPanning(false);
        return;
      }

      if (draggingStampRef.current) {
        draggingStampRef.current = undefined;
        return;
      }

      if (editableGestureRef.current) {
        editableGestureRef.current = undefined;
        marqueeRectRef.current = undefined;
        requestHistoryRefresh();
        window.dispatchEvent(new CustomEvent('michikusa-redraw'));
        return;
      }

      if (isErasingRef.current) {
        isErasingRef.current = false;
        return;
      }

      if (activeWrapNoteStrokeRef.current) {
        const noteStroke = activeWrapNoteStrokeRef.current;
        if (noteStroke.points.length === 1) noteStroke.points.push({ ...noteStroke.points[0], x: noteStroke.points[0].x + 0.01 });
        wrapNoteStrokesRef.current.push(noteStroke);
        activeWrapNoteStrokeRef.current = undefined;
        markDirty();
        redraw();
        return;
      }

      const stroke = activeStrokeRef.current;
      if (!stroke) return;

      if (stroke.points.length === 1) {
        stroke.points.push({
          ...stroke.points[0],
          x: stroke.points[0].x + 0.01,
        });
      }

      strokesRef.current.push(stroke);
      redoRef.current = [];
      activeStrokeRef.current = null;
      markDirty();
      requestHistoryRefresh();
      redraw();
    };

    const zoomAtScreenPoint = (
      anchorX: number,
      anchorY: number,
      nextZoom: number,
    ): void => {
      const camera = cameraRef.current;
      const previousZoom = camera.zoom;

      if (Math.abs(nextZoom - previousZoom) < Number.EPSILON) return;

      // Keep the world coordinate below the cursor fixed on screen.
      const worldX = (anchorX - camera.x) / previousZoom;
      const worldY = (anchorY - camera.y) / previousZoom;

      camera.zoom = nextZoom;
      camera.x = anchorX - worldX * nextZoom;
      camera.y = anchorY - worldY * nextZoom;
    };

    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();

      const camera = cameraRef.current;
      const rememberedAnchor =
        isPointerOverCanvasRef.current ? zoomAnchorRef.current : null;
      const anchor =
        rememberedAnchor ?? {
          x: canvas.clientWidth / 2,
          y: canvas.clientHeight / 2,
        };

      // A mouse wheel, pen dial, and one-handed controller can report
      // different delta units. Normalize them before calculating zoom.
      const deltaInPixels =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? event.deltaY * 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? event.deltaY * canvas.clientHeight
            : event.deltaY;

      const factor = Math.exp(-deltaInPixels * 0.0015);
      const nextZoom = clamp(
        camera.zoom * factor,
        MIN_ZOOM,
        MAX_ZOOM,
      );

      zoomAtScreenPoint(anchor.x, anchor.y, nextZoom);
      markDirty();
      setZoomLabel(`${Math.round(nextZoom * 100)}%`);
      redraw();
    };

    const onPointerEnter = (event: PointerEvent): void => {
      rememberPointerPosition(event);
    };

    const onPointerLeave = (event: PointerEvent): void => {
      const position = pointerPosition(event);

      // Pointer capture can continue delivering events outside the canvas.
      // Only clear the zoom anchor once the pointer has truly left it.
      if (!isInsideCanvas(position)) {
        isPointerOverCanvasRef.current = false;
        zoomAnchorRef.current = null;
      }
    };

    const onWindowBlur = (): void => {
      isPointerOverCanvasRef.current = false;
      zoomAnchorRef.current = null;
    };

    const onContextMenu = (event: MouseEvent): void => {
      event.preventDefault();
      const position = clientToCanvasPosition(event.clientX, event.clientY);
      if (!isInsideCanvas(position)) return;

      const shortcutTarget = workspaceModeRef.current === 'review'
        ? { kind: 'stamp' as const, definitionId: toolbarStampDefinitionId }
        : { kind: 'pen' as const };
      sampleDisplayedColor(position, shortcutTarget);
    };

    const onExternalRedraw = (): void => redraw();

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    canvas.addEventListener('pointerenter', onPointerEnter);
    canvas.addEventListener('pointerleave', onPointerLeave);
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', finishPointer);
    canvas.addEventListener('pointercancel', finishPointer);
    canvas.addEventListener('contextmenu', onContextMenu);

    // Listen on the whole application window so scroll input from a
    // one-handed controller works even when the physical mouse is elsewhere.
    window.addEventListener('wheel', onWheel, {
      passive: false,
      capture: true,
    });
    window.addEventListener('blur', onWindowBlur);
    window.addEventListener('michikusa-redraw', onExternalRedraw);

    resize();

    return () => {
      observer.disconnect();
      canvas.removeEventListener('pointerenter', onPointerEnter);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', finishPointer);
      canvas.removeEventListener('pointercancel', finishPointer);
      canvas.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('wheel', onWheel, true);
      window.removeEventListener('blur', onWindowBlur);
      window.removeEventListener('michikusa-redraw', onExternalRedraw);
    };
  }, []);

  const canUndo = workspaceMode === 'review'
    ? reviewUndoRef.current.length > 0
    : strokesRef.current.length > 0;
  const canRedo = workspaceMode === 'review'
    ? reviewRedoRef.current.length > 0
    : redoRef.current.length > 0;

  const switchToNextWorkspaceMode = (): void => {
    const nextMode = workspaceMode === 'create'
      ? WORKSPACE_MODES.find((mode) => mode.id === 'review')!
      : WORKSPACE_MODES.find((mode) => mode.id === 'create')!;
    const defaultStampDefinitionId = reviewRef.current.stampDefinitions.find((definition) => definition.kind === 'theme')?.id ?? 'theme';
    setWorkspaceMode(nextMode.id);
    setToolbarStampDefinitionId(defaultStampDefinitionId);
    const nextPlacementDefinitionId = nextMode.id === 'review' ? defaultStampDefinitionId : undefined;
    setPlacementDefinitionId(nextPlacementDefinitionId);
    placementDefinitionRef.current = nextPlacementDefinitionId;
    setSelectedStampId(undefined);
    selectedStampRef.current = undefined;
    if (nextMode.id !== 'review') {
      showReviewSummaryRef.current = false;
      setShowReviewSummary(false);
      showWrapSummaryRef.current = false;
      setShowWrapSummary(false);
    }
    window.dispatchEvent(new CustomEvent('michikusa-redraw'));
  };

  const currentWorkspaceMode = WORKSPACE_MODES.find((mode) => mode.id === workspaceMode)!;
  const selectedPlacedStamp = review.placedStamps.find((stamp) => stamp.id === selectedStampId);
  const activeStampDefinitionId = selectedPlacedStamp?.definitionId ?? placementDefinitionId ?? toolbarStampDefinitionId;
  const selectedStampDefinition = review.stampDefinitions.find((definition) => definition.id === activeStampDefinitionId);
  const reviewPercentages = calculatePercentages(review.stampDefinitions, review.placedStamps);
  const usedStampPercentages = reviewPercentages.filter((item) => item.count > 0);
  const reviewSummaryHeight = Math.max(400, 255 + usedStampPercentages.length * 30);
  const setReviewSummaryVisible = (visible: boolean): void => {
    showReviewSummaryRef.current = visible;
    setShowReviewSummary(visible);
    if (visible) {
      showWrapSummaryRef.current = false;
      setShowWrapSummary(false);
    }
    window.dispatchEvent(new CustomEvent('michikusa-redraw'));
  };
  const setWrapSummaryVisible = (visible: boolean): void => {
    showWrapSummaryRef.current = visible;
    setShowWrapSummary(visible);
    if (visible) {
      showReviewSummaryRef.current = false;
      setShowReviewSummary(false);
    }
    window.dispatchEvent(new CustomEvent('michikusa-redraw'));
  };
  const exportWrapSummaryPng = async (): Promise<void> => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const previousPosition = reviewSummaryPositionRef.current;
    const centeredPosition = { x: 0, y: 0 };
    reviewSummaryPositionRef.current = centeredPosition;
    setReviewSummaryPosition(centeredPosition);
    setWrapSummaryVisible(true);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const ratio = window.devicePixelRatio || 1;
    const width = Math.min(560, canvas.clientWidth - 32);
    const height = Math.min(560, canvas.clientHeight - 32);
    const sourceX = (canvas.clientWidth / 2 - width / 2) * ratio;
    const sourceY = (canvas.clientHeight / 2 - height / 2) * ratio;
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = Math.round(width * ratio);
    exportCanvas.height = Math.round(height * ratio);
    const exportContext = exportCanvas.getContext('2d');
    if (!exportContext) return;
    exportContext.drawImage(canvas, sourceX, sourceY, exportCanvas.width, exportCanvas.height, 0, 0, exportCanvas.width, exportCanvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => exportCanvas.toBlob((value) => value ? resolve(value) : reject(new Error('PNGを生成できませんでした。')), 'image/png'));
    const projectFileName = currentPath?.split(/[\\/]/).pop() ?? '無題.m45';
    const suggestedPngName = projectFileName.replace(/\.m45$/i, '') + '.png';
    const result = await window.michikusa.savePng(new Uint8Array(await blob.arrayBuffer()), suggestedPngName);
    if (!result.canceled) setStatusMessage(`PNGを保存しました: ${result.filePath}`);
    reviewSummaryPositionRef.current = previousPosition;
    setReviewSummaryPosition(previousPosition);
    window.dispatchEvent(new CustomEvent('michikusa-redraw'));
  };

  const exportCanvasCrop = async (crop: ExportCropRequest): Promise<void> => {
    await Promise.all(importedImagesRef.current.map(loadCanvasImage));
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = crop.outputWidth;
    exportCanvas.height = crop.outputHeight;
    const exportContext = exportCanvas.getContext('2d');
    if (!exportContext) return;
    const camera = cameraRef.current;
    const worldX = (crop.x - camera.x) / camera.zoom;
    const worldY = (crop.y - camera.y) / camera.zoom;
    const worldWidth = crop.width / camera.zoom;
    const worldHeight = crop.height / camera.zoom;
    const exportScaleX = crop.outputWidth / worldWidth;
    const exportScaleY = crop.outputHeight / worldHeight;
    const exportScale = Math.sqrt(exportScaleX * exportScaleY);
    const backgroundFill = backgroundColorRef.current === 'black' ? '#111111' : backgroundColorRef.current === 'paper' ? '#F5EEDC' : '#ffffff';
    const patternColor = backgroundColorRef.current === 'black' ? 'rgba(255,255,255,0.18)' : 'rgba(70,90,110,0.18)';
    exportContext.fillStyle = backgroundFill;
    exportContext.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
    exportContext.save();
    exportContext.setTransform(exportScaleX, 0, 0, exportScaleY, -worldX * exportScaleX, -worldY * exportScaleY);
    exportContext.fillStyle = patternColor;
    exportContext.strokeStyle = patternColor;
    exportContext.lineWidth = 1 / exportScale;
    const spacing = backgroundSpacingRef.current;
    const startX = Math.floor(worldX / spacing) * spacing;
    const startY = Math.floor(worldY / spacing) * spacing;
    if (backgroundPatternRef.current === 'dots') {
      for (let y = startY; y <= worldY + worldHeight; y += spacing) for (let x = startX; x <= worldX + worldWidth; x += spacing) {
        exportContext.beginPath(); exportContext.arc(x, y, 1.4, 0, Math.PI * 2); exportContext.fill();
      }
    } else if (backgroundPatternRef.current === 'ruled' || backgroundPatternRef.current === 'grid') {
      exportContext.beginPath();
      for (let y = startY; y <= worldY + worldHeight; y += spacing) { exportContext.moveTo(worldX, y); exportContext.lineTo(worldX + worldWidth, y); }
      if (backgroundPatternRef.current === 'grid') for (let x = startX; x <= worldX + worldWidth; x += spacing) { exportContext.moveTo(x, worldY); exportContext.lineTo(x, worldY + worldHeight); }
      exportContext.stroke();
    }
    drawImportedImages(exportContext);
    const visibleLayerIds = new Set(layersRef.current.filter((layer) => layer.visible !== false).map((layer) => layer.id));
    strokesRef.current.forEach((stroke) => { if (visibleLayerIds.has(stroke.layerId ?? DEFAULT_LAYER_ID)) drawStrokePath(exportContext, stroke); });
    if (workspaceModeRef.current === 'review') reviewRef.current.placedStamps.forEach((stamp) => {
      const definition = reviewRef.current.stampDefinitions.find((item) => item.id === stamp.definitionId);
      if (!definition) return;
      const stampSizeWorld = (definition.size ?? DEFAULT_STAMP_SIZE) / camera.zoom;
      const radius = stampSizeWorld * (definition.kind === 'theme' ? 0.94 : 0.86) / 2;
      exportContext.save();
      exportContext.fillStyle = backgroundColorRef.current === 'black' ? '#202733' : '#F7F3EB';
      exportContext.strokeStyle = definition.color;
      exportContext.lineWidth = 2 / camera.zoom;
      exportContext.beginPath();
      if (definition.kind === 'theme') { exportContext.moveTo(stamp.x, stamp.y - radius); exportContext.lineTo(stamp.x + radius, stamp.y); exportContext.lineTo(stamp.x, stamp.y + radius); exportContext.lineTo(stamp.x - radius, stamp.y); exportContext.closePath(); }
      else exportContext.arc(stamp.x, stamp.y, radius, 0, Math.PI * 2);
      exportContext.fill(); exportContext.stroke();
      exportContext.fillStyle = backgroundColorRef.current === 'black' ? '#F7F3EB' : '#202733';
      const fontSize = Math.max(14, Math.round((definition.size ?? DEFAULT_STAMP_SIZE) * .72)) / camera.zoom;
      exportContext.font = `${definition.kind === 'theme' ? 600 : 500} ${fontSize}px "BIZ UDPGothic", "Yu Gothic", Meiryo, sans-serif`;
      exportContext.fillText(definition.name, stamp.x + radius + 9 / camera.zoom, stamp.y + fontSize * .35);
      exportContext.restore();
    });
    exportContext.restore();
    const blob = await new Promise<Blob>((resolve, reject) => exportCanvas.toBlob((value) => value ? resolve(value) : reject(new Error('PNGを生成できませんでした。')), 'image/png'));
    const projectName = (currentPath?.split(/[\\/]/).pop() ?? '無題.m45').replace(/\.m45$/i, '');
    const result = await window.michikusa.savePng(new Uint8Array(await blob.arrayBuffer()), `${projectName}.png`);
    if (!result.canceled) { setShowImageExport(false); setStatusMessage(`画像を保存しました: ${result.filePath}`); }
  };
  const importImage = async (): Promise<void> => {
    const result = await window.michikusa.openImage();
    if (result.canceled) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const item: ImportedCanvasImage = { id: crypto.randomUUID(), name: result.name, dataUrl: result.dataUrl, x: 0, y: 0, width: 1, height: 1, layerId: activeLayerIdRef.current };
    const image = await loadCanvasImage(item);
    const camera = cameraRef.current;
    const displayScale = Math.min(1, canvas.clientWidth * .7 / image.naturalWidth, canvas.clientHeight * .7 / image.naturalHeight);
    item.width = image.naturalWidth * displayScale / camera.zoom;
    item.height = image.naturalHeight * displayScale / camera.zoom;
    item.x = (canvas.clientWidth / 2 - camera.x) / camera.zoom - item.width / 2;
    item.y = (canvas.clientHeight / 2 - camera.y) / camera.zoom - item.height / 2;
    importedImagesRef.current.push(item);
    markDirty();
    setStatusMessage(`画像を取り込みました: ${result.name}`);
    window.dispatchEvent(new CustomEvent('michikusa-redraw'));
  };
  const updateLayers = (updater: (current: LayerDefinition[]) => LayerDefinition[]): void => {
    const next = updater(layersRef.current);
    layersRef.current = next;
    setLayers(next);
    markDirty();
    window.dispatchEvent(new CustomEvent('michikusa-redraw'));
  };
  const addLayer = (): void => {
    const id = crypto.randomUUID();
    updateLayers((current) => [...current, { id, name: `レイヤー${current.length + 1}`, visible: true, order: Math.max(-1, ...current.map((layer) => layer.order)) + 1 }]);
    activeLayerIdRef.current = id;
    setActiveLayerId(id);
  };
  const deleteLayer = (id: string): void => {
    if (layersRef.current.length <= 1) return;
    const remaining = layersRef.current.filter((layer) => layer.id !== id);
    strokesRef.current = strokesRef.current.filter((stroke) => (stroke.layerId ?? DEFAULT_LAYER_ID) !== id);
    importedImagesRef.current = importedImagesRef.current.filter((image) => (image.layerId ?? DEFAULT_LAYER_ID) !== id);
    updateLayers(() => remaining);
    if (activeLayerIdRef.current === id) {
      const nextActiveId = remaining[remaining.length - 1].id;
      activeLayerIdRef.current = nextActiveId;
      setActiveLayerId(nextActiveId);
    }
    redoRef.current = [];
    requestHistoryRefresh();
  };
  const displayName = currentPath
    ? currentPath.split(/[\\/]/).pop() ?? '無題.m45'
    : '無題.m45';
  void historyTick;

  return (
    <section className="workspace">
      <nav className="app-menu-bar" onMouseLeave={() => setOpenMenu(null)}>
        <div className="app-menu">
          <button onClick={() => { setFileMenuPage('root'); setOpenMenu(openMenu === 'file' ? null : 'file'); }}>ファイル</button>
          {openMenu === 'file' && <div className="app-menu-popup">
            {fileMenuPage === 'root' && <>
            <button onClick={() => { newProject(); setOpenMenu(null); }}>新規 <kbd>Ctrl+N</kbd></button>
            <button onClick={() => { void openProject(); setOpenMenu(null); }}>開く <kbd>Ctrl+O</kbd></button>
            <button onClick={() => { void importImage(); setOpenMenu(null); }}>画像を取り込む</button>
            <button onClick={() => { void save(false); setOpenMenu(null); }}>保存 <kbd>Ctrl+S</kbd></button>
            <button onClick={() => { void save(true); setOpenMenu(null); }}>名前を付けて保存</button>
            <button onClick={() => { setShowImageExport(true); setOpenMenu(null); }}>画像として保存</button>
            <div className="menu-section-title">モード</div>
            <button onClick={() => { setWorkspaceMode('create'); setOpenMenu(null); }}>思考モード</button>
            <button onClick={() => { setWorkspaceMode('review'); setOpenMenu(null); }}>分析モード</button>
            <button onClick={() => { setWorkspaceMode('illustration'); setOpenMenu(null); }}>イラストモード</button>
            <div className="menu-section-title">環境</div>
            <button onClick={() => setFileMenuPage('settings')}>設定 <span aria-hidden="true">›</span></button>
            <button onClick={() => void window.michikusa.quit()}>終了</button>
            </>}
            {fileMenuPage === 'settings' && <>
            <button onClick={() => setFileMenuPage('root')}>← ファイル</button>
            <div className="menu-section-title">設定</div>
            <button onClick={() => setFileMenuPage('pen')}>ペン <span aria-hidden="true">›</span></button>
            </>}
            {fileMenuPage === 'pen' && <>
            <button onClick={() => setFileMenuPage('settings')}>← 設定</button>
            <div className="menu-section-title">ペン・線の太さの計算方法</div>
            <button onClick={() => {
              changeZoomCompensatedInputWidth(false);
              setOpenMenu(null);
            }}>{!zoomCompensatedInputWidth ? '✓ ' : ''}キャンバス基準</button>
            <button onClick={() => {
              changeZoomCompensatedInputWidth(true);
              setOpenMenu(null);
            }}>{zoomCompensatedInputWidth ? '✓ ' : ''}画面上の指定幅を維持</button>
            </>}
          </div>}
        </div>
        <div className="app-menu">
          <button onClick={() => setOpenMenu(openMenu === 'edit' ? null : 'edit')}>編集</button>
          {openMenu === 'edit' && <div className="app-menu-popup">
            <button onClick={() => { undo(); setOpenMenu(null); }} disabled={!canUndo}>Undo</button>
            <button onClick={() => { redo(); setOpenMenu(null); }} disabled={!canRedo}>Redo</button>
          </div>}
        </div>
        <div className="app-menu">
          <button onClick={() => setOpenMenu(openMenu === 'tools' ? null : 'tools')}>ツール</button>
          {openMenu === 'tools' && <div className="app-menu-popup app-menu-popup-wide">
            <button onClick={() => { setTool('pen'); setOpenMenu(null); }}>ペン</button>
            <button onClick={() => { setTool('eraser'); setOpenMenu(null); }}>消しゴム</button>
            {workspaceMode === 'illustration' && <button onClick={() => { setTool('select'); setOpenMenu(null); }}>選択</button>}
            <div className="menu-section-title">ペンの種類</div>
            {BRUSH_DEFINITIONS.map((definition) => <button key={definition.id} onClick={() => { brushRef.current = definition.id; setBrush(definition.id); setTool('pen'); markDirty(); setOpenMenu(null); }}>{brush === definition.id ? '✓ ' : ''}{definition.label}</button>)}
            <div className="menu-section-title">色プリセット</div>
            {colorPresets.map((preset) => <div className="preset-row" key={preset}>
              <button className="preset-select" onClick={() => { setColor(preset); markDirty(); setOpenMenu(null); }}>
                <span className="color-swatch" style={{ backgroundColor: preset }} />
                <span>{preset.toUpperCase()}</span>
              </button>
              <button className="preset-delete" title={`${preset}を削除`} onClick={() => void window.michikusa.removeMenuPreset({ type: 'color', value: preset }).then(refreshMenuPresets)}>×</button>
            </div>)}
            <button onClick={() => void window.michikusa.addMenuPreset({ type: 'color', value: colorRef.current }).then(refreshMenuPresets)}>現在の色を登録</button>
            <div className="menu-section-title">太さプリセット</div>
            {widthPresets.map((preset) => <div className="preset-row" key={preset}>
              <button className="preset-select" onClick={() => { setLineWidth(preset); markDirty(); setOpenMenu(null); }}>{preset}px</button>
              <button className="preset-delete" title={`${preset}pxを削除`} onClick={() => void window.michikusa.removeMenuPreset({ type: 'width', value: preset }).then(refreshMenuPresets)}>×</button>
            </div>)}
            <button onClick={() => void window.michikusa.addMenuPreset({ type: 'width', value: widthRef.current }).then(refreshMenuPresets)}>現在の太さを登録</button>
          </div>}
        </div>
        <div className="app-menu">
          <button onClick={() => setOpenMenu(openMenu === 'background' ? null : 'background')}>背景</button>
          {openMenu === 'background' && <div className="app-menu-popup app-menu-popup-wide">
            <div className="menu-section-title">背景色</div>
            <button onClick={() => changeBackground('white')}>{backgroundColor === 'white' ? '✓ ' : ''}白</button>
            <button onClick={() => changeBackground('black')}>{backgroundColor === 'black' ? '✓ ' : ''}黒</button>
            <button onClick={() => changeBackground('paper')}>{backgroundColor === 'paper' ? '✓ ' : ''}紙色</button>
            <div className="menu-section-title">模様</div>
            <button onClick={() => changeBackground(undefined, 'plain')}>{backgroundPattern === 'plain' ? '✓ ' : ''}無地</button>
            <button onClick={() => changeBackground(undefined, 'dots')}>{backgroundPattern === 'dots' ? '✓ ' : ''}ドット</button>
            <button onClick={() => changeBackground(undefined, 'ruled')}>{backgroundPattern === 'ruled' ? '✓ ' : ''}罫線</button>
            <button onClick={() => changeBackground(undefined, 'grid')}>{backgroundPattern === 'grid' ? '✓ ' : ''}方眼</button>
            <div className="menu-section-title">模様の間隔</div>
            <label className="background-spacing-control">
              <input
                type="range"
                min={MIN_BACKGROUND_SPACING}
                max={MAX_BACKGROUND_SPACING}
                step={4}
                value={backgroundSpacing}
                onChange={(event) => changeBackgroundSpacing(Number(event.target.value))}
              />
              <span>{backgroundSpacing}</span>
            </label>
          </div>}
        </div>
        <div className="app-menu">
          <button onClick={() => setOpenMenu(openMenu === 'view' ? null : 'view')}>ビュー</button>
          {openMenu === 'view' && <div className="app-menu-popup">
            <button onClick={() => zoomFromMenu(cameraRef.current.zoom * 1.2)}>拡大</button>
            <button onClick={() => zoomFromMenu(cameraRef.current.zoom / 1.2)}>縮小</button>
            <button onClick={() => zoomFromMenu(1)}>リセット（100%）</button>
          </div>}
        </div>
        <div className="app-menu">
          <button onClick={() => setOpenMenu(openMenu === 'window' ? null : 'window')}>ウィンドウ</button>
          {openMenu === 'window' && <div className="app-menu-popup">
            <button onClick={() => void window.michikusa.setFullScreen(true)}>フルスクリーン</button>
            <button onClick={() => void window.michikusa.setFullScreen(false)}>ウィンドウ表示</button>
          </div>}
        </div>
      </nav>
      <header className="toolbar">
        <div className="brand">
          <img className="brand-logo" src="/app-logo.png" alt="" />
          <strong>道草45 Studio</strong>
          <span className="version">v0.00.1</span>
          <button
            type="button"
            className={`mode-switch mode-${workspaceMode}`}
            onClick={switchToNextWorkspaceMode}
            title="クリックしてモードを切り替え"
          >
            {currentWorkspaceMode.label}
          </button>
          <div className="tool-group mode-history-controls">
            <button type="button" className="history-icon-button" onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)" aria-label="Undo">
              ↶
            </button>
            <button type="button" className="history-icon-button" onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Y)" aria-label="Redo">
              ↷
            </button>
          </div>
        </div>

        <div className={`mode-specific-tools mode-tools-${workspaceMode}`}>
        {workspaceMode !== 'review' ? <><div className="tool-group mode-tool-primary">
          <button
            type="button"
            className={tool === 'pen' ? 'active' : ''}
            onClick={() => setTool('pen')}
            title="ペン (P)"
          >
            ペン
          </button>
          <button
            type="button"
            className={tool === 'eraser' ? 'active' : ''}
            onClick={() => setTool('eraser')}
            title="消しゴム (E)"
          >
            消しゴム
          </button>
        </div>

        <div className="tool-group mode-tool-secondary">
          <div className={`color-control color-picker-control${openMenu === 'color-picker' ? ' picker-open' : ''}`} title="線の色">
            <span>色</span>
            <button
              type="button"
              className="color-picker-trigger"
              onClick={() => setOpenMenu(openMenu === 'color-picker' ? null : 'color-picker')}
              aria-label="線の色を選択"
            >
              <span className="color-picker-trigger-swatch" style={{ backgroundColor: color }} />
            </button>
            {openMenu === 'color-picker' && <div className="color-picker-popover">
              {(() => {
                const rgb = hexToRgb(color);
                const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
                return <>
                  <div
                    className="saturation-value-picker"
                    style={{ backgroundColor: `hsl(${hsv.h} 100% 50%)` }}
                    onPointerDown={updateColorFromPalette}
                    onPointerMove={(event) => {
                      if (event.buttons === 1) updateColorFromPalette(event);
                    }}
                  >
                    <span style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }} />
                  </div>
                  <div className="hue-picker-row">
                    <button type="button" className="eyedropper-icon" title="スポイト" aria-label="スポイト" onClick={() => startEyedropper({ kind: 'pen' })}>
                      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m19.4 3.2 1.4 1.4a2 2 0 0 1 0 2.8l-3.1 3.1 1.1 1.1-1.9 1.9-1.1-1.1-7.7 7.7-4.2.7.7-4.2 7.7-7.7-1.1-1.1 1.9-1.9 1.1 1.1 3.1-3.1a2 2 0 0 1 2.8 0ZM6.4 17.5l-.3 1.4 1.4-.3 7-7-1.1-1.1Z" /></svg>
                    </button>
                    <span className="current-color-preview" style={{ backgroundColor: color }} title="キャンバスを右クリックして色を取得" />
                    <input
                      className="hue-slider"
                      type="range"
                      min="0"
                      max="359"
                      value={Math.round(hsv.h)}
                      onChange={(event) => {
                        const next = hsvToRgb(Number(event.target.value), hsv.s, hsv.v);
                        setColor(rgbToHex(next.r, next.g, next.b));
                        markDirty();
                      }}
                      aria-label="色相"
                      style={{ '--selected-hue-color': `hsl(${hsv.h} 100% 50%)` } as React.CSSProperties}
                    />
                  </div>
                </>;
              })()}
              <div className="color-preset-heading">プリセット</div>
              <div className="color-preset-grid">
                {colorPresets.map((preset) => <button
                  type="button"
                  key={preset}
                  className={`color-preset-swatch${preset.toLowerCase() === color.toLowerCase() ? ' selected' : ''}`}
                  style={{ backgroundColor: preset }}
                  onClick={() => {
                    setColor(preset);
                    markDirty();
                    setOpenMenu(null);
                  }}
                  aria-label={`プリセット色 ${preset}`}
                  title="プリセット色"
                />)}
              </div>
              <button type="button" className="register-current-color" onClick={() => void window.michikusa.addMenuPreset({ type: 'color', value: colorRef.current }).then(refreshMenuPresets)}>現在の色を登録</button>
            </div>}
          </div>

          <label className="width-control" title="ペンのサイズ">
            <span>サイズ</span>
            <input
              type="range"
              min="0.1"
              max="24"
              step="0.1"
              value={lineWidth}
              onChange={(event) => {
                setLineWidth(Number(event.target.value));
                markDirty();
              }}
            />
            <output>{lineWidth.toFixed(1)} px</output>
          </label>
        </div></> : <><div className="tool-group mode-tool-primary stamp-toolbar">
          <label>
            <span>スタンプ</span>
            <select value={activeStampDefinitionId} onChange={(event) => {
              const definitionId = event.target.value;
              setToolbarStampDefinitionId(definitionId);
              if (selectedStampId) {
                const definition = review.stampDefinitions.find((item) => item.id === definitionId);
                if (definition?.kind === 'theme' && review.placedStamps.some((stamp) => stamp.definitionId === definitionId && stamp.id !== selectedStampId)) return;
                updateReview((current) => ({ ...current, placedStamps: current.placedStamps.map((stamp) => stamp.id === selectedStampId ? { ...stamp, definitionId } : stamp) }));
              } else {
                setPlacementDefinitionId(definitionId);
                placementDefinitionRef.current = definitionId;
                setSelectedStampId(undefined);
                selectedStampRef.current = undefined;
              }
            }}>
              {review.stampDefinitions.map((definition) => <option key={definition.id} value={definition.id}>{definition.name}</option>)}
            </select>
          </label>
        </div>

        <div className="tool-group mode-tool-secondary stamp-properties">
          <div className={`color-control color-picker-control${openMenu === 'stamp-color-picker' ? ' picker-open' : ''}`} title="スタンプの色">
            <span>色</span>
            <button type="button" className="color-picker-trigger" disabled={!selectedStampDefinition} onClick={() => setOpenMenu(openMenu === 'stamp-color-picker' ? null : 'stamp-color-picker')} aria-label="スタンプの色を選択">
              <span className="color-picker-trigger-swatch" style={{ backgroundColor: selectedStampDefinition?.color ?? '#000000' }} />
            </button>
            {openMenu === 'stamp-color-picker' && selectedStampDefinition && <div className="color-picker-popover">
              {(() => {
                const stampColor = selectedStampDefinition.color;
                const rgb = hexToRgb(stampColor);
                const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
                const applyColor = (nextColor: string): void => updateReview((current) => ({ ...current, stampDefinitions: current.stampDefinitions.map((definition) => definition.id === selectedStampDefinition.id ? { ...definition, color: nextColor } : definition) }));
                const applyHsv = (h: number, s: number, v: number): void => { const next = hsvToRgb(h, s, v); applyColor(rgbToHex(next.r, next.g, next.b)); };
                const updatePalette = (event: React.PointerEvent<HTMLDivElement>): void => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  applyHsv(hsv.h, clamp((event.clientX - rect.left) / rect.width, 0, 1), 1 - clamp((event.clientY - rect.top) / rect.height, 0, 1));
                  event.currentTarget.setPointerCapture(event.pointerId);
                };
                return <>
                  <div className="saturation-value-picker" style={{ backgroundColor: `hsl(${hsv.h} 100% 50%)` }} onPointerDown={updatePalette} onPointerMove={(event) => { if (event.buttons === 1) updatePalette(event); }}>
                    <span style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }} />
                  </div>
                  <div className="hue-picker-row stamp-hue-picker-row">
                    <button type="button" className="eyedropper-icon" title="スポイト" aria-label="スポイト" onClick={() => startEyedropper({ kind: 'stamp', definitionId: selectedStampDefinition.id })}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m19.4 3.2 1.4 1.4a2 2 0 0 1 0 2.8l-3.1 3.1 1.1 1.1-1.9 1.9-1.1-1.1-7.7 7.7-4.2.7.7-4.2 7.7-7.7-1.1-1.1 1.9-1.9 1.1 1.1 3.1-3.1a2 2 0 0 1 2.8 0ZM6.4 17.5l-.3 1.4 1.4-.3 7-7-1.1-1.1Z" /></svg></button>
                    <span className="current-color-preview" style={{ backgroundColor: stampColor }} />
                    <input className="hue-slider" type="range" min="0" max="359" value={Math.round(hsv.h)} onChange={(event) => applyHsv(Number(event.target.value), hsv.s, hsv.v)} aria-label="スタンプの色相" style={{ '--selected-hue-color': `hsl(${hsv.h} 100% 50%)` } as React.CSSProperties} />
                  </div>
                </>;
              })()}
              <div className="color-preset-heading">プリセット</div>
              <div className="color-preset-grid">{colorPresets.map((preset) => <button type="button" key={preset} className={`color-preset-swatch${preset.toLowerCase() === selectedStampDefinition.color.toLowerCase() ? ' selected' : ''}`} style={{ backgroundColor: preset }} onClick={() => { updateReview((current) => ({ ...current, stampDefinitions: current.stampDefinitions.map((definition) => definition.id === selectedStampDefinition.id ? { ...definition, color: preset } : definition) })); setOpenMenu(null); }} aria-label="プリセット色" />)}</div>
              <button type="button" className="register-current-color" onClick={() => void window.michikusa.addMenuPreset({ type: 'color', value: selectedStampDefinition.color }).then(refreshMenuPresets)}>現在の色を登録</button>
            </div>}
          </div>
          <label className="width-control" title="スタンプのサイズ">
            <span>サイズ</span>
            <input type="range" min="12" max="80" step="2" value={selectedStampDefinition?.size ?? DEFAULT_STAMP_SIZE} disabled={!selectedStampDefinition} onInput={(event) => {
              if (selectedStampDefinition) updateReview((current) => ({ ...current, stampDefinitions: current.stampDefinitions.map((definition) => definition.id === selectedStampDefinition.id ? { ...definition, size: Number(event.currentTarget.value) } : definition) }));
            }} />
            <output>{selectedStampDefinition?.size ?? DEFAULT_STAMP_SIZE} px</output>
          </label>
        </div></>}
        </div>

        <div className="tool-group recording-controls">
          <button
            type="button"
            className={recordingState === 'recording' ? 'recording' : ''}
            onClick={() => void startRecording()}
            disabled={recordingState !== 'idle'}
            title="録画開始 (R)"
          >
            ● REC
          </button>
          <button
            type="button"
            onClick={() => void stopRecording()}
            disabled={recordingState !== 'recording'}
            title="録画停止 (R)"
          >
            ■ STOP
          </button>
          {recordingSettings.showDuration && <span className="recording-time">
            {Math.floor(recordingElapsed / 60000)
              .toString()
              .padStart(2, '0')}
            :
            {Math.floor((recordingElapsed % 60000) / 1000)
              .toString()
              .padStart(2, '0')}
          </span>}
          <button
            type="button"
            className={`microphone-toggle ${recordingSettings.microphoneEnabled ? 'microphone-enabled' : 'microphone-disabled'}`}
            onClick={() => setRecordingSettings((settings) => ({ ...settings, microphoneEnabled: !settings.microphoneEnabled }))}
            disabled={recordingState !== 'idle'}
            title={recordingSettings.microphoneEnabled ? 'マイクをオフにする' : 'マイクをオンにする'}
            aria-label={recordingSettings.microphoneEnabled ? 'マイク：オン' : 'マイク：オフ'}
            aria-pressed={recordingSettings.microphoneEnabled}
          >
            {recordingSettings.microphoneEnabled ? '🎙' : '🔇'}
          </button>
          {recordingSettings.showAudioMeter && <div className="audio-meter" title={recordingSettings.microphoneEnabled ? '入力音量' : 'マイクはオフです'}>
            <span style={{ width: `${Math.round(audioLevel * 100)}%` }} />
          </div>}
          <button
            type="button"
            className={showRecordingSettings ? 'active' : ''}
            onClick={() => setShowRecordingSettings((visible) => !visible)}
            disabled={recordingState !== 'idle'}
            title="録画設定"
          >
            ⚙
          </button>
          {showRecordingSettings && <div className="recording-settings-panel">
            <label className="settings-check"><input type="checkbox" checked={recordingSettings.microphoneEnabled} onChange={(event) => setRecordingSettings((settings) => ({ ...settings, microphoneEnabled: event.target.checked }))} />マイク音声を録音</label>
            <label>
              <span>入力音声</span>
              <select disabled={!recordingSettings.microphoneEnabled} value={recordingSettings.audioDeviceId} onChange={(event) => setRecordingSettings((settings) => ({ ...settings, audioDeviceId: event.target.value }))}>
                <option value="">既定のマイク</option>
                {audioDevices.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `マイク ${index + 1}`}</option>)}
              </select>
            </label>
            <label>
              <span>画質</span>
              <select value={recordingSettings.quality} onChange={(event) => setRecordingSettings((settings) => ({ ...settings, quality: event.target.value as RecordingQuality }))}>
                <option value="720p">720p</option>
                <option value="1080p">1080p</option>
                <option value="1440p">1440p</option>
                <option value="4k">4K</option>
              </select>
            </label>
            <label>
              <span>ビットレート</span>
              <select value={recordingSettings.videoBitsPerSecond} onChange={(event) => setRecordingSettings((settings) => ({ ...settings, videoBitsPerSecond: Number(event.target.value) as RecordingSettings['videoBitsPerSecond'] }))}>
                <option value={4_000_000}>4 Mbps</option>
                <option value={8_000_000}>8 Mbps</option>
                <option value={12_000_000}>12 Mbps</option>
                <option value={20_000_000}>20 Mbps</option>
              </select>
            </label>
            <label>
              <span>fps</span>
              <select value={recordingSettings.fps} onChange={(event) => setRecordingSettings((settings) => ({ ...settings, fps: Number(event.target.value) as 30 | 60 }))}>
                <option value={30}>30 fps</option>
                <option value={60}>60 fps</option>
              </select>
            </label>
            <label className="settings-check"><input type="checkbox" checked={recordingSettings.showDuration} onChange={(event) => setRecordingSettings((settings) => ({ ...settings, showDuration: event.target.checked }))} />録画時間を表示</label>
            <label className="settings-check"><input type="checkbox" checked={recordingSettings.showAudioMeter} onChange={(event) => setRecordingSettings((settings) => ({ ...settings, showAudioMeter: event.target.checked }))} />音量メーターを表示</label>
          </div>}
        </div>

        <span className="document-name" title={currentPath}>
          {isDirty ? '● ' : ''}
          {displayName}
        </span>
      </header>

      <div className="whiteboard-shell">
        {workspaceMode === 'illustration' && <LayerPanel
          layers={layers}
          activeLayerId={activeLayerId}
          onSelect={(id) => { activeLayerIdRef.current = id; setActiveLayerId(id); }}
          onToggleVisibility={(id) => updateLayers((current) => current.map((layer) => layer.id === id ? { ...layer, visible: !layer.visible } : layer))}
          onRename={(id, name) => updateLayers((current) => current.map((layer) => layer.id === id ? { ...layer, name } : layer))}
          onAdd={addLayer}
          onDelete={deleteLayer}
        />}
        {workspaceMode === 'illustration' && <IllustrationToolbox
          brush={brush}
          color={color}
          colorPresets={colorPresets}
          opacity={strokeOpacity}
          zoomCompensatedInputWidth={zoomCompensatedInputWidth}
          width={lineWidth}
          tool={tool}
          selectionMode={selectionMode}
          onBrushChange={(nextBrush) => { if (toolRef.current === 'select') { const ids = new Set(selectedEditablesRef.current.filter((item) => item.kind === 'stroke').map((item) => item.id)); strokesRef.current = strokesRef.current.map((stroke) => ids.has(stroke.id) ? { ...stroke, brush: nextBrush } : stroke); window.dispatchEvent(new CustomEvent('michikusa-redraw')); } brushRef.current = nextBrush; setBrush(nextBrush); markDirty(); }}
          onColorChange={(nextColor) => { if (toolRef.current === 'select') { const ids = new Set(selectedEditablesRef.current.filter((item) => item.kind === 'stroke').map((item) => item.id)); strokesRef.current = strokesRef.current.map((stroke) => ids.has(stroke.id) ? { ...stroke, color: nextColor } : stroke); window.dispatchEvent(new CustomEvent('michikusa-redraw')); } colorRef.current = nextColor; setColor(nextColor); markDirty(); }}
          onOpacityChange={(nextOpacity) => { if (toolRef.current === 'select') { const ids = new Set(selectedEditablesRef.current.filter((item) => item.kind === 'stroke').map((item) => item.id)); strokesRef.current = strokesRef.current.map((stroke) => ids.has(stroke.id) ? { ...stroke, opacity: nextOpacity } : stroke); window.dispatchEvent(new CustomEvent('michikusa-redraw')); } opacityRef.current = nextOpacity; setStrokeOpacity(nextOpacity); markDirty(); }}
          onWidthChange={(nextWidth) => { if (toolRef.current === 'select') { const ids = new Set(selectedEditablesRef.current.filter((item) => item.kind === 'stroke').map((item) => item.id)); const storedWidth = nextWidth * (zoomCompensatedInputWidthRef.current ? 1 / cameraRef.current.zoom : 1); strokesRef.current = strokesRef.current.map((stroke) => ids.has(stroke.id) ? { ...stroke, baseWidth: storedWidth } : stroke); window.dispatchEvent(new CustomEvent('michikusa-redraw')); } widthRef.current = nextWidth; setLineWidth(nextWidth); markDirty(); }}
          onToolChange={setTool}
          onSelectionModeChange={(mode) => { selectionModeRef.current = mode; setSelectionMode(mode); }}
          onRegisterColor={() => void window.michikusa.addMenuPreset({ type: 'color', value: colorRef.current }).then(refreshMenuPresets)}
          onStartEyedropper={() => startEyedropper({ kind: 'pen' })}
          onZoomCompensatedInputWidthChange={(enabled) => {
            changeZoomCompensatedInputWidth(enabled);
          }}
        />}
        {workspaceMode === 'review' && (showReviewSummary || showWrapSummary) && <aside className="review-summary-panel" style={{ height: `min(${showWrapSummary ? 560 : reviewSummaryHeight}px, calc(100% - 32px))`, transform: `translate(-50%, -50%) translate(${reviewSummaryPosition.x}px, ${reviewSummaryPosition.y}px)` }}>
          <div className="summary-header" onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            reviewSummaryDragRef.current = { pointerX: event.clientX, pointerY: event.clientY, originX: reviewSummaryPositionRef.current.x, originY: reviewSummaryPositionRef.current.y };
          }} onPointerMove={(event) => {
            const drag = reviewSummaryDragRef.current;
            if (!drag) return;
            const next = { x: drag.originX + event.clientX - drag.pointerX, y: drag.originY + event.clientY - drag.pointerY };
            reviewSummaryPositionRef.current = next;
            setReviewSummaryPosition(next);
            window.dispatchEvent(new CustomEvent('michikusa-redraw'));
          }} onPointerUp={() => { reviewSummaryDragRef.current = undefined; }} onPointerCancel={() => { reviewSummaryDragRef.current = undefined; }}>
            <button type="button" aria-label="画面を閉じる" onPointerDown={(event) => event.stopPropagation()} onClick={() => { setReviewSummaryVisible(false); setWrapSummaryVisible(false); }}>×</button>
          </div>
        </aside>}
        {workspaceMode === 'review' && <ReviewPanel
          review={review}
          selectedDefinitionId={placementDefinitionId}
          onSelect={(definitionId) => {
            setToolbarStampDefinitionId(definitionId);
            if (selectedStampId) {
              const definition = review.stampDefinitions.find((item) => item.id === definitionId);
              if (definition?.kind === 'theme' && review.placedStamps.some((stamp) => stamp.definitionId === definitionId && stamp.id !== selectedStampId)) return;
              updateReview((current) => ({ ...current, placedStamps: current.placedStamps.map((stamp) => stamp.id === selectedStampId ? { ...stamp, definitionId } : stamp) }));
            } else {
              setPlacementDefinitionId(definitionId);
              placementDefinitionRef.current = definitionId;
            }
          }}
          onAddDefinition={addStampDefinition}
          onUpdateDefinition={(definition) => updateReview((current) => ({ ...current, stampDefinitions: current.stampDefinitions.map((item) => item.id === definition.id ? definition : item) }))}
          onDeleteDefinition={deleteStampDefinition}
          onReplaceDefinitions={replaceCustomDefinitions}
          onToggleFarthestPath={() => updateReview((current) => ({ ...current, displaySettings: { ...current.displaySettings, showFarthestPath: !current.displaySettings.showFarthestPath } }))}
          onShowSummary={() => setReviewSummaryVisible(!showReviewSummaryRef.current)}
          onShowWrap={() => setWrapSummaryVisible(!showWrapSummaryRef.current)}
          onExportWrap={() => void exportWrapSummaryPng()}
        />}
        <canvas
          ref={canvasRef}
          className={`whiteboard-canvas ${workspaceMode === 'review' ? 'stamp' : tool}${isSpaceDown ? ' space-pan' : ''}${isPanning ? ' panning' : ''}${isEyedropping ? ' eyedropper' : ''}`}
        />
        {showImageExport && canvasRef.current && <ExportCropOverlay
          canvasWidth={canvasRef.current.clientWidth}
          canvasHeight={canvasRef.current.clientHeight}
          onCancel={() => setShowImageExport(false)}
          onExport={(crop) => void exportCanvasCrop(crop)}
          onPanCanvas={(dx, dy) => {
            cameraRef.current.x += dx;
            cameraRef.current.y += dy;
            window.dispatchEvent(new CustomEvent('michikusa-redraw'));
          }}
        />}
        <div className="status">
          {tool === 'pen' ? 'ペン' : tool === 'eraser' ? '消しゴム' : '選択'} · Zoom {zoomLabel}
          <br />
          {statusMessage}
        </div>
      </div>
    </section>
  );
}
