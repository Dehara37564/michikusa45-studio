import { contextBridge, ipcRenderer } from 'electron';
import type {
  OpenProjectResult,
  ProjectFile,
  SaveProjectResult,
} from './shared/project';
import type { SaveRecordingResult } from './shared/recording';

contextBridge.exposeInMainWorld('michikusa', {
  saveProject: (
    project: ProjectFile,
    currentPath?: string,
    saveAs = false,
  ): Promise<SaveProjectResult> =>
    ipcRenderer.invoke('project:save', project, currentPath, saveAs),
  openProject: (): Promise<OpenProjectResult> =>
    ipcRenderer.invoke('project:open'),
  saveRecording: (
    bytes: Uint8Array,
    suggestedName: string,
  ): Promise<SaveRecordingResult> =>
    ipcRenderer.invoke('recording:save', bytes, suggestedName),
});
