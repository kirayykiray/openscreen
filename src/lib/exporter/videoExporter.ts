import type { ExportConfig, ExportProgress, ExportResult } from './types';
import { VideoFileDecoder } from './videoDecoder';
import { FrameRenderer } from './frameRenderer';
import { VideoMuxer } from './muxer';
import type { ZoomRegion, CropRegion, CornerSettings } from '@/components/video-editor/types';
import type { CursorData } from '@/lib/cursor/cursorTracker';
import type { CursorSettings } from '@/lib/cursor/springPhysics';

interface VideoExporterConfig extends ExportConfig {
  videoUrl: string;
  wallpaper: string;
  zoomRegions: ZoomRegion[];
  showShadow: boolean;
  shadowIntensity: number;
  showBlur: boolean;
  cropRegion: CropRegion;
  cornerRadius?: number;
  cornerSettings?: CornerSettings;
  cursorData?: CursorData | null;
  showCursor?: boolean;
  cursorSettings?: CursorSettings;
  padding?: number; // 0-50 percentage padding
  onProgress?: (progress: ExportProgress) => void;
}

export class VideoExporter {
  private config: VideoExporterConfig;
  private decoder: VideoFileDecoder | null = null;
  private renderer: FrameRenderer | null = null;
  private encoder: VideoEncoder | null = null;
  private muxer: VideoMuxer | null = null;
  private cancelled = false;
  private encodeQueue = 0;
  // Larger queue for better throughput while maintaining reliability
  private readonly MAX_ENCODE_QUEUE = 16;
  private videoDescription: Uint8Array | undefined;
  private videoColorSpace: VideoColorSpaceInit | undefined;
  // Track muxing promises for parallel processing
  private muxingPromises: Promise<void>[] = [];
  private chunkCount = 0;

  constructor(config: VideoExporterConfig) {
    this.config = config;
  }

  async export(): Promise<ExportResult> {
    try {
      this.cleanup();
      this.cancelled = false;

      // Initialize decoder and load video
      this.decoder = new VideoFileDecoder();
      const videoInfo = await this.decoder.loadVideo(this.config.videoUrl);

      // Use detected frame rate from video if not specified (0 or falsy)
      // This ensures exports match the original recording frame rate
      const exportFrameRate = this.config.frameRate > 0 ? this.config.frameRate : videoInfo.frameRate;
      // Debug log removed`);

      // Store detected frame rate in config for encoder
      this.config.frameRate = exportFrameRate;

      // Initialize frame renderer
      this.renderer = new FrameRenderer({
        width: this.config.width,
        height: this.config.height,
        wallpaper: this.config.wallpaper,
        zoomRegions: this.config.zoomRegions,
        showShadow: this.config.showShadow,
        shadowIntensity: this.config.shadowIntensity,
        showBlur: this.config.showBlur,
        cropRegion: this.config.cropRegion,
        cornerRadius: this.config.cornerRadius,
        cornerSettings: this.config.cornerSettings,
        cursorData: this.config.cursorData,
        showCursor: this.config.showCursor ?? true,
        cursorSettings: this.config.cursorSettings,
        padding: this.config.padding,
        videoWidth: videoInfo.width,
        videoHeight: videoInfo.height,
      });
      await this.renderer.initialize();

      // Initialize video encoder
      const totalFrames = Math.ceil(videoInfo.duration * this.config.frameRate);
      await this.initializeEncoder();

      // Initialize muxer
      this.muxer = new VideoMuxer(this.config, false);
      await this.muxer.initialize();

      // Get the video element for frame extraction
      const videoElement = this.decoder.getVideoElement();
      if (!videoElement) {
        throw new Error('Video element not available');
      }

      // Frame extraction with proper seeking
      const frameDuration = 1_000_000 / this.config.frameRate; // in microseconds
      let frameIndex = 0;
      const timeStep = 1 / this.config.frameRate;
      const startTime = performance.now();

      // Helper function to wait for video to be ready at a specific time
      const seekToTime = (time: number): Promise<void> => {
        return new Promise((resolve) => {
          // Clamp time to video duration
          const clampedTime = Math.min(time, videoInfo.duration - 0.001);
          
          if (Math.abs(videoElement.currentTime - clampedTime) < 0.001) {
            // Already at the right time
            resolve();
            return;
          }
          
          const onSeeked = () => {
            videoElement.removeEventListener('seeked', onSeeked);
            // Small delay to ensure frame is decoded
            setTimeout(resolve, 5);
          };
          videoElement.addEventListener('seeked', onSeeked);
          videoElement.currentTime = clampedTime;
        });
      };

      // Ensure video is paused for frame-accurate extraction
      videoElement.pause();
      videoElement.playbackRate = 1;
      
      // Seek to start
      await seekToTime(0);

      // Debug log removed}s`);

      while (frameIndex < totalFrames && !this.cancelled) {
        const i = frameIndex;
        const timestamp = i * frameDuration;
        const videoTime = Math.min(i * timeStep, videoInfo.duration - 0.001);
        
        // Seek to exact frame time
        await seekToTime(videoTime);
        
        // Wait for video to have valid data
        if (videoElement.readyState < 2) {
          await new Promise<void>(resolve => {
            const checkReady = () => {
              if (videoElement.readyState >= 2) {
                resolve();
              } else {
                requestAnimationFrame(checkReady);
              }
            };
            checkReady();
          });
        }

        // Create a VideoFrame from the video element
        let videoFrame: VideoFrame;
        try {
          videoFrame = new VideoFrame(videoElement, {
            timestamp,
          });
        } catch (e) {
          console.warn(`[VideoExporter] Failed to create frame ${i}, skipping`);
          frameIndex++;
          continue;
        }

        // Render the frame with all effects
        await this.renderer!.renderFrame(videoFrame, timestamp);
        
        videoFrame.close();

        const canvas = this.renderer!.getCanvas();

        // Create VideoFrame from canvas
        const exportFrame = new VideoFrame(canvas, {
          timestamp,
          duration: frameDuration,
        });

        // Wait for encoder queue space
        while (this.encodeQueue >= this.MAX_ENCODE_QUEUE && !this.cancelled) {
          await new Promise(resolve => setTimeout(resolve, 5));
        }

        if (this.encoder && this.encoder.state === 'configured') {
          this.encodeQueue++;
          // Keyframe every second for better seeking
          this.encoder.encode(exportFrame, { keyFrame: i % this.config.frameRate === 0 });
        }
        exportFrame.close();

        frameIndex++;
        
        // Update progress with ETA
        if (this.config.onProgress) {
          const elapsed = (performance.now() - startTime) / 1000;
          const fps = frameIndex / elapsed;
          const remaining = (totalFrames - frameIndex) / fps;
          
          this.config.onProgress({
            currentFrame: frameIndex,
            totalFrames,
            percentage: (frameIndex / totalFrames) * 100,
            estimatedTimeRemaining: remaining,
          });
        }
      }

      if (this.cancelled) {
        return { success: false, error: 'Export cancelled' };
      }

      // Finalize encoding
      if (this.encoder && this.encoder.state === 'configured') {
        // Debug log removed
        await this.encoder.flush();
        // Debug log removed
      }

      // Wait for all muxing operations to complete
      // Debug log removed
      await Promise.all(this.muxingPromises);
      // Debug log removed

      // Finalize muxer and get output blob
      if (!this.muxer) {
        throw new Error('Muxer was destroyed before finalization');
      }
      
      // Debug log removed
      const blob = await this.muxer.finalize();
      // Debug log removed.toFixed(2)} MB`);

      return { success: true, blob };
    } catch (error) {
      console.error('Export error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.cleanup();
    }
  }

  private async initializeEncoder(): Promise<void> {
    this.encodeQueue = 0;
    this.muxingPromises = [];
    this.chunkCount = 0;
    let videoDescription: Uint8Array | undefined;

    this.encoder = new VideoEncoder({
      output: (chunk, meta) => {
        // Capture decoder config metadata from encoder output
        if (meta?.decoderConfig?.description && !videoDescription) {
          const desc = meta.decoderConfig.description;
          videoDescription = new Uint8Array(desc instanceof ArrayBuffer ? desc : (desc as any));
          this.videoDescription = videoDescription;
        }
        // Capture colorSpace from encoder metadata if provided
        if (meta?.decoderConfig?.colorSpace && !this.videoColorSpace) {
          this.videoColorSpace = meta.decoderConfig.colorSpace;
        }
        
        // Stream chunk to muxer immediately (parallel processing)
        const isFirstChunk = this.chunkCount === 0;
        this.chunkCount++;
        
        const muxingPromise = (async () => {
          try {
            if (isFirstChunk && this.videoDescription) {
              // Add decoder config for the first chunk
              const colorSpace = this.videoColorSpace || {
                primaries: 'bt709',
                transfer: 'iec61966-2-1',
                matrix: 'rgb',
                fullRange: true,
              };
              
              const metadata: EncodedVideoChunkMetadata = {
                decoderConfig: {
                  codec: this.config.codec || 'avc1.640033',
                  codedWidth: this.config.width,
                  codedHeight: this.config.height,
                  description: this.videoDescription,
                  colorSpace,
                },
              };
              
              await this.muxer!.addVideoChunk(chunk, metadata);
            } else {
              await this.muxer!.addVideoChunk(chunk, meta);
            }
          } catch (error) {
            console.error('Muxing error:', error);
          }
        })();
        
        this.muxingPromises.push(muxingPromise);
        this.encodeQueue--;
      },
      error: (error) => {
        console.error('[VideoExporter] Encoder error:', error);
        // Stop export encoding failed
        this.cancelled = true;
      },
    });

    const codec = this.config.codec || 'avc1.640033';
    
    const encoderConfig: VideoEncoderConfig = {
      codec,
      width: this.config.width,
      height: this.config.height,
      bitrate: this.config.bitrate,
      framerate: this.config.frameRate,
      // Use quality mode for better output - takes longer but much better results
      latencyMode: 'quality',
      bitrateMode: 'variable',
      hardwareAcceleration: 'prefer-hardware',
      // AVC specific optimizations
      avc: {
        format: 'annexb',
      },
    };

    // Check hardware support first
    const hardwareSupport = await VideoEncoder.isConfigSupported(encoderConfig);
    
    if (hardwareSupport.supported) {
      // Use hardware encoding
      // Debug log removed
      this.encoder.configure(encoderConfig);
    } else {
      // Fall back to software encoding
      // Debug log removed
      encoderConfig.hardwareAcceleration = 'prefer-software';
      
      const softwareSupport = await VideoEncoder.isConfigSupported(encoderConfig);
      if (!softwareSupport.supported) {
        throw new Error('Video encoding not supported on this system');
      }
      
      this.encoder.configure(encoderConfig);
    }
  }

  cancel(): void {
    this.cancelled = true;
    this.cleanup();
  }

  private cleanup(): void {
    if (this.encoder) {
      try {
        if (this.encoder.state === 'configured') {
          this.encoder.close();
        }
      } catch (e) {
        console.warn('Error closing encoder:', e);
      }
      this.encoder = null;
    }

    if (this.decoder) {
      try {
        this.decoder.destroy();
      } catch (e) {
        console.warn('Error destroying decoder:', e);
      }
      this.decoder = null;
    }

    if (this.renderer) {
      try {
        this.renderer.destroy();
      } catch (e) {
        console.warn('Error destroying renderer:', e);
      }
      this.renderer = null;
    }

    this.muxer = null;
    this.encodeQueue = 0;
    this.muxingPromises = [];
    this.chunkCount = 0;
    this.videoDescription = undefined;
    this.videoColorSpace = undefined;
  }
}
