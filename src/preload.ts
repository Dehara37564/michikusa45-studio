import { contextBridge, ipcRenderer } from 'electron';
import type {
  OpenProjectResult,
  ProjectFile,
  SaveProjectResult,
} from './shared/project';
import type { SaveRecordingResult } from './shared/recording';
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
  quit: (): Promise<void> => ipcRenderer.invoke('app:quit'),
  saveRecording: (
    bytes: Uint8Array,
    suggestedName: string,
  ): Promise<SaveRecordingResult> =>
    ipcRenderer.invoke('recording:save', bytes, suggestedName),
  savePng: (bytes: Uint8Array, suggestedName: string): Promise<{ canceled: boolean; filePath?: string }> =>
    ipcRenderer.invoke('image:save-png', bytes, suggestedName),
});
