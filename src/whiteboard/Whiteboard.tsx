import React, { useEffect, useRef, useState } from 'react';
import type {
  Camera,
  Point,
  ProjectFile,
  Stroke,
  Tool,
} from '../shared/project';
import {
  RecordingManager,
  type RecordingState,
} from '../recording/RecordingManager';

const MIN_ZOOM = 0.15;
const MAX_ZOOM = 8;
const DEFAULT_WIDTH = 3;
const DEFAULT_COLOR = '#202124';
const ERASER_RADIUS_SCREEN = 18;
const MIN_POINT_DISTANCE_SCREEN = 0.45;
const SMOOTHING_DISTANCE_SCREEN = 18;

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
      version: 1,
      createdAt: createdAtRef.current,
      updatedAt: now,
      canvas: {
        background: 'plain',
        strokes: cloneStrokes(strokesRef.current),
      },
      camera: { ...cameraRef.current },
      settings: {
        selectedColor: colorRef.current,
        selectedWidth: widthRef.current,
      },
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
      strokesRef.current = cloneStrokes(project.canvas.strokes);
      redoRef.current = [];
      activeStrokeRef.current = null;
      cameraRef.current = { ...project.camera };
      createdAtRef.current = project.createdAt;

      setColor(project.settings.selectedColor);
      setLineWidth(project.settings.selectedWidth);
      setZoomLabel(`${Math.round(project.camera.zoom * 100)}%`);
      setCurrentPath(result.filePath);
      setIsDirty(false);
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
    setStatusMessage('新しいプロジェクト');
    requestHistoryRefresh();
    window.dispatchEvent(new CustomEvent('michikusa-redraw'));
  };

  const undo = (): void => {
    const last = strokesRef.current.pop();
    if (!last) return;
    redoRef.current.push(last);
    markDirty();
    requestHistoryRefresh();
    window.dispatchEvent(new CustomEvent('michikusa-redraw'));
  };

  const redo = (): void => {
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
      const manager = new RecordingManager(canvas, {
        onStateChange: setRecordingState,
        onElapsedChange: setRecordingElapsed,
      });

      recordingManagerRef.current = manager;
      await manager.start();
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

    const redraw = (): void => {
      const rect = canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;

      context.save();
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.restore();

      context.save();
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, rect.width, rect.height);
      strokesRef.current.forEach(drawStroke);
      if (activeStrokeRef.current) drawStroke(activeStrokeRef.current);
      context.restore();
    };

    const resize = (): void => {
      const rect = canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(rect.width * ratio));
      canvas.height = Math.max(1, Math.round(rect.height * ratio));
      redraw();
    };

    const clientToCanvasPosition = (
      clientX: number,
      clientY: number,
    ): { x: number; y: number } => {
      const rect = canvas.getBoundingClientRect();
      return { x: clientX - rect.left, y: clientY - rect.top };
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
      const previousLength = strokesRef.current.length;

      strokesRef.current = strokesRef.current.filter((stroke) => {
        if (stroke.points.length === 1) {
          return (
            Math.hypot(
              world.x - stroke.points[0].x,
              world.y - stroke.points[0].y,
            ) > radiusWorld
          );
        }

        for (let index = 1; index < stroke.points.length; index += 1) {
          const distance = distancePointToSegment(
            world,
            stroke.points[index - 1],
            stroke.points[index],
          );
          if (distance <= radiusWorld + stroke.baseWidth / 2) return false;
        }
        return true;
      });

      if (strokesRef.current.length !== previousLength) {
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

      if (toolRef.current === 'eraser') {
        isErasingRef.current = true;
        eraseAt(world);
        return;
      }

      world.pressure =
        event.pointerType === 'pen' && event.pressure > 0
          ? event.pressure
          : 0.65;

      activeStrokeRef.current = {
        id: makeId(),
        color: colorRef.current,
        baseWidth: widthRef.current,
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

      if (isErasingRef.current) {
        const events = event.getCoalescedEvents?.() ?? [event];
        for (const coalesced of events) {
          const position = pointerPosition(coalesced);
          eraseAt(screenToWorld(position.x, position.y));
        }
        return;
      }

      const stroke = activeStrokeRef.current;
      if (!stroke) return;

      const events = event.getCoalescedEvents?.() ?? [event];
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

    const onExternalRedraw = (): void => redraw();

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    canvas.addEventListener('pointerenter', onPointerEnter);
    canvas.addEventListener('pointerleave', onPointerLeave);
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', finishPointer);
    canvas.addEventListener('pointercancel', finishPointer);

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
      window.removeEventListener('wheel', onWheel, true);
      window.removeEventListener('blur', onWindowBlur);
      window.removeEventListener('michikusa-redraw', onExternalRedraw);
    };
  }, []);

  const canUndo = strokesRef.current.length > 0;
  const canRedo = redoRef.current.length > 0;
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
        </div>

        <div className="tool-group">
          <button type="button" onClick={newProject} title="Ctrl+N">
            新規
          </button>
          <button type="button" onClick={() => void openProject()} title="Ctrl+O">
            開く
          </button>
          <button type="button" onClick={() => void save(false)} title="Ctrl+S">
            保存
          </button>
          <button
            type="button"
            onClick={() => void save(true)}
            title="Ctrl+Shift+S"
          >
            名前を付けて保存
          </button>
        </div>

        <div className="tool-group">
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

        <div className="tool-group">
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

          <label className="width-control" title="線の太さ">
            <span>太さ</span>
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
          <span className="recording-time">
            {Math.floor(recordingElapsed / 60000)
              .toString()
              .padStart(2, '0')}
            :
            {Math.floor((recordingElapsed % 60000) / 1000)
              .toString()
              .padStart(2, '0')}
          </span>
        </div>

        <span className="document-name" title={currentPath}>
          {isDirty ? '● ' : ''}
          {displayName}
        </span>
      </header>

      <div className="whiteboard-shell">
        <canvas
          ref={canvasRef}
          className={`whiteboard-canvas ${tool}${isPanning ? ' panning' : ''}`}
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
