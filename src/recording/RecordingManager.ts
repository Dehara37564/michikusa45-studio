export type RecordingState =
  | 'idle'
  | 'requesting-permission'
  | 'recording'
  | 'stopping'
  | 'saving';

export type RecordingResult = {
  durationMilliseconds: number;
};

export type RecordingQuality = '720p' | '1080p' | '1440p' | '4k';

export type AudioFilterSettings = {
  monitoringEnabled: boolean;
  monitoringGainDb: number;
  gainDb: number;
  noiseSuppression: boolean;
  highPassEnabled: boolean;
  highPassFrequency: number;
  eqEnabled: boolean;
  lowGainDb: number;
  midGainDb: number;
  highGainDb: number;
  compressorEnabled: boolean;
  compressorThresholdDb: number;
  compressorRatio: number;
  compressorAttackMs: number;
  compressorReleaseMs: number;
  compressorOutputGainDb: number;
  limiterEnabled: boolean;
  limiterThresholdDb: number;
  limiterReleaseMs: number;
};

export type RecordingSettings = {
  microphoneEnabled: boolean;
  audioDeviceId: string;
  quality: RecordingQuality;
  videoBitsPerSecond:
    | 4_000_000
    | 8_000_000
    | 12_000_000
    | 20_000_000
    | 24_000_000
    | 45_000_000
    | 68_000_000;
  fps: 30 | 60;
  audioFilters: AudioFilterSettings;
};

type RecordingCallbacks = {
  onStateChange: (state: RecordingState) => void;
  onElapsedChange: (elapsedMilliseconds: number) => void;
  onAudioLevelChange: (
    decibelsFullScale: number,
    peakDecibelsFullScale: number,
  ) => void;
  onDataChunk?: (chunk: Blob) => void;
};
const QUALITY_DIMENSIONS: Record<RecordingQuality, [number, number]> = {
  '720p': [1280, 720],
  '1080p': [1920, 1080],
  '1440p': [2560, 1440],
  '4k': [3840, 2160],
};

export const getRecordingDimensions = (
  quality: RecordingQuality,
): readonly [number, number] => QUALITY_DIMENSIONS[quality];

const AUDIO_METER_FLOOR_DBFS = -60;
const AUDIO_METER_ATTACK = 0.55;
const AUDIO_METER_RELEASE = 0.12;
const AUDIO_METER_PEAK_DECAY_DB_PER_FRAME = 0.22;

const decibelsToGain = (decibels: number): number => 10 ** (decibels / 20);

type ProcessedAudio = {
  context: AudioContext;
  stream: MediaStream;
  analyser: AnalyserNode;
  updateFilters: (settings: AudioFilterSettings) => void;
};

const createProcessedAudio = (
  sourceStream: MediaStream,
  settings: AudioFilterSettings,
): ProcessedAudio => {
  const context = new AudioContext({ sampleRate: 48000 });
  const source = context.createMediaStreamSource(sourceStream);
  const highPass = context.createBiquadFilter();
  highPass.type = 'highpass';
  highPass.Q.value = 0.707;

  const lowEq = context.createBiquadFilter();
  lowEq.type = 'lowshelf';
  lowEq.frequency.value = 120;
  const midEq = context.createBiquadFilter();
  midEq.type = 'peaking';
  midEq.frequency.value = 1_500;
  midEq.Q.value = 0.8;
  const highEq = context.createBiquadFilter();
  highEq.type = 'highshelf';
  highEq.frequency.value = 6_000;

  const inputGain = context.createGain();
  const compressor = context.createDynamicsCompressor();
  const compressorOutput = context.createGain();
  const limiter = context.createDynamicsCompressor();
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.72;
  const destination = context.createMediaStreamDestination();
  const monitoringGain = context.createGain();

  source
    .connect(highPass)
    .connect(lowEq)
    .connect(midEq)
    .connect(highEq)
    .connect(inputGain)
    .connect(compressor)
    .connect(compressorOutput)
    .connect(limiter)
    .connect(analyser)
    .connect(destination);
  analyser.connect(monitoringGain).connect(context.destination);

  const updateFilters = (next: AudioFilterSettings): void => {
    const now = context.currentTime;
    monitoringGain.gain.setTargetAtTime(
      next.monitoringEnabled ? decibelsToGain(next.monitoringGainDb) : 0,
      now,
      0.01,
    );
    highPass.frequency.setTargetAtTime(
      next.highPassEnabled ? next.highPassFrequency : 10,
      now,
      0.01,
    );
    lowEq.gain.setTargetAtTime(next.eqEnabled ? next.lowGainDb : 0, now, 0.01);
    midEq.gain.setTargetAtTime(next.eqEnabled ? next.midGainDb : 0, now, 0.01);
    highEq.gain.setTargetAtTime(next.eqEnabled ? next.highGainDb : 0, now, 0.01);
    inputGain.gain.setTargetAtTime(decibelsToGain(next.gainDb), now, 0.01);
    compressor.threshold.setTargetAtTime(
      next.compressorEnabled ? next.compressorThresholdDb : 0,
      now,
      0.01,
    );
    compressor.knee.setTargetAtTime(next.compressorEnabled ? 6 : 0, now, 0.01);
    compressor.ratio.setTargetAtTime(
      next.compressorEnabled ? next.compressorRatio : 1,
      now,
      0.01,
    );
    compressor.attack.setTargetAtTime(next.compressorAttackMs / 1_000, now, 0.01);
    compressor.release.setTargetAtTime(next.compressorReleaseMs / 1_000, now, 0.01);
    compressorOutput.gain.setTargetAtTime(
      next.compressorEnabled ? decibelsToGain(next.compressorOutputGainDb) : 1,
      now,
      0.01,
    );
    limiter.threshold.setTargetAtTime(
      next.limiterEnabled ? next.limiterThresholdDb : 0,
      now,
      0.01,
    );
    limiter.knee.setTargetAtTime(0, now, 0.01);
    limiter.ratio.setTargetAtTime(next.limiterEnabled ? 20 : 1, now, 0.01);
    limiter.attack.setTargetAtTime(0.001, now, 0.01);
    limiter.release.setTargetAtTime(next.limiterReleaseMs / 1_000, now, 0.01);
  };
  updateFilters(settings);

  return {
    context,
    stream: destination.stream,
    analyser,
    updateFilters,
  };
};

const readAudioLevel = (
  analyser: AnalyserNode,
  samples: Float32Array<ArrayBuffer>,
): { rmsDbfs: number; peakDbfs: number } => {
  analyser.getFloatTimeDomainData(samples);
  let sumSquares = 0;
  let peak = 0;
  for (const sample of samples) {
    const normalized = Math.abs(sample);
    sumSquares += normalized * normalized;
    peak = Math.max(peak, normalized);
  }
  const rms = Math.sqrt(sumSquares / samples.length);
  const toDbfs = (value: number): number => value > 0
    ? Math.max(AUDIO_METER_FLOOR_DBFS, Math.min(0, 20 * Math.log10(value)))
    : AUDIO_METER_FLOOR_DBFS;
  return { rmsDbfs: toDbfs(rms), peakDbfs: toDbfs(peak) };
};

const followAudioLevel = (previous: number, current: number): number => {
  if (previous <= AUDIO_METER_FLOOR_DBFS && current > AUDIO_METER_FLOOR_DBFS) {
    return current;
  }
  const coefficient = current > previous
    ? AUDIO_METER_ATTACK
    : AUDIO_METER_RELEASE;
  return previous + (current - previous) * coefficient;
};

export class AudioLevelMonitor {
  private stream: MediaStream | null = null;
  private processed: ProcessedAudio | null = null;
  private samples: Float32Array<ArrayBuffer> | null = null;
  private animationFrameId: number | null = null;
  private displayedRmsDbfs = AUDIO_METER_FLOOR_DBFS;
  private displayedPeakDbfs = AUDIO_METER_FLOOR_DBFS;

  public async start(
    audioDeviceId: string,
    filters: AudioFilterSettings,
    onLevel: (rmsDbfs: number, peakDbfs: number) => void,
  ): Promise<void> {
    this.stop();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: audioDeviceId ? { exact: audioDeviceId } : undefined,
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: filters.noiseSuppression,
        autoGainControl: false,
        sampleRate: 48000,
      },
      video: false,
    });
    this.processed = createProcessedAudio(this.stream, filters);
    this.samples = new Float32Array(this.processed.analyser.fftSize);
    const update = (): void => {
      if (!this.processed || !this.samples) return;
      const level = readAudioLevel(this.processed.analyser, this.samples);
      this.displayedRmsDbfs = followAudioLevel(
        this.displayedRmsDbfs,
        level.rmsDbfs,
      );
      this.displayedPeakDbfs = Math.max(
        level.peakDbfs,
        this.displayedPeakDbfs - AUDIO_METER_PEAK_DECAY_DB_PER_FRAME,
      );
      onLevel(this.displayedRmsDbfs, this.displayedPeakDbfs);
      this.animationFrameId = requestAnimationFrame(update);
    };
    update();
  }

  public stop(): void {
    if (this.animationFrameId !== null) cancelAnimationFrame(this.animationFrameId);
    this.animationFrameId = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.processed?.stream.getTracks().forEach((track) => track.stop());
    void this.processed?.context.close();
    this.stream = null;
    this.processed = null;
    this.samples = null;
    this.displayedRmsDbfs = AUDIO_METER_FLOOR_DBFS;
    this.displayedPeakDbfs = AUDIO_METER_FLOOR_DBFS;
  }

  public updateFilters(filters: AudioFilterSettings): void {
    this.processed?.updateFilters(filters);
    const track = this.stream?.getAudioTracks()[0];
    if (track) {
      void track.applyConstraints({
        noiseSuppression: filters.noiseSuppression,
      }).catch(() => undefined);
    }
  }
}

const chooseMimeType = (withAudio: boolean): string => {
  const candidates = withAudio
    ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];

  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? '';
};

export class RecordingManager {
  private readonly sourceCanvas: HTMLCanvasElement;
  private readonly callbacks: RecordingCallbacks;
  private readonly settings: RecordingSettings;

  private mediaRecorder: MediaRecorder | null = null;
  private microphoneStream: MediaStream | null = null;
  private outputStream: MediaStream | null = null;
  private animationFrameId: number | null = null;
  private timerId: number | null = null;
  private startedAt = 0;
  private audioContext: AudioContext | null = null;
  private audioAnalyser: AnalyserNode | null = null;
  private audioSamples: Float32Array<ArrayBuffer> | null = null;
  private displayedRmsDbfs = AUDIO_METER_FLOOR_DBFS;
  private displayedPeakDbfs = AUDIO_METER_FLOOR_DBFS;

  public constructor(
    sourceCanvas: HTMLCanvasElement,
    callbacks: RecordingCallbacks,
    settings: RecordingSettings,
  ) {
    this.sourceCanvas = sourceCanvas;
    this.callbacks = callbacks;
    this.settings = settings;
  }

  public async start(): Promise<void> {
    if (this.mediaRecorder) return;

    this.callbacks.onStateChange('requesting-permission');

    try {
      if (this.settings.microphoneEnabled) {
        this.microphoneStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: this.settings.audioDeviceId
              ? { exact: this.settings.audioDeviceId }
              : undefined,
            channelCount: 1,
            echoCancellation: false,
            noiseSuppression: this.settings.audioFilters.noiseSuppression,
            autoGainControl: false,
            sampleRate: 48000,
          },
          video: false,
        });
        const processedAudio = createProcessedAudio(
          this.microphoneStream,
          this.settings.audioFilters,
        );
        this.audioContext = processedAudio.context;
        this.audioAnalyser = processedAudio.analyser;
        this.audioSamples = new Float32Array(this.audioAnalyser.fftSize);
        this.outputStream = processedAudio.stream;
      }

      this.startFramePump();

      const videoStream = this.sourceCanvas.captureStream(this.settings.fps);
      const combined = new MediaStream([
        ...videoStream.getVideoTracks(),
        ...(this.outputStream?.getAudioTracks() ?? []),
      ]);
      this.outputStream = combined;

      const mimeType = chooseMimeType(this.settings.microphoneEnabled);
      const sourcePixelsPerSecond =
        this.sourceCanvas.width * this.sourceCanvas.height * this.settings.fps;
      const preservationBitrate = Math.min(
        100_000_000,
        Math.round(sourcePixelsPerSecond * 0.14),
      );
      this.mediaRecorder = new MediaRecorder(combined, {
        mimeType: mimeType || undefined,
        videoBitsPerSecond: Math.max(
          this.settings.videoBitsPerSecond,
          preservationBitrate,
        ),
        audioBitsPerSecond: this.settings.microphoneEnabled ? 192_000 : undefined,
      });

      this.mediaRecorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) this.callbacks.onDataChunk?.(event.data);
      });

      this.startedAt = performance.now();
      this.callbacks.onElapsedChange(0);
      this.timerId = window.setInterval(() => {
        this.callbacks.onElapsedChange(performance.now() - this.startedAt);
      }, 200);

      this.mediaRecorder.start(1000);
      this.callbacks.onStateChange('recording');
    } catch (error) {
      this.cleanup();
      this.callbacks.onStateChange('idle');
      throw error;
    }
  }

  public async stop(): Promise<RecordingResult | null> {
    const recorder = this.mediaRecorder;
    if (!recorder || recorder.state === 'inactive') return null;

    this.callbacks.onStateChange('stopping');

    const durationMilliseconds = Math.max(
      1,
      performance.now() - this.startedAt,
    );

    return new Promise<RecordingResult>((resolve, reject) => {
      recorder.addEventListener(
        'stop',
        () => {
          this.cleanup();
          resolve({ durationMilliseconds });
        },
        { once: true },
      );

      recorder.addEventListener(
        'error',
        (event) => {
          this.cleanup();
          reject(event);
        },
        { once: true },
      );

      recorder.stop();
    });
  }

  public destroy(): void {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
    this.cleanup();
  }

  private startFramePump(): void {
    const update = (): void => {
      if (this.audioAnalyser) {
        this.updateAudioLevel();
      }
      this.animationFrameId = requestAnimationFrame(update);
    };
    update();
  }

  private updateAudioLevel(): void {
    if (!this.audioAnalyser || !this.audioSamples) return;
    const level = readAudioLevel(this.audioAnalyser, this.audioSamples);
    this.displayedRmsDbfs = followAudioLevel(
      this.displayedRmsDbfs,
      level.rmsDbfs,
    );
    this.displayedPeakDbfs = Math.max(
      level.peakDbfs,
      this.displayedPeakDbfs - AUDIO_METER_PEAK_DECAY_DB_PER_FRAME,
    );
    this.callbacks.onAudioLevelChange(
      this.displayedRmsDbfs,
      this.displayedPeakDbfs,
    );
  }

  private cleanup(): void {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }

    this.microphoneStream?.getTracks().forEach((track) => track.stop());
    this.outputStream?.getTracks().forEach((track) => track.stop());

    this.microphoneStream = null;
    this.outputStream = null;
    this.mediaRecorder = null;
    this.audioAnalyser = null;
    this.audioSamples = null;
    this.displayedRmsDbfs = AUDIO_METER_FLOOR_DBFS;
    this.displayedPeakDbfs = AUDIO_METER_FLOOR_DBFS;
    void this.audioContext?.close();
    this.audioContext = null;
    this.callbacks.onElapsedChange(0);
    this.callbacks.onAudioLevelChange(
      AUDIO_METER_FLOOR_DBFS,
      AUDIO_METER_FLOOR_DBFS,
    );
  }
}
