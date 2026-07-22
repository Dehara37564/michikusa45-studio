export type RecordingState =
  | 'idle'
  | 'requesting-permission'
  | 'recording'
  | 'stopping'
  | 'saving';

export type RecordingResult = {
  blob: Blob;
  durationMilliseconds: number;
};

export type RecordingQuality = '720p' | '1080p' | '1440p' | '4k';

export type RecordingSettings = {
  microphoneEnabled: boolean;
  audioDeviceId: string;
  quality: RecordingQuality;
  videoBitsPerSecond: 4_000_000 | 8_000_000 | 12_000_000 | 20_000_000;
  fps: 30 | 60;
};

type RecordingCallbacks = {
  onStateChange: (state: RecordingState) => void;
  onElapsedChange: (elapsedMilliseconds: number) => void;
  onAudioLevelChange: (level: number) => void;
};
type RecordingFrameRenderer = (context: CanvasRenderingContext2D, width: number, height: number) => void;

const QUALITY_DIMENSIONS: Record<RecordingQuality, [number, number]> = {
  '720p': [1280, 720],
  '1080p': [1920, 1080],
  '1440p': [2560, 1440],
  '4k': [3840, 2160],
};

const chooseMimeType = (withAudio: boolean): string => {
  const candidates = withAudio
    ? ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm']
    : ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm'];

  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? '';
};

export class RecordingManager {
  private readonly sourceCanvas: HTMLCanvasElement;
  private readonly outputCanvas: HTMLCanvasElement;
  private readonly callbacks: RecordingCallbacks;
  private readonly settings: RecordingSettings;
  private readonly outputContext: CanvasRenderingContext2D;
  private readonly renderFrame?: RecordingFrameRenderer;

  private mediaRecorder: MediaRecorder | null = null;
  private microphoneStream: MediaStream | null = null;
  private outputStream: MediaStream | null = null;
  private animationFrameId: number | null = null;
  private timerId: number | null = null;
  private startedAt = 0;
  private chunks: Blob[] = [];
  private audioContext: AudioContext | null = null;
  private audioAnalyser: AnalyserNode | null = null;
  private audioSamples: Uint8Array<ArrayBuffer> | null = null;

  public constructor(
    sourceCanvas: HTMLCanvasElement,
    callbacks: RecordingCallbacks,
    settings: RecordingSettings,
    renderFrame?: RecordingFrameRenderer,
  ) {
    this.sourceCanvas = sourceCanvas;
    this.callbacks = callbacks;
    this.settings = settings;
    this.renderFrame = renderFrame;
    this.outputCanvas = document.createElement('canvas');
    const [width, height] = QUALITY_DIMENSIONS[settings.quality];
    this.outputCanvas.width = width;
    this.outputCanvas.height = height;

    const context = this.outputCanvas.getContext('2d', {
      alpha: false,
      desynchronized: true,
    });

    if (!context) {
      throw new Error('録画用Canvasを作成できませんでした。');
    }

    this.outputContext = context;
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
            noiseSuppression: false,
            autoGainControl: false,
            sampleRate: 48000,
          },
          video: false,
        });
        this.startAudioMeter(this.microphoneStream);
      }

      this.startFramePump();

      const videoStream = this.outputCanvas.captureStream(this.settings.fps);
      const combined = new MediaStream([
        ...videoStream.getVideoTracks(),
        ...(this.microphoneStream?.getAudioTracks() ?? []),
      ]);
      this.outputStream = combined;

      const mimeType = chooseMimeType(this.settings.microphoneEnabled);
      this.chunks = [];
      this.mediaRecorder = new MediaRecorder(combined, {
        mimeType: mimeType || undefined,
        videoBitsPerSecond: this.settings.videoBitsPerSecond,
        audioBitsPerSecond: this.settings.microphoneEnabled ? 192_000 : undefined,
      });

      this.mediaRecorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) this.chunks.push(event.data);
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
      const mimeType = recorder.mimeType || 'video/webm';

      recorder.addEventListener(
        'stop',
        () => {
          const blob = new Blob(this.chunks, { type: mimeType });
          this.cleanup();
          resolve({ blob, durationMilliseconds });
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
    let lastRenderedAt = Number.NEGATIVE_INFINITY;
    const frameInterval = 1000 / this.settings.fps;
    const draw = (timestamp = performance.now()): void => {
      const context = this.outputContext;
      const targetWidth = this.outputCanvas.width;
      const targetHeight = this.outputCanvas.height;
      const sourceWidth = this.sourceCanvas.width;
      const sourceHeight = this.sourceCanvas.height;

      if (this.renderFrame) {
        if (timestamp - lastRenderedAt >= frameInterval) {
          this.renderFrame(context, targetWidth, targetHeight);
          lastRenderedAt = timestamp;
        }
        this.updateAudioLevel();
        this.animationFrameId = requestAnimationFrame(draw);
        return;
      }

      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, targetWidth, targetHeight);

      if (sourceWidth > 0 && sourceHeight > 0) {
        const scale = Math.min(
          targetWidth / sourceWidth,
          targetHeight / sourceHeight,
        );
        const drawWidth = sourceWidth * scale;
        const drawHeight = sourceHeight * scale;
        const offsetX = (targetWidth - drawWidth) / 2;
        const offsetY = (targetHeight - drawHeight) / 2;

        context.drawImage(
          this.sourceCanvas,
          offsetX,
          offsetY,
          drawWidth,
          drawHeight,
        );
      }

      this.updateAudioLevel();

      this.animationFrameId = requestAnimationFrame(draw);
    };

    draw();
  }

  private startAudioMeter(stream: MediaStream): void {
    this.audioContext = new AudioContext();
    const source = this.audioContext.createMediaStreamSource(stream);
    this.audioAnalyser = this.audioContext.createAnalyser();
    this.audioAnalyser.fftSize = 256;
    this.audioAnalyser.smoothingTimeConstant = 0.72;
    source.connect(this.audioAnalyser);
    this.audioSamples = new Uint8Array(this.audioAnalyser.fftSize);
  }

  private updateAudioLevel(): void {
    if (!this.audioAnalyser || !this.audioSamples) return;
    this.audioAnalyser.getByteTimeDomainData(this.audioSamples);
    let sumSquares = 0;
    for (const sample of this.audioSamples) {
      const normalized = (sample - 128) / 128;
      sumSquares += normalized * normalized;
    }
    const rms = Math.sqrt(sumSquares / this.audioSamples.length);
    this.callbacks.onAudioLevelChange(Math.min(1, rms * 4));
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
    this.chunks = [];
    this.audioAnalyser = null;
    this.audioSamples = null;
    void this.audioContext?.close();
    this.audioContext = null;
    this.callbacks.onElapsedChange(0);
    this.callbacks.onAudioLevelChange(0);
  }
}
