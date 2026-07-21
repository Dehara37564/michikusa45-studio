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
import { promises as fs } from 'node:fs';
import type {
  OpenProjectResult,
  ProjectFile,
  SaveProjectResult,
} from './shared/project';
import type {
  RecordingExportSettings,
  SaveRecordingResult,
} from './shared/recording';
import type { MenuCommand, MenuPreset } from './shared/menu';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;

const PROJECT_FILTER = {
  name: '道草45 Project',
  extensions: ['m45'],
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
    if (!Number.isFinite(preset.value) || preset.value < 1 || preset.value > 20) {
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

ipcMain.handle('app:quit', () => app.quit());

const getFfmpegPath = (): string =>
  app.isPackaged
    ? path.join(process.resourcesPath, 'ffmpeg.exe')
    : path.join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');

const convertWebmToMp4 = async (
  inputPath: string,
  outputPath: string,
  settings: RecordingExportSettings,
): Promise<void> => {
  const ffmpegPath = getFfmpegPath();
  await fs.access(ffmpegPath);

  await new Promise<void>((resolve, reject) => {
    const ffmpeg = spawn(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        inputPath,
        '-c:v',
        'libx264',
        '-preset',
        'medium',
        '-b:v',
        String(settings.videoBitsPerSecond),
        '-maxrate',
        String(settings.videoBitsPerSecond),
        '-bufsize',
        String(settings.videoBitsPerSecond * 2),
        '-r',
        String(settings.fps),
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-movflags',
        '+faststart',
        outputPath,
      ],
      { windowsHide: true },
    );

    let stderr = '';
    ffmpeg.stderr.setEncoding('utf8');
    ffmpeg.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-16_384);
    });
    ffmpeg.once('error', reject);
    ffmpeg.once('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `FFmpeg conversion failed (exit code ${code ?? 'unknown'}).${
              stderr ? `\n${stderr.trim()}` : ''
            }`,
          ),
        );
      }
    });
  });
};

const isProjectFile = (value: unknown): value is ProjectFile => {
  if (!value || typeof value !== 'object') return false;

  const project = value as Partial<ProjectFile>;
  return (
    project.format === 'm45' &&
    project.version === 1 &&
    !!project.canvas &&
    Array.isArray(project.canvas.strokes) &&
    !!project.camera &&
    typeof project.camera.x === 'number' &&
    typeof project.camera.y === 'number' &&
    typeof project.camera.zoom === 'number' &&
    !!project.settings &&
    typeof project.settings.selectedColor === 'string' &&
    typeof project.settings.selectedWidth === 'number'
  );
};

const createWindow = (): void => {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 540,
    backgroundColor: '#ffffff',
    title: '道草45 Studio',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
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
    project: parsed,
  };
});


ipcMain.handle(
  'recording:save',
  async (
    _event,
    bytes: Uint8Array,
    suggestedName: string,
    settings: RecordingExportSettings,
  ): Promise<SaveRecordingResult> => {
    const allowedBitrates = [4_000_000, 8_000_000, 12_000_000, 20_000_000];
    if (
      !allowedBitrates.includes(settings.videoBitsPerSecond) ||
      (settings.fps !== 30 && settings.fps !== 60)
    ) {
      throw new Error('録画の出力設定が正しくありません。');
    }

    const result = await dialog.showSaveDialog({
      title: '録画を保存',
      defaultPath: suggestedName,
      filters: [
        {
          name: 'MP4 video',
          extensions: ['mp4'],
        },
      ],
    });

    if (result.canceled || !result.filePath) {
      return { canceled: true };
    }

    const filePath = result.filePath.toLowerCase().endsWith('.mp4')
      ? result.filePath
      : `${result.filePath}.mp4`;

    const temporaryDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'michikusa45-'),
    );
    const inputPath = path.join(temporaryDirectory, 'recording.webm');
    const convertedPath = path.join(temporaryDirectory, 'recording.mp4');

    try {
      await fs.writeFile(inputPath, Buffer.from(bytes));
      await convertWebmToMp4(inputPath, convertedPath, settings);
      await fs.copyFile(convertedPath, filePath);
      return { canceled: false, filePath };
    } finally {
      await fs.rm(temporaryDirectory, {
        recursive: true,
        force: true,
      }).catch(() => undefined);
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
