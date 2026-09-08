import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  session,
  type MenuItemConstructorOptions,
} from 'electron';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, promises as fs, type WriteStream } from 'node:fs';
import type {
  OpenProjectResult,
  ProjectFile,
  ReadableProjectFile,
  SaveProjectResult,
} from './shared/project';
import { migrateProject } from './shared/migration';
import type { SaveRecordingResult, StartRecordingConversionResult } from './shared/recording';
import type { MenuCommand, MenuPreset } from './shared/menu';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;

const PROJECT_FILTER = {
  name: '道草45 Project',
  extensions: ['m45'],
};

const getFfmpegPath = (): string =>
  app.isPackaged
    ? path.join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe')
    : path.join(process.cwd(), 'assets', 'ffmpeg', 'ffmpeg.exe');

const buildAviOutputArguments = (
  fps: 30 | 60,
  withAudio: boolean,
  outputWidth: number,
  outputHeight: number,
  mjpegQuality: 1 | 3 | 5,
): string[] => [
  '-map',
  '0:v:0',
  '-vf',
  `scale=${outputWidth}:${outputHeight}:flags=lanczos+accurate_rnd+full_chroma_int:force_original_aspect_ratio=increase:out_range=tv,crop=${outputWidth}:${outputHeight},setsar=1,format=yuv422p,fps=${fps}`,
  '-fps_mode',
  'cfr',
  '-c:v',
  'mjpeg',
  '-strict',
  'unofficial',
  '-q:v',
  String(mjpegQuality),
  '-pix_fmt',
  'yuv422p',
  '-color_range',
  'tv',
  ...(withAudio ? [
    '-map', '0:a:0', '-af', 'apad', '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2',
    '-shortest_buf_duration', '0.5', '-shortest',
  ] : []),
];

const convertWebmToAvi = async (
  inputPath: string,
  outputPath: string,
  fps: 30 | 60,
  withAudio: boolean,
  durationMilliseconds: number | null,
  outputWidth: number,
  outputHeight: number,
  mjpegQuality: 1 | 3 | 5 = 3,
): Promise<void> => {
  const ffmpegPath = getFfmpegPath();
  await fs.access(ffmpegPath);

  await new Promise<void>((resolve, reject) => {
    const inputArguments = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      inputPath,
      ...buildAviOutputArguments(fps, withAudio, outputWidth, outputHeight, mjpegQuality),
    ];
    const process = spawn(ffmpegPath, [
      ...inputArguments,
      ...(durationMilliseconds === null ? [] : [
        '-t',
        Math.max(0.001, durationMilliseconds / 1000).toFixed(3),
      ]),
      outputPath,
    ], { windowsHide: true });

    let stderr = '';
    process.stderr.setEncoding('utf8');
    process.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-16_384);
    });
    process.once('error', reject);
    process.once('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `AVI conversion failed (exit code ${code ?? 'unknown'}).${
            stderr ? `\n${stderr.trim()}` : ''
          }`,
        ),
      );
    });
  });
};

type RecordingConversionSession = {
  process: ReturnType<typeof spawn>;
  outputPath: string;
  completed: Promise<void>;
  recoveryPath: string;
  recoveryStream: WriteStream;
  recoveryCompleted: Promise<void>;
  fps: 30 | 60;
  withAudio: boolean;
  outputWidth: number;
  outputHeight: number;
  mjpegQuality: 1 | 3 | 5;
  error?: Error;
  recoveryError?: Error;
};

const recordingConversionSessions = new Map<string, RecordingConversionSession>();
const MAX_FFMPEG_INPUT_BUFFER_BYTES = 64 * 1024 * 1024;

const writeBuffer = async (stream: WriteStream, buffer: Buffer): Promise<void> => {
  if (stream.destroyed || !stream.writable) {
    throw new Error('録画復旧データへの書き込みが終了しています。');
  }
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    stream.once('error', onError);
    const finish = (): void => {
      stream.removeListener('error', onError);
      resolve();
    };
    if (stream.write(buffer)) finish();
    else stream.once('drain', finish);
  });
};

const stopLiveConversion = (
  conversion: RecordingConversionSession,
  error: Error,
): void => {
  if (!conversion.error) conversion.error = error;
  conversion.process.stdin?.destroy();
  if (conversion.process.exitCode === null) conversion.process.kill();
};

const startRecordingConversion = async (
  fps: 30 | 60,
  withAudio: boolean,
  outputWidth: number,
  outputHeight: number,
  mjpegQuality: 1 | 3 | 5,
  suggestedName: string,
): Promise<StartRecordingConversionResult> => {
  const saveResult = await dialog.showSaveDialog({
    title: '録画の保存先を選択',
    defaultPath: suggestedName,
    filters: [{ name: 'AVI video', extensions: ['avi'] }],
  });
  if (saveResult.canceled || !saveResult.filePath) return { canceled: true };
  const outputPath = saveResult.filePath.toLowerCase().endsWith('.avi')
    ? saveResult.filePath
    : `${saveResult.filePath}.avi`;
  const ffmpegPath = getFfmpegPath();
  await fs.access(ffmpegPath);
  const id = randomUUID();
  const recoveryPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.${id}.recovery.webm`,
  );
  const recoveryStream = createWriteStream(recoveryPath, { flags: 'wx' });
  const process = spawn(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', 'pipe:0',
    ...buildAviOutputArguments(fps, withAudio, outputWidth, outputHeight, mjpegQuality),
    outputPath,
  ], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  if (process.pid) {
    try {
      os.setPriority(process.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
    } catch {
      // Priority adjustment is an optimization; conversion can continue without it.
    }
  }
  let stderr = '';
  process.stderr?.setEncoding('utf8');
  process.stderr?.on('data', (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-16_384);
  });
  let session: RecordingConversionSession;
  const recoveryCompleted = new Promise<void>((resolve) => {
    recoveryStream.once('error', (error) => {
      session.recoveryError = error;
      resolve();
    });
    recoveryStream.once('finish', resolve);
    recoveryStream.once('close', resolve);
  });
  const completed = new Promise<void>((resolve) => {
    process.once('error', (error) => {
      session.error = error;
      resolve();
    });
    process.once('close', (code) => {
      if (code !== 0 && !session.error) {
        session.error = new Error(`AVI conversion failed (exit code ${code ?? 'unknown'}).${stderr ? `\n${stderr.trim()}` : ''}`);
      }
      resolve();
    });
  });
  session = {
    process,
    outputPath,
    completed,
    recoveryPath,
    recoveryStream,
    recoveryCompleted,
    fps,
    withAudio,
    outputWidth,
    outputHeight,
    mjpegQuality,
  };
  process.stdin?.on('error', (error) => {
    stopLiveConversion(session, error);
  });
  recordingConversionSessions.set(id, session);
  return { canceled: false, id, filePath: outputPath };
};

const discardRecordingConversion = async (id: string): Promise<void> => {
  const conversion = recordingConversionSessions.get(id);
  if (!conversion) return;
  recordingConversionSessions.delete(id);
  if (!conversion.recoveryStream.destroyed) conversion.recoveryStream.destroy();
  conversion.process.stdin?.destroy();
  if (conversion.process.exitCode === null) conversion.process.kill();
  await Promise.all([conversion.completed, conversion.recoveryCompleted]);
  await fs.rm(conversion.outputPath, { force: true }).catch(() => undefined);
  await fs.rm(conversion.recoveryPath, { force: true }).catch(() => undefined);
};

type MenuPresets = {
  colors: string[];
  widths: number[];
};

const menuPresets: MenuPresets = { colors: [], widths: [] };

const getMenuPresetsPath = (): string =>
  path.join(app.getPath('userData'), 'menu-presets.json');

const saveMenuPresets = async (): Promise<void> => {
  await fs.writeFile(
    getMenuPresetsPath(),
    JSON.stringify(menuPresets, null, 2),
    'utf8',
  );
};

const loadMenuPresets = async (): Promise<void> => {
  try {
    const parsed: unknown = JSON.parse(
      await fs.readFile(getMenuPresetsPath(), 'utf8'),
    );
    if (!parsed || typeof parsed !== 'object') return;

    const candidate = parsed as Partial<MenuPresets>;
    menuPresets.colors = Array.isArray(candidate.colors)
      ? candidate.colors.filter(
          (color): color is string =>
            typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color),
        )
      : [];
    menuPresets.widths = Array.isArray(candidate.widths)
      ? candidate.widths.filter(
          (width): width is number =>
            typeof width === 'number' && width >= 1 && width <= 20,
        )
      : [];
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') console.error('Failed to load menu presets.', error);
  }
};

const createColorSwatch = (color: string): Electron.NativeImage => {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">',
    '<rect x="0.5" y="0.5" width="15" height="15" rx="3"',
    ` fill="${color}" stroke="#808080"/>`,
    '</svg>',
  ].join('');
  return nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
  );
};

const removeMenuPreset = async (preset: MenuPreset): Promise<void> => {
  if (preset.type === 'color') {
    menuPresets.colors = menuPresets.colors.filter(
      (color) => color !== preset.value,
    );
  } else {
    menuPresets.widths = menuPresets.widths.filter(
      (width) => width !== preset.value,
    );
  }
  await saveMenuPresets();
};

const sendMenuCommand = (command: MenuCommand): void => {
  BrowserWindow.getFocusedWindow()?.webContents.send('menu:command', command);
};

const installApplicationMenu = (): void => {
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'ファイル',
      submenu: [
        {
          label: '新規',
          accelerator: 'CmdOrCtrl+N',
          click: () => sendMenuCommand({ type: 'project:new' }),
        },
        {
          label: '開く',
          accelerator: 'CmdOrCtrl+O',
          click: () => sendMenuCommand({ type: 'project:open' }),
        },
        { type: 'separator' },
        {
          label: '保存',
          accelerator: 'CmdOrCtrl+S',
          click: () => sendMenuCommand({ type: 'project:save' }),
        },
        {
          label: '名前を付けて保存',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => sendMenuCommand({ type: 'project:save-as' }),
        },
        { type: 'separator' },
        { label: '終了', role: 'quit' },
      ],
    },
    {
      label: '編集',
      submenu: [
        {
          label: 'Undo',
          accelerator: 'CmdOrCtrl+Z',
          click: () => sendMenuCommand({ type: 'edit:undo' }),
        },
        {
          label: 'Redo',
          accelerator: 'CmdOrCtrl+Y',
          click: () => sendMenuCommand({ type: 'edit:redo' }),
        },
      ],
    },
    {
      label: 'ツール',
      submenu: [
        {
          label: 'ペン',
          accelerator: 'P',
          click: () =>
            sendMenuCommand({ type: 'tool:select', tool: 'pen' }),
        },
        {
          label: '消しゴム',
          accelerator: 'E',
          click: () =>
            sendMenuCommand({ type: 'tool:select', tool: 'eraser' }),
        },
        { type: 'separator' },
        {
          label: '色',
          submenu: [
            ...menuPresets.colors.map((color) => ({
              label: color.toUpperCase(),
              icon: createColorSwatch(color),
              submenu: [
                {
                  label: '選択',
                  click: () => sendMenuCommand({ type: 'tool:color', color }),
                },
                {
                  label: '削除',
                  click: () => {
                    void removeMenuPreset({ type: 'color', value: color });
                  },
                },
              ],
            })),
            ...(menuPresets.colors.length > 0
              ? [{ type: 'separator' as const }]
              : []),
            {
              label: '現在の色をプリセットに登録',
              click: () => sendMenuCommand({ type: 'tool:register-color' }),
            },
          ],
        },
        {
          label: '太さ',
          submenu: [
            ...menuPresets.widths.map((width) => ({
              label: `${width}px`,
              submenu: [
                {
                  label: '選択',
                  click: () => sendMenuCommand({ type: 'tool:width', width }),
                },
                {
                  label: '削除',
                  click: () => {
                    void removeMenuPreset({ type: 'width', value: width });
                  },
                },
              ],
            })),
            ...(menuPresets.widths.length > 0
              ? [{ type: 'separator' as const }]
              : []),
            {
              label: '現在の太さをプリセットに登録',
              click: () => sendMenuCommand({ type: 'tool:register-width' }),
            },
          ],
        },
      ],
    },
    {
      label: 'ビュー',
      submenu: [
        {
          label: '拡大',
          accelerator: 'CmdOrCtrl+=',
          click: () => sendMenuCommand({ type: 'view:zoom-in' }),
        },
        {
          label: '縮小',
          accelerator: 'CmdOrCtrl+-',
          click: () => sendMenuCommand({ type: 'view:zoom-out' }),
        },
        {
          label: 'リセット（100%）',
          accelerator: 'CmdOrCtrl+0',
          click: () => sendMenuCommand({ type: 'view:reset-zoom' }),
        },
      ],
    },
    {
      label: 'ウィンドウ',
      submenu: [
        {
          label: 'フルスクリーン',
          accelerator: 'F11',
          click: () => BrowserWindow.getFocusedWindow()?.setFullScreen(true),
        },
        {
          label: 'ウィンドウ表示',
          click: () => BrowserWindow.getFocusedWindow()?.setFullScreen(false),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
};

ipcMain.handle('menu:add-preset', async (_event, preset: MenuPreset) => {
  if (preset.type === 'color') {
    if (!/^#[0-9a-f]{6}$/i.test(preset.value)) return;
    if (!menuPresets.colors.includes(preset.value)) {
      menuPresets.colors.push(preset.value);
    }
  } else {
    if (!Number.isFinite(preset.value) || preset.value < 0.1 || preset.value > 48) {
      return;
    }
    if (!menuPresets.widths.includes(preset.value)) {
      menuPresets.widths.push(preset.value);
      menuPresets.widths.sort((first, second) => first - second);
    }
  }

  await saveMenuPresets();
});

ipcMain.handle('menu:get-presets', () => ({
  colors: [...menuPresets.colors],
  widths: [...menuPresets.widths],
}));

ipcMain.handle('menu:remove-preset', async (_event, preset: MenuPreset) => {
  await removeMenuPreset(preset);
});

ipcMain.handle('window:set-fullscreen', (_event, fullScreen: boolean) => {
  BrowserWindow.getFocusedWindow()?.setFullScreen(fullScreen);
});

ipcMain.handle('window:is-fullscreen', () =>
  BrowserWindow.getFocusedWindow()?.isFullScreen() ?? false,
);

ipcMain.handle('app:quit', () => app.quit());

const isProjectFile = (value: unknown): value is ReadableProjectFile => {
  if (!value || typeof value !== 'object') return false;

  const project = value as Partial<ReadableProjectFile> & {
    review?: ProjectFile['review'];
  };
  return (
    project.format === 'm45' &&
    (project.version === 1 || project.version === 2) &&
    !!project.canvas &&
    Array.isArray(project.canvas.strokes) &&
    !!project.camera &&
    typeof project.camera.x === 'number' &&
    typeof project.camera.y === 'number' &&
    typeof project.camera.zoom === 'number' &&
    !!project.settings &&
    typeof project.settings.selectedColor === 'string' &&
    typeof project.settings.selectedWidth === 'number' &&
    (project.version === 1 ||
      (!!project.review &&
        Array.isArray(project.review.stampDefinitions) &&
        Array.isArray(project.review.placedStamps)))
  );
};

const createWindow = (): void => {
  const windowIcon = app.isPackaged
    ? path.join(process.resourcesPath, 'app-icon.png')
    : path.join(app.getAppPath(), 'assets', 'app-icon.png');
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 540,
    backgroundColor: '#ffffff',
    icon: windowIcon,
    title: '道草45 Studio',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  let allowCloseWithIncompleteRecording = false;
  let closeConfirmationOpen = false;
  win.on('close', (event) => {
    if (allowCloseWithIncompleteRecording || recordingConversionSessions.size === 0) return;
    event.preventDefault();
    if (closeConfirmationOpen) return;
    closeConfirmationOpen = true;
    void dialog.showMessageBox(win, {
      type: 'warning',
      title: '録画データの保存確認',
      message: '録画データの保存が完了していません。アプリケーションを閉じてよいですか？',
      buttons: ['いいえ', 'はい'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    }).then(async ({ response }) => {
      closeConfirmationOpen = false;
      if (response !== 1) return;
      allowCloseWithIncompleteRecording = true;
      await Promise.all(
        [...recordingConversionSessions.keys()].map(discardRecordingConversion),
      );
      win.close();
    });
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void win.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
};

ipcMain.handle(
  'project:save',
  async (
    _event,
    project: ProjectFile,
    currentPath?: string,
    saveAs = false,
  ): Promise<SaveProjectResult> => {
    let targetPath = !saveAs ? currentPath : undefined;

    if (!targetPath) {
      const result = await dialog.showSaveDialog({
        title: '道草45プロジェクトを保存',
        defaultPath: '無題.m45',
        filters: [PROJECT_FILTER],
      });

      if (result.canceled || !result.filePath) {
        return { canceled: true };
      }

      targetPath = result.filePath.endsWith('.m45')
        ? result.filePath
        : `${result.filePath}.m45`;
    }

    const now = new Date().toISOString();
    const nextProject: ProjectFile = {
      ...project,
      updatedAt: now,
      createdAt: project.createdAt || now,
    };

    await fs.writeFile(
      targetPath,
      JSON.stringify(nextProject, null, 2),
      'utf8',
    );

    return { canceled: false, filePath: targetPath };
  },
);

ipcMain.handle('project:open', async (): Promise<OpenProjectResult> => {
  const result = await dialog.showOpenDialog({
    title: '道草45プロジェクトを開く',
    properties: ['openFile'],
    filters: [PROJECT_FILTER],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true };
  }

  const filePath = result.filePaths[0];
  const text = await fs.readFile(filePath, 'utf8');
  const parsed: unknown = JSON.parse(text);

  if (!isProjectFile(parsed)) {
    throw new Error('対応していない、または壊れた.m45ファイルです。');
  }

  return {
    canceled: false,
    filePath,
    project: migrateProject(parsed),
  };
});

ipcMain.handle('image:save-png', async (_event, bytes: Uint8Array, suggestedName: string) => {
  const result = await dialog.showSaveDialog({
    title: '今回のまとめをPNG保存',
    defaultPath: suggestedName,
    filters: [{ name: 'PNG image', extensions: ['png'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  const filePath = result.filePath.toLowerCase().endsWith('.png') ? result.filePath : `${result.filePath}.png`;
  await fs.writeFile(filePath, Buffer.from(bytes));
  return { canceled: false, filePath };
});

ipcMain.handle('image:open', async () => {
  const result = await dialog.showOpenDialog({
    title: '画像をキャンバスへ取り込む',
    properties: ['openFile'],
    filters: [{ name: '画像', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return { canceled: true };
  const filePath = result.filePaths[0];
  const extension = path.extname(filePath).toLowerCase();
  const mime = extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : extension === '.webp' ? 'image/webp' : extension === '.gif' ? 'image/gif' : extension === '.bmp' ? 'image/bmp' : 'image/png';
  const bytes = await fs.readFile(filePath);
  return { canceled: false, name: path.basename(filePath), dataUrl: `data:${mime};base64,${bytes.toString('base64')}` };
});


ipcMain.handle(
  'recording:conversion-start',
  async (
    _event,
    fps: 30 | 60,
    withAudio: boolean,
    outputWidth: number,
    outputHeight: number,
    mjpegQuality: 1 | 3 | 5,
    suggestedName: string,
  ): Promise<StartRecordingConversionResult> => startRecordingConversion(
    fps === 60 ? 60 : 30,
    withAudio === true,
    Number.isFinite(outputWidth) ? Math.max(2, Math.round(outputWidth / 2) * 2) : 1920,
    Number.isFinite(outputHeight) ? Math.max(2, Math.round(outputHeight / 2) * 2) : 1080,
    mjpegQuality === 1 || mjpegQuality === 5 ? mjpegQuality : 3,
    suggestedName,
  ),
);

ipcMain.handle(
  'recording:conversion-write',
  async (_event, id: string, bytes: Uint8Array): Promise<void> => {
    const conversion = recordingConversionSessions.get(id);
    if (!conversion) throw new Error('録画変換セッションが見つかりません。');
    const buffer = Buffer.from(bytes);
    if (conversion.recoveryError) throw conversion.recoveryError;
    await writeBuffer(conversion.recoveryStream, buffer);

    if (conversion.error) return;
    const input = conversion.process.stdin;
    if (!input || input.destroyed || !input.writable) {
      stopLiveConversion(
        conversion,
        new Error('録画中のAVI変換が停止したため、録画終了後に復旧変換します。'),
      );
      return;
    }

    try {
      input.write(buffer);
      if (input.writableLength > MAX_FFMPEG_INPUT_BUFFER_BYTES) {
        stopLiveConversion(
          conversion,
          new Error('AVI変換の遅延が大きいため、録画終了後の復旧変換へ切り替えました。'),
        );
      }
    } catch (error) {
      stopLiveConversion(
        conversion,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  },
);

ipcMain.handle(
  'recording:conversion-finish',
  async (_event, id: string): Promise<SaveRecordingResult> => {
    const conversion = recordingConversionSessions.get(id);
    if (!conversion) throw new Error('録画変換セッションが見つかりません。');
    if (!conversion.recoveryStream.destroyed) conversion.recoveryStream.end();
    if (!conversion.error) conversion.process.stdin?.end();
    await Promise.all([conversion.completed, conversion.recoveryCompleted]);

    if (conversion.recoveryError) {
      recordingConversionSessions.delete(id);
      throw new Error(
        `録画復旧データの保存に失敗しました。\n${conversion.recoveryError.message}`,
      );
    }

    if (conversion.error) {
      await fs.rm(conversion.outputPath, { force: true }).catch(() => undefined);
      try {
        await convertWebmToAvi(
          conversion.recoveryPath,
          conversion.outputPath,
          conversion.fps,
          conversion.withAudio,
          null,
          conversion.outputWidth,
          conversion.outputHeight,
          conversion.mjpegQuality,
        );
      } catch (recoveryError) {
        recordingConversionSessions.delete(id);
        const message = recoveryError instanceof Error
          ? recoveryError.message
          : String(recoveryError);
        throw new Error(
          `AVIへの復旧変換に失敗しました。圧縮済み録画素材は次の場所に残しています。\n${conversion.recoveryPath}\n\n${message}`,
        );
      }
    }

    recordingConversionSessions.delete(id);
    await fs.rm(conversion.recoveryPath, { force: true }).catch(() => undefined);
    return { canceled: false, filePath: conversion.outputPath };
  },
);

ipcMain.handle('recording:conversion-abort', async (_event, id: string): Promise<void> => {
  await discardRecordingConversion(id);
});

ipcMain.handle(
  'recording:save',
  async (
    _event,
    bytes: Uint8Array,
    suggestedName: string,
    fps: 30 | 60,
    withAudio: boolean,
    durationMilliseconds: number,
    outputWidth: number,
    outputHeight: number,
  ): Promise<SaveRecordingResult> => {
    const result = await dialog.showSaveDialog({
      title: '録画を保存',
      defaultPath: suggestedName,
      filters: [
        {
          name: 'AVI video',
          extensions: ['avi'],
        },
      ],
    });

    if (result.canceled || !result.filePath) {
      return { canceled: true };
    }

    const filePath = result.filePath.toLowerCase().endsWith('.avi')
      ? result.filePath
      : `${result.filePath}.avi`;
    const frameRate: 30 | 60 = fps === 60 ? 60 : 30;
    const temporaryDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'michikusa45-'),
    );
    const inputPath = path.join(temporaryDirectory, 'recording.webm');
    const convertedPath = path.join(temporaryDirectory, 'recording.avi');

    try {
      await fs.writeFile(inputPath, Buffer.from(bytes));
      await convertWebmToAvi(
        inputPath,
        convertedPath,
        frameRate,
        withAudio === true,
        Number.isFinite(durationMilliseconds) ? durationMilliseconds : 1,
        Number.isFinite(outputWidth) ? Math.max(2, Math.round(outputWidth / 2) * 2) : 1920,
        Number.isFinite(outputHeight) ? Math.max(2, Math.round(outputHeight / 2) * 2) : 1080,
      );
      await fs.copyFile(convertedPath, filePath);
      return { canceled: false, filePath };
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  },
);

app.whenReady().then(async () => {
  await loadMenuPresets();
  Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      callback(permission === 'media');
    },
  );

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
