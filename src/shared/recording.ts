export type SaveRecordingResult =
  | { canceled: true }
  | { canceled: false; filePath: string };

export type RecordingExportSettings = {
  videoBitsPerSecond: 4_000_000 | 8_000_000 | 12_000_000 | 20_000_000;
  fps: 30 | 60;
};
