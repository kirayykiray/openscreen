export interface DecodedVideoInfo {
  width: number;
  height: number;
  duration: number; // in seconds
  frameRate: number;
  codec: string;
}

export interface RecordingMetadata {
  fps: number;
  resolution: string;
  quality: string;
  width: number;
  height: number;
  duration: number;
  timestamp: number;
}

export class VideoFileDecoder {
  private info: DecodedVideoInfo | null = null;
  private videoElement: HTMLVideoElement | null = null;

  async loadVideo(videoUrl: string): Promise<DecodedVideoInfo> {
    this.videoElement = document.createElement('video');
    this.videoElement.src = videoUrl;
    this.videoElement.preload = 'auto'; // Changed to auto for better frame rate detection

    // Try to load recording metadata if available
    const metadataFrameRate = await this.tryLoadMetadata(videoUrl);

    return new Promise((resolve, reject) => {
      this.videoElement!.addEventListener('loadedmetadata', async () => {
        const video = this.videoElement!;
        
        // Try to detect actual frame rate from video
        let detectedFrameRate = 60; // Default fallback
        
        // Priority: 1. Metadata from recording, 2. Detected from video, 3. Default
        if (metadataFrameRate && metadataFrameRate > 0) {
          detectedFrameRate = metadataFrameRate;
          // Debug log removed
        } else {
          try {
            // Method: Use requestVideoFrameCallback to measure actual frame rate
            detectedFrameRate = await this.detectFrameRate(video);
            // Debug log removed
          } catch (e) {
            console.warn('[VideoDecoder] Frame rate detection failed, using default 60fps');
          }
        }
        
        this.info = {
          width: video.videoWidth,
          height: video.videoHeight,
          duration: video.duration,
          frameRate: detectedFrameRate,
          codec: 'avc1.640033',
        };

        resolve(this.info);
      });

      this.videoElement!.addEventListener('error', (e) => {
        reject(new Error(`Failed to load video: ${e}`));
      });
    });
  }

  /**
   * Try to load recording metadata from .meta.json file
   */
  private async tryLoadMetadata(videoUrl: string): Promise<number | null> {
    try {
      // Convert file:// URL to metadata URL
      const metadataUrl = videoUrl.replace(/\.(webm|mp4|mkv)$/i, '.meta.json');
      
      const response = await fetch(metadataUrl);
      if (!response.ok) return null;
      
      const metadata: RecordingMetadata = await response.json();
      if (metadata && metadata.fps > 0) {
        // Debug log removed
        return metadata.fps;
      }
    } catch (e) {
      // Metadata file doesn't exist or couldn't be parsed - that's OK
      // Debug log removed
    }
    return null;
  }

  /**
   * Detect actual frame rate by measuring frame timing
   */
  private async detectFrameRate(video: HTMLVideoElement): Promise<number> {
    return new Promise((resolve) => {
      // Wait for video to be ready
      if (video.readyState < 2) {
        video.addEventListener('canplay', () => this.measureFrameRate(video, resolve), { once: true });
      } else {
        this.measureFrameRate(video, resolve);
      }
    });
  }

  private measureFrameRate(video: HTMLVideoElement, resolve: (fps: number) => void): void {
    // Check if requestVideoFrameCallback is available
    if (!('requestVideoFrameCallback' in video)) {
      // Fallback: Try to detect from common frame rates
      resolve(this.guessFrameRateFromDuration((video as HTMLVideoElement).duration));
      return;
    }

    const frameTimes: number[] = [];
    let frameCount = 0;
    const maxFrames = 30; // Sample 30 frames
    let lastTime = 0;

    // Temporarily play to measure frames
    video.muted = true;
    video.playbackRate = 1;
    const wasCurrentTime = video.currentTime;
    video.currentTime = 0;

    const measureFrame = (_now: number, metadata: VideoFrameCallbackMetadata) => {
      if (frameCount > 0 && metadata.mediaTime !== undefined) {
        const frameTime = metadata.mediaTime - lastTime;
        if (frameTime > 0) {
          frameTimes.push(frameTime);
        }
      }
      lastTime = metadata.mediaTime || 0;
      frameCount++;

      if (frameCount < maxFrames && !video.paused) {
        (video as any).requestVideoFrameCallback(measureFrame);
      } else {
        video.pause();
        video.currentTime = wasCurrentTime;

        if (frameTimes.length > 5) {
          // Calculate median frame time
          const sorted = frameTimes.slice().sort((a, b) => a - b);
          const medianTime = sorted[Math.floor(sorted.length / 2)];
          const fps = Math.round(1 / medianTime);
          
          // Round to common frame rates
          const commonFps = [24, 25, 30, 48, 50, 60, 120];
          const closestFps = commonFps.reduce((prev, curr) => 
            Math.abs(curr - fps) < Math.abs(prev - fps) ? curr : prev
          );
          
          resolve(closestFps);
        } else {
          resolve(this.guessFrameRateFromDuration(video.duration));
        }
      }
    };

    video.play().then(() => {
      (video as any).requestVideoFrameCallback(measureFrame);
    }).catch(() => {
      resolve(this.guessFrameRateFromDuration(video.duration));
    });

    // Timeout fallback
    setTimeout(() => {
      if (frameCount < maxFrames) {
        video.pause();
        video.currentTime = wasCurrentTime;
        if (frameTimes.length > 2) {
          const sorted = frameTimes.slice().sort((a, b) => a - b);
          const medianTime = sorted[Math.floor(sorted.length / 2)];
          resolve(Math.round(1 / medianTime));
        } else {
          resolve(this.guessFrameRateFromDuration(video.duration));
        }
      }
    }, 2000);
  }

  private guessFrameRateFromDuration(duration: number): number {
    // Common recording frame rates
    // Longer videos are usually recorded at 30/60fps
    // Shorter videos might be at higher frame rates
    if (duration < 5) return 60; // Short clips often at 60fps
    if (duration > 120) return 30; // Long videos often at 30fps
    return 60; // Default to 60fps
  }

  /**
   * Get video element for seeking
   */
  getVideoElement(): HTMLVideoElement | null {
    return this.videoElement;
  }

  getInfo(): DecodedVideoInfo | null {
    return this.info;
  }

  destroy(): void {
    if (this.videoElement) {
      this.videoElement.pause();
      this.videoElement.src = '';
      this.videoElement = null;
    }
  }
}
