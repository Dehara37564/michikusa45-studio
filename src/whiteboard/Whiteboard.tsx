import React, { useEffect, useRef, useState } from 'react';
import type {
  Camera,
  LayerDefinition,
  PlacedStamp,
  Point,
  ProjectFile,
  ReviewData,
  StampDefinition,
  Stroke,
  Tool,
} from '../shared/project';
import {
  RecordingManager,
  type RecordingQuality,
  type RecordingSettings,
  type RecordingState,
} from '../recording/RecordingManager';
import { createDefaultReviewData } from '../shared/migration';
import { ReviewPanel } from '../review/ReviewPanel';
import { calculateMichikusa, calculatePercentages } from '../review/analysis';
import { LayerPanel } from '../layers/LayerPanel';

const MIN_ZOOM = 0.15;
const MAX_ZOOM = 8;
const DEFAULT_WIDTH = 3;
const DEFAULT_COLOR = '#202124';
const ERASER_RADIUS_SCREEN = 18;
const MIN_POINT_DISTANCE_SCREEN = 0.45;
const SMOOTHING_DISTANCE_SCREEN = 18;
const DEFAULT_LAYER_ID = 'layer-1';

const createDefaultLayers = (): LayerDefinition[] => [
  { id: DEFAULT_LAYER_ID, name: 'レイヤー1', visible: true, order: 0 },
];

type RecordingUiSettings = RecordingSettings & {
  showDuration: boolean;
  showAudioMeter: boolean;
};

const WORKSPACE_MODES = [
  { id: 'create', label: '思考' },
  { id: 'review', label: '分析' },
] as const;

type WorkspaceMode = (typeof WORKSPACE_MODES)[number]['id'];

const DEFAULT_RECORDING_SETTINGS: RecordingUiSettings = {
  audioDeviceId: '',
  quality: '1080p',
  videoBitsPerSecond: 8_000_000,
  fps: 30,
  showDuration: true,
  showAudioMeter: true,
};

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

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
  const colorInputRef = useRef<HTMLInputElement | null>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const redoRef = useRef<Stroke[]>([]);
  const activeStrokeRef = useRef<Stroke | null>(null);
  const cameraRef = useRef<Camera>({ x: 0, y: 0, zoom: 1 });
  const isSpaceDownRef = useRef(false);
  const isPanningRef = useRef(false);
  const isErasingRef = useRef(false);
  const lastScreenPointRef = useRef<{ x: number; y: number } | null>(null);
  const zoomAnchorRef = useRef<{ x: number; y: number } | null>(null);
  const isPointerOverCanvasRef = useRef(false);
  const createdAtRef = useRef(new Date().toISOString());
  const recordingManagerRef = useRef<RecordingManager | null>(null);
  const recordingStateRef = useRef<RecordingState>('idle');
  const recordingElapsedRef = useRef(0);
  const reviewRef = useRef<ReviewData>(createDefaultReviewData());
  const reviewUndoRef = useRef<ReviewData[]>([]);
  const reviewRedoRef = useRef<ReviewData[]>([]);
  const workspaceModeRef = useRef<WorkspaceMode>('create');
  const placementDefinitionRef = useRef<string | undefined>(undefined);
  const selectedStampRef = useRef<string | undefined>(undefined);
  const draggingStampRef = useRef<string | undefined>(undefined);
  const layersRef = useRef<LayerDefinition[]>(createDefaultLayers());
  const activeLayerIdRef = useRef(DEFAULT_LAYER_ID);
  const showReviewSummaryRef = useRef(false);
  const reviewSummaryPositionRef = useRef({ x: 0, y: 0 });
  const reviewSummaryDragRef = useRef<{ pointerX: number; pointerY: number; originX: number; originY: number } | undefined>(undefined);

  const toolRef = useRef<Tool>('pen');
  const colorRef = useRef(DEFAULT_COLOR);
  const widthRef = useRef(DEFAULT_WIDTH);

  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [lineWidth, setLineWidth] = useState(DEFAULT_WIDTH);
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
  const [reviewSummaryPosition, setReviewSummaryPosition] = useState({ x: 0, y: 0 });
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>('create');
  const [review, setReview] = useState<ReviewData>(createDefaultReviewData);
  const [placementDefinitionId, setPlacementDefinitionId] = useState<string>();
  const [selectedStampId, setSelectedStampId] = useState<string>();
  const [toolbarStampDefinitionId, setToolbarStampDefinitionId] = useState('theme');
  const [layers, setLayers] = useState<LayerDefinition[]>(createDefaultLayers);
  const [activeLayerId, setActiveLayerId] = useState(DEFAULT_LAYER_ID);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
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

  useEffect(() => {
    toolRef.current = tool;
  }, [tool]);

  useEffect(() => {
    colorRef.current = color;
  }, [color]);

  useEffect(() => {
    widthRef.current = lineWidth;
  }, [lineWidth]);

  const buildProject = (): ProjectFile => {
    const now = new Date().toISOString();
    return {
      format: 'm45',
      version: 2,
      createdAt: createdAtRef.current,
      updatedAt: now,
      canvas: {
        background: 'plain',
        strokes: cloneStrokes(strokesRef.current),
        layers,
        activeLayerId,
      },
      camera: { ...cameraRef.current },
      settings: {
        selectedColor: colorRef.current,
        selectedWidth: widthRef.current,
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
      redoRef.current = [];
      activeStrokeRef.current = null;
      cameraRef.current = { ...project.camera };
      createdAtRef.current = project.createdAt;

      setColor(project.settings.selectedColor);
      setLineWidth(project.settings.selectedWidth);
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
    redoRef.current = [];
    activeStrokeRef.current = null;
    cameraRef.current = { x: 0, y: 0, zoom: 1 };
    createdAtRef.current = new Date().toISOString();

    setColor(DEFAULT_COLOR);
    setLineWidth(DEFAULT_WIDTH);
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
      const inheritedSize = current.stampDefinitions.find((definition) => definition.id === toolbarStampDefinitionId)?.size ?? 20;
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
          colorInputRef.current?.click();
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

  const startRecording = async (): Promise<void> => {
    const canvas = canvasRef.current;
    if (!canvas || recordingState !== 'idle') return;

    try {
      setShowRecordingSettings(false);
      const manager = new RecordingManager(canvas, {
        onStateChange: setRecordingState,
        onElapsedChange: setRecordingElapsed,
        onAudioLevelChange: setAudioLevel,
      }, recordingSettings);

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
        `道草45-${stamp}.mp4`,
        {
          videoBitsPerSecond: recordingSettings.videoBitsPerSecond,
          fps: recordingSettings.fps,
        },
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
        return;
      }

      if (!isModifier && key === 'p') setTool('pen');
      if (!isModifier && key === 'e') setTool('eraser');
      if (!isModifier && key === 'r') {
        event.preventDefault();
        if (recordingState === 'idle') void startRecording();
        if (recordingState === 'recording') void stopRecording();
      }
    };

    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.code === 'Space') {
        isSpaceDownRef.current = false;
        isPanningRef.current = false;
        lastScreenPointRef.current = null;
        setIsPanning(false);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
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
      context.strokeStyle = stroke.color;
      context.lineCap = 'round';
      context.lineJoin = 'round';

      const points = stroke.points;

      if (points.length === 2) {
        const pressure = Math.max(
          0.15,
          (points[0].pressure + points[1].pressure) / 2,
        );
        context.lineWidth = stroke.baseWidth * pressure;
        context.beginPath();
        context.moveTo(points[0].x, points[0].y);
        context.lineTo(points[1].x, points[1].y);
        context.stroke();
        context.restore();
        return;
      }

      let segmentStart = points[0];

      for (let index = 1; index < points.length - 1; index += 1) {
        const control = points[index];
        const segmentEnd = midpoint(control, points[index + 1]);
        const pressure = Math.max(
          0.15,
          (segmentStart.pressure + control.pressure + segmentEnd.pressure) / 3,
        );

        context.lineWidth = stroke.baseWidth * pressure;
        context.beginPath();
        context.moveTo(segmentStart.x, segmentStart.y);
        context.quadraticCurveTo(
          control.x,
          control.y,
          segmentEnd.x,
          segmentEnd.y,
        );
        context.stroke();

        segmentStart = segmentEnd;
      }

      const last = points[points.length - 1];
      const beforeLast = points[points.length - 2];
      context.lineWidth =
        stroke.baseWidth *
        Math.max(0.15, (beforeLast.pressure + last.pressure) / 2);
      context.beginPath();
      context.moveTo(segmentStart.x, segmentStart.y);
      context.quadraticCurveTo(
        beforeLast.x,
        beforeLast.y,
        last.x,
        last.y,
      );
      context.stroke();

      context.restore();
    };

    const drawReviewOverlay = (): void => {
      const current = reviewRef.current;
      const camera = cameraRef.current;
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
          context.strokeStyle = '#f97316';
          context.lineWidth = 4;
          context.setLineDash([10, 6]);
          context.shadowColor = 'rgba(249, 115, 22, .45)';
          context.shadowBlur = 5;
          context.beginPath();
          context.moveTo(themeX, themeY);
          context.lineTo(farthestX, farthestY);
          context.stroke();
          context.setLineDash([]);
          context.shadowBlur = 0;
          context.fillStyle = '#f97316';
          for (const point of [{ x: themeX, y: themeY }, { x: farthestX, y: farthestY }]) {
            context.beginPath();
            context.arc(point.x, point.y, 6, 0, Math.PI * 2);
            context.fill();
          }
          const middleX = (themeX + farthestX) / 2;
          const middleY = (themeY + farthestY) / 2;
          const valueLabel = `道草値 ${michikusa.value}`;
          context.font = '700 15px sans-serif';
          const labelWidth = context.measureText(valueLabel).width;
          context.fillStyle = 'rgba(255, 255, 255, .96)';
          context.strokeStyle = '#f97316';
          context.lineWidth = 2;
          context.beginPath();
          context.roundRect(middleX - labelWidth / 2 - 9, middleY - 15, labelWidth + 18, 30, 8);
          context.fill();
          context.stroke();
          context.fillStyle = '#9a3412';
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
        const michikusa = calculateMichikusa(current.stampDefinitions, current.placedStamps);
        const panelWidth = Math.min(560, canvas.clientWidth - 32);
        const panelHeight = Math.min(Math.max(400, 255 + percentages.length * 30), canvas.clientHeight - 32);
        const position = reviewSummaryPositionRef.current;
        const panelX = canvas.clientWidth / 2 - panelWidth / 2 + position.x;
        const panelY = canvas.clientHeight / 2 - panelHeight / 2 + position.y;
        context.save();
        context.shadowColor = 'rgba(0,0,0,.25)';
        context.shadowBlur = 18;
        context.fillStyle = '#ffffff';
        context.strokeStyle = '#9ca3af';
        context.lineWidth = 1.5;
        context.beginPath();
        context.roundRect(panelX, panelY, panelWidth, panelHeight, 14);
        context.fill();
        context.shadowBlur = 0;
        context.stroke();
        context.fillStyle = '#111827';
        context.textAlign = 'left';
        context.textBaseline = 'alphabetic';
        context.font = '700 32px sans-serif';
        context.fillText('今回のまとめ', panelX + 26, panelY + 48);
        context.fillStyle = '#ffffff';
        context.strokeStyle = '#9ca3af';
        context.lineWidth = 1.5;
        context.beginPath();
        context.roundRect(panelX + panelWidth - 52, panelY + 14, 38, 38, 8);
        context.fill();
        context.stroke();
        context.strokeStyle = '#374151';
        context.lineWidth = 2.5;
        context.beginPath();
        context.moveTo(panelX + panelWidth - 38, panelY + 25);
        context.lineTo(panelX + panelWidth - 24, panelY + 39);
        context.moveTo(panelX + panelWidth - 24, panelY + 25);
        context.lineTo(panelX + panelWidth - 38, panelY + 39);
        context.stroke();
        context.font = '700 20px sans-serif';
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
        context.font = '18px sans-serif';
        percentages.slice(0, 8).forEach(({ definition, count, percentage }, index) => {
          const rowY = panelY + 129 + index * 30;
          context.fillStyle = definition.color;
          context.beginPath();
          context.arc(panelX + 235, rowY - 6, 8, 0, Math.PI * 2);
          context.fill();
          context.fillStyle = '#111827';
          context.fillText(`${definition.name}  ${count}件（${percentage}%）`, panelX + 252, rowY);
        });
        const footerY = panelY + panelHeight - 48;
        context.fillStyle = '#111827';
        context.font = '18px sans-serif';
        const largest = percentages[0];
        context.fillText(largest ? `最大割合：${largest.definition.name}（${largest.percentage}%）` : '使用したスタンプはありません', panelX + 20, footerY - 24);
        context.font = '700 28px sans-serif';
        context.fillStyle = '#9a3412';
        context.fillText(`道草値 ${michikusa.available ? michikusa.value : '計算不可'}`, panelX + 20, footerY + 8);
        context.restore();
      };

      current.placedStamps.forEach((stamp) => {
        const definition = current.stampDefinitions.find((item) => item.id === stamp.definitionId);
        if (!definition) return;
        const x = camera.x + stamp.x * camera.zoom;
        const y = camera.y + stamp.y * camera.zoom;
        // Stamp dimensions are screen pixels, intentionally independent of camera zoom.
        const stampSize = definition.size ?? 20;
        const radius = stampSize / 2;
        context.save();
        context.fillStyle = `${definition.color}cc`;
        context.strokeStyle = selectedStampRef.current === stamp.id ? '#111827' : definition.color;
        context.lineWidth = selectedStampRef.current === stamp.id ? 3 : 1.5;
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
        context.fillStyle = '#111827';
        const stampFontSize = Math.max(14, Math.round(stampSize * 0.8));
        context.font = `600 ${stampFontSize}px sans-serif`;
        context.fillText(definition.name, x + radius + 5, y + stampFontSize * 0.35);
        context.restore();
      });
      drawFarthestPath();
      drawSummaryOverlay();
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
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, logicalWidth, logicalHeight);
      const visibleLayerIds = new Set(layersRef.current.filter((layer) => layer.visible !== false).map((layer) => layer.id));
      strokesRef.current.forEach((stroke) => {
        if (visibleLayerIds.has(stroke.layerId ?? DEFAULT_LAYER_ID)) drawStroke(stroke);
      });
      if (activeStrokeRef.current) drawStroke(activeStrokeRef.current);
      drawReviewOverlay();
      context.restore();
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
          : 0.65;

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
      const radiusWorld = ERASER_RADIUS_SCREEN / cameraRef.current.zoom;
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

      if (isSpaceDownRef.current || event.button === 1) {
        isPanningRef.current = true;
        lastScreenPointRef.current = screen;
        setIsPanning(true);
        return;
      }

      if (event.button !== 0) return;

      const world = screenToWorld(screen.x, screen.y);

      if (workspaceModeRef.current === 'review') {
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
          const hitRadius = (definition?.size ?? 20) / 2 + 4;
          return Math.hypot(stamp.x - world.x, stamp.y - world.y) * cameraRef.current.zoom <= hitRadius;
        });
        setSelectedStampId(hit?.id);
        selectedStampRef.current = hit?.id;
        if (hit) setToolbarStampDefinitionId(hit.definitionId);
        draggingStampRef.current = hit?.id;
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
          : 0.65;

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
        baseWidth: widthRef.current,
        layerId: drawableLayerId,
        points: [world],
      };
    };

    const onPointerMove = (event: PointerEvent): void => {
      rememberPointerPosition(event);
      const screen = pointerPosition(event);

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

      if (isErasingRef.current) {
        isErasingRef.current = false;
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
      if (workspaceModeRef.current !== 'review') return;
      event.preventDefault();
      setPlacementDefinitionId(undefined);
      placementDefinitionRef.current = undefined;
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
    const currentIndex = WORKSPACE_MODES.findIndex((mode) => mode.id === workspaceMode);
    const nextMode = WORKSPACE_MODES[(currentIndex + 1) % WORKSPACE_MODES.length];
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
          <button onClick={() => setOpenMenu(openMenu === 'file' ? null : 'file')}>ファイル</button>
          {openMenu === 'file' && <div className="app-menu-popup">
            <button onClick={() => { newProject(); setOpenMenu(null); }}>新規 <kbd>Ctrl+N</kbd></button>
            <button onClick={() => { void openProject(); setOpenMenu(null); }}>開く <kbd>Ctrl+O</kbd></button>
            <button onClick={() => { void save(false); setOpenMenu(null); }}>保存 <kbd>Ctrl+S</kbd></button>
            <button onClick={() => { void save(true); setOpenMenu(null); }}>名前を付けて保存</button>
            <button onClick={() => void window.michikusa.quit()}>終了</button>
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
        </div>

        <div className="mode-specific-tools">
        {workspaceMode === 'create' ? <><div className="tool-group mode-tool-primary">
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
          <label className="color-control" title="線の色">
            <span>色</span>
            <input
              ref={colorInputRef}
              type="color"
              value={color}
              onChange={(event) => {
                setColor(event.target.value);
                markDirty();
              }}
            />
          </label>

          <label className="width-control" title="ペンのサイズ">
            <span>サイズ</span>
            <input
              type="range"
              min="1"
              max="24"
              step="0.5"
              value={lineWidth}
              onChange={(event) => {
                setLineWidth(Number(event.target.value));
                markDirty();
              }}
            />
            <output>{lineWidth.toFixed(1)}</output>
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
          <label className="color-control" title="スタンプの色">
            <span>色</span>
            <input type="color" value={selectedStampDefinition?.color ?? '#000000'} disabled={!selectedStampDefinition} onChange={(event) => {
              if (selectedStampDefinition) updateReview((current) => ({ ...current, stampDefinitions: current.stampDefinitions.map((definition) => definition.id === selectedStampDefinition.id ? { ...definition, color: event.target.value } : definition) }));
            }} />
          </label>
          <label className="width-control" title="スタンプのサイズ">
            <span>サイズ</span>
            <input type="range" min="12" max="80" step="2" value={selectedStampDefinition?.size ?? 20} disabled={!selectedStampDefinition} onInput={(event) => {
              if (selectedStampDefinition) updateReview((current) => ({ ...current, stampDefinitions: current.stampDefinitions.map((definition) => definition.id === selectedStampDefinition.id ? { ...definition, size: Number(event.currentTarget.value) } : definition) }));
            }} />
            <output>{selectedStampDefinition?.size ?? 20}</output>
          </label>
        </div></>}
        </div>

        <div className="tool-group">
          <button type="button" onClick={undo} disabled={!canUndo} title="Ctrl+Z">
            Undo
          </button>
          <button type="button" onClick={redo} disabled={!canRedo} title="Ctrl+Y">
            Redo
          </button>
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
          {recordingSettings.showAudioMeter && <div className="audio-meter" title="入力音量">
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
            <label>
              <span>入力音声</span>
              <select value={recordingSettings.audioDeviceId} onChange={(event) => setRecordingSettings((settings) => ({ ...settings, audioDeviceId: event.target.value }))}>
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
        {workspaceMode === 'create' && <LayerPanel
          layers={layers}
          activeLayerId={activeLayerId}
          onSelect={(id) => { activeLayerIdRef.current = id; setActiveLayerId(id); }}
          onToggleVisibility={(id) => updateLayers((current) => current.map((layer) => layer.id === id ? { ...layer, visible: !layer.visible } : layer))}
          onRename={(id, name) => updateLayers((current) => current.map((layer) => layer.id === id ? { ...layer, name } : layer))}
          onAdd={addLayer}
          onDelete={deleteLayer}
        />}
        {workspaceMode === 'review' && showReviewSummary && <aside className="review-summary-panel" style={{ height: `min(${reviewSummaryHeight}px, calc(100% - 32px))`, transform: `translate(-50%, -50%) translate(${reviewSummaryPosition.x}px, ${reviewSummaryPosition.y}px)` }}>
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
            <button type="button" aria-label="今回のまとめを閉じる" onPointerDown={(event) => event.stopPropagation()} onClick={() => setReviewSummaryVisible(false)}>×</button>
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
        />}
        <canvas
          ref={canvasRef}
          className={`whiteboard-canvas ${workspaceMode === 'review' ? 'stamp' : tool}${isPanning ? ' panning' : ''}`}
        />
        <div className="status">
          {tool === 'pen' ? 'ペン' : '消しゴム'} · Zoom {zoomLabel}
          <br />
          {statusMessage}
        </div>
      </div>
    </section>
  );
}
