import { contextBridge, ipcRenderer } from 'electron';
import type {
  OpenProjectResult,
  ProjectFile,
  SaveProjectResult,
} from './shared/project';
import type { SaveRecordingResult, StartRecordingConversionResult } from './shared/recording';
import type { MenuCommand, MenuPreset } from './shared/menu';

contextBridge.exposeInMainWorld('michikusa', {
  saveProject: (
    project: ProjectFile,
    currentPath?: string,
    saveAs = false,
  ): Promise<SaveProjectResult> =>
    ipcRenderer.invoke('project:save', project, currentPath, saveAs),
  openProject: (): Promise<OpenProjectResult> =>
    ipcRenderer.invoke('project:open'),
  openImage: (): Promise<{ canceled: true } | { canceled: false; name: string; dataUrl: string }> =>
    ipcRenderer.invoke('image:open'),
  onMenuCommand: (callback: (command: MenuCommand) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, command: MenuCommand) => {
      callback(command);
    };
    ipcRenderer.on('menu:command', listener);
    return () => ipcRenderer.removeListener('menu:command', listener);
  },
  addMenuPreset: (preset: MenuPreset): Promise<void> =>
    ipcRenderer.invoke('menu:add-preset', preset),
  getMenuPresets: (): Promise<{ colors: string[]; widths: number[] }> =>
    ipcRenderer.invoke('menu:get-presets'),
  removeMenuPreset: (preset: MenuPreset): Promise<void> =>
    ipcRenderer.invoke('menu:remove-preset', preset),
  setFullScreen: (fullScreen: boolean): Promise<void> =>
    ipcRenderer.invoke('window:set-fullscreen', fullScreen),
  isFullScreen: (): Promise<boolean> =>
    ipcRenderer.invoke('window:is-fullscreen'),
  quit: (): Promise<void> => ipcRenderer.invoke('app:quit'),
  startRecordingConversion: (
    fps: 30 | 60,
    withAudio: boolean,
    outputWidth: number,
    outputHeight: number,
    mjpegQuality: 1 | 3 | 5,
    suggestedName: string,
  ): Promise<StartRecordingConversionResult> => ipcRenderer.invoke(
    'recording:conversion-start', fps, withAudio, outputWidth, outputHeight, mjpegQuality, suggestedName,
  ),
  writeRecordingConversion: (id: string, bytes: Uint8Array): Promise<void> =>
    ipcRenderer.invoke('recording:conversion-write', id, bytes),
  finishRecordingConversion: (id: string): Promise<SaveRecordingResult> =>
    ipcRenderer.invoke('recording:conversion-finish', id),
  abortRecordingConversion: (id: string): Promise<void> =>
    ipcRenderer.invoke('recording:conversion-abort', id),
  saveRecording: (
    bytes: Uint8Array,
    suggestedName: string,
    fps: 30 | 60,
    withAudio: boolean,
    durationMilliseconds: number,
    outputWidth: number,
    outputHeight: number,
  ): Promise<SaveRecordingResult> =>
    ipcRenderer.invoke(
      'recording:save',
      bytes,
      suggestedName,
      fps,
      withAudio,
      durationMilliseconds,
      outputWidth,
      outputHeight,
    ),
  savePng: (bytes: Uint8Array, suggestedName: string): Promise<{ canceled: boolean; filePath?: string }> =>
    ipcRenderer.invoke('image:save-png', bytes, suggestedName),
});
