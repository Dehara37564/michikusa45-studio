import { app, BrowserWindow, dialog, ipcMain, session } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import type {
  OpenProjectResult,
  ProjectFile,
  SaveProjectResult,
} from './shared/project';
import type { SaveRecordingResult } from './shared/recording';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;

const PROJECT_FILTER = {
  name: '道草45 Project',
  extensions: ['m45'],
};

const getFfmpegPath = (): string =>
  app.isPackaged
    ? path.join(process.resourcesPath, 'ffmpeg.exe')
    : path.join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');

const convertWebmToMp4 = async (
  inputPath: string,
  outputPath: string,
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
        '-crf',
        '18',
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
  ): Promise<SaveRecordingResult> => {
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
      await convertWebmToMp4(inputPath, convertedPath);
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

app.whenReady().then(() => {
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
