import { Application, Container, Sprite, Graphics, BlurFilter, Texture } from 'pixi.js';
import type { ZoomRegion, CropRegion, CornerSettings } from '@/components/video-editor/types';
import { ZOOM_DEPTH_SCALES } from '@/components/video-editor/types';
import { findDominantRegion } from '@/components/video-editor/videoPlayback/zoomRegionUtils';
import { applyZoomTransform } from '@/components/video-editor/videoPlayback/zoomTransform';
import { DEFAULT_FOCUS, SMOOTHING_FACTOR, MIN_DELTA, VIEWPORT_SCALE } from '@/components/video-editor/videoPlayback/constants';
import { clampFocusToStage as clampFocusToStageUtil } from '@/components/video-editor/videoPlayback/focusUtils';
import type { CursorData } from '@/lib/cursor/cursorTracker';
import { interpolateCursorPosition, isCursorStationary, SpringCursorInterpolator } from '@/lib/cursor/cursorTracker';
import type { CursorSettings, ClickRipple, MotionTrail } from '@/lib/cursor/springPhysics';
import { 
  DEFAULT_CURSOR_SETTINGS, 
  CURSOR_SIZE_MAP,
  createMotionTrail,
  updateMotionTrail,
  getTrailBezierPoints,
  createClickRipple,
  processClickRipples
} from '@/lib/cursor/springPhysics';
import { CURSOR_SVGS, svgToImage, getCursorHotspot, type CursorType } from '@/lib/cursor/cursorSvg';

interface FrameRenderConfig {
  width: number;
  height: number;
  wallpaper: string;
  zoomRegions: ZoomRegion[];
  showShadow: boolean;
  shadowIntensity: number;
  showBlur: boolean;
  cropRegion: CropRegion;
  videoWidth: number;
  videoHeight: number;
  cornerRadius?: number;
  cornerSettings?: CornerSettings;
  cursorData?: CursorData | null;
  showCursor?: boolean;
  cursorSettings?: CursorSettings;
  padding?: number; // 0-50 percentage of canvas for padding
}

interface AnimationState {
  scale: number;
  focusX: number;
  focusY: number;
}

// Renders video frames with all effects (background, zoom, crop, blur, shadow) to an offscreen canvas for export.

export class FrameRenderer {
  private app: Application | null = null;
  private cameraContainer: Container | null = null;
  private videoContainer: Container | null = null;
  private videoSprite: Sprite | null = null;
  private backgroundSprite: Sprite | null = null;
  private maskGraphics: Graphics | null = null;
  private blurFilter: BlurFilter | null = null;
  private shadowCanvas: HTMLCanvasElement | null = null;
  private shadowCtx: CanvasRenderingContext2D | null = null;
  private compositeCanvas: HTMLCanvasElement | null = null;
  private compositeCtx: CanvasRenderingContext2D | null = null;
  private config: FrameRenderConfig;
  private animationState: AnimationState;
  private layoutCache: any = null;
  private currentVideoTime = 0;
  private springInterpolator: SpringCursorInterpolator;
  private motionTrail: MotionTrail;
  private clickRipples: ClickRipple[] = [];
  private lastPressed: boolean = false;
  private cursorImages: Map<string, HTMLImageElement> = new Map();
  private cursorOpacity: number = 1; // For auto-hide fade
  private lastCursorMoveTime: number = 0;

  constructor(config: FrameRenderConfig) {
    this.config = config;
    this.animationState = {
      scale: 1,
      focusX: DEFAULT_FOCUS.cx,
      focusY: DEFAULT_FOCUS.cy,
    };
    const cursorSettings = config.cursorSettings || DEFAULT_CURSOR_SETTINGS;
    // Use smoothness value if set, otherwise use preset
    if (cursorSettings.smoothness !== undefined) {
      this.springInterpolator = new SpringCursorInterpolator(cursorSettings.springPreset, cursorSettings.smoothness);
    } else {
      this.springInterpolator = new SpringCursorInterpolator(cursorSettings.springPreset);
    }
    this.motionTrail = createMotionTrail(cursorSettings.trailLength || 8);
  }

  async initialize(): Promise<void> {
    // Create canvas for rendering
    const canvas = document.createElement('canvas');
    canvas.width = this.config.width;
    canvas.height = this.config.height;
    
    // Try to set colorSpace if supported (may not be available on all platforms)
    try {
      if (canvas && 'colorSpace' in canvas) {
        // @ts-ignore
        canvas.colorSpace = 'srgb';
      }
    } catch (error) {
      // Silently ignore colorSpace errors on platforms that don't support it
      console.warn('[FrameRenderer] colorSpace not supported on this platform:', error);
    }

    // Initialize PixiJS with optimized settings for export performance
    this.app = new Application();
    await this.app.init({
      canvas,
      width: this.config.width,
      height: this.config.height,
      backgroundAlpha: 0,
      antialias: false,
      resolution: 1,
      autoDensity: false,
      powerPreference: 'high-performance',
      preferWebGLVersion: 2,
    });

    // Setup containers
    this.cameraContainer = new Container();
    this.videoContainer = new Container();
    this.app.stage.addChild(this.cameraContainer);
    this.cameraContainer.addChild(this.videoContainer);

    // Setup background (render separately, not in PixiJS)
    await this.setupBackground();

    // Setup blur filter for video container
    this.blurFilter = new BlurFilter();
    this.blurFilter.quality = 3;
    this.blurFilter.resolution = this.app.renderer.resolution;
    this.blurFilter.blur = 0;
    this.videoContainer.filters = [this.blurFilter];

    // Setup composite canvas for final output with shadows
    this.compositeCanvas = document.createElement('canvas');
    this.compositeCanvas.width = this.config.width;
    this.compositeCanvas.height = this.config.height;
    this.compositeCtx = this.compositeCanvas.getContext('2d', { willReadFrequently: false });
    
    if (!this.compositeCtx) {
      throw new Error('Failed to get 2D context for composite canvas');
    }

    // Setup shadow canvas if needed
    if (this.config.showShadow) {
      this.shadowCanvas = document.createElement('canvas');
      this.shadowCanvas.width = this.config.width;
      this.shadowCanvas.height = this.config.height;
      this.shadowCtx = this.shadowCanvas.getContext('2d', { willReadFrequently: false });
      
      if (!this.shadowCtx) {
        throw new Error('Failed to get 2D context for shadow canvas');
      }
    }

    // Setup mask
    this.maskGraphics = new Graphics();
    this.videoContainer.addChild(this.maskGraphics);
    this.videoContainer.mask = this.maskGraphics;
  }

  private async setupBackground(): Promise<void> {
    const wallpaper = this.config.wallpaper;

    // Create background canvas for separate rendering (not affected by zoom)
    const bgCanvas = document.createElement('canvas');
    bgCanvas.width = this.config.width;
    bgCanvas.height = this.config.height;
    const bgCtx = bgCanvas.getContext('2d')!;

    try {
      // Render background based on type
      if (wallpaper.startsWith('file://') || wallpaper.startsWith('data:') || wallpaper.startsWith('/') || wallpaper.startsWith('http')) {
        // Image background
        const img = new Image();
        // Don't set crossOrigin for same-origin images to avoid CORS taint
        // Only set it for cross-origin URLs
        let imageUrl: string;
        if (wallpaper.startsWith('http')) {
          imageUrl = wallpaper;
          if (!imageUrl.startsWith(window.location.origin)) {
            img.crossOrigin = 'anonymous';
          }
        } else if (wallpaper.startsWith('file://') || wallpaper.startsWith('data:')) {
          imageUrl = wallpaper;
        } else {
          imageUrl = window.location.origin + wallpaper;
        }
        
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = (err) => {
            console.error('[FrameRenderer] Failed to load background image:', imageUrl, err);
            reject(new Error(`Failed to load background image: ${imageUrl}`));
          };
          img.src = imageUrl;
        });
        
        // Draw the image using cover and center positioning
        const imgAspect = img.width / img.height;
        const canvasAspect = this.config.width / this.config.height;
        
        let drawWidth, drawHeight, drawX, drawY;
        
        if (imgAspect > canvasAspect) {
          drawHeight = this.config.height;
          drawWidth = drawHeight * imgAspect;
          drawX = (this.config.width - drawWidth) / 2;
          drawY = 0;
        } else {
          drawWidth = this.config.width;
          drawHeight = drawWidth / imgAspect;
          drawX = 0;
          drawY = (this.config.height - drawHeight) / 2;
        }
        
        bgCtx.drawImage(img, drawX, drawY, drawWidth, drawHeight);
      } else if (wallpaper.startsWith('#')) {
        bgCtx.fillStyle = wallpaper;
        bgCtx.fillRect(0, 0, this.config.width, this.config.height);
      } else if (wallpaper.startsWith('linear-gradient') || wallpaper.startsWith('radial-gradient')) {
        
        const gradientMatch = wallpaper.match(/(linear|radial)-gradient\((.+)\)/);
        if (gradientMatch) {
          const [, type, params] = gradientMatch;
          const parts = params.split(',').map(s => s.trim());
          
          let gradient: CanvasGradient;
          
          if (type === 'linear') {
            gradient = bgCtx.createLinearGradient(0, 0, 0, this.config.height);
            parts.forEach((part, index) => {
              if (part.startsWith('to ') || part.includes('deg')) return;
              
              const colorMatch = part.match(/^(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|[a-z]+)/);
              if (colorMatch) {
                const color = colorMatch[1];
                const position = index / (parts.length - 1);
                gradient.addColorStop(position, color);
              }
            });
          } else {
            const cx = this.config.width / 2;
            const cy = this.config.height / 2;
            const radius = Math.max(this.config.width, this.config.height) / 2;
            gradient = bgCtx.createRadialGradient(cx, cy, 0, cx, cy, radius);
            
            parts.forEach((part, index) => {
              const colorMatch = part.match(/^(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|[a-z]+)/);
              if (colorMatch) {
                const color = colorMatch[1];
                const position = index / (parts.length - 1);
                gradient.addColorStop(position, color);
              }
            });
          }
          
          bgCtx.fillStyle = gradient;
          bgCtx.fillRect(0, 0, this.config.width, this.config.height);
        } else {
          console.warn('[FrameRenderer] Could not parse gradient, using black fallback');
          bgCtx.fillStyle = '#000000';
          bgCtx.fillRect(0, 0, this.config.width, this.config.height);
        }
      } else {
        bgCtx.fillStyle = wallpaper;
        bgCtx.fillRect(0, 0, this.config.width, this.config.height);
      }
    } catch (error) {
      console.error('[FrameRenderer] Error setting up background, using fallback:', error);
      bgCtx.fillStyle = '#000000';
      bgCtx.fillRect(0, 0, this.config.width, this.config.height);
    }

    // Store the background canvas for compositing
    this.backgroundSprite = bgCanvas as any;
  }

  async renderFrame(videoFrame: VideoFrame, timestamp: number): Promise<void> {
    if (!this.app || !this.videoContainer || !this.cameraContainer) {
      throw new Error('Renderer not initialized');
    }

    this.currentVideoTime = timestamp / 1000000;

    // Create or update video sprite from VideoFrame
    if (!this.videoSprite) {
      const texture = Texture.from(videoFrame as any);
      this.videoSprite = new Sprite(texture);
      this.videoContainer.addChild(this.videoSprite);
    } else {
      // Destroy old texture to avoid memory leaks, then create new one
      const oldTexture = this.videoSprite.texture;
      const newTexture = Texture.from(videoFrame as any);
      this.videoSprite.texture = newTexture;
      oldTexture.destroy(true);
    }

    // Apply layout
    this.updateLayout();

    const timeMs = this.currentVideoTime * 1000;
    const TICKS_PER_FRAME = 1;
    
    let maxMotionIntensity = 0;
    for (let i = 0; i < TICKS_PER_FRAME; i++) {
      const motionIntensity = this.updateAnimationState(timeMs);
      maxMotionIntensity = Math.max(maxMotionIntensity, motionIntensity);
    }
    
    // Apply transform once with maximum motion intensity from all ticks
    applyZoomTransform({
      cameraContainer: this.cameraContainer,
      blurFilter: this.blurFilter,
      stageSize: this.layoutCache.stageSize,
      baseMask: this.layoutCache.maskRect,
      zoomScale: this.animationState.scale,
      focusX: this.animationState.focusX,
      focusY: this.animationState.focusY,
      motionIntensity: maxMotionIntensity,
      isPlaying: true,
    });

    // Render the PixiJS stage to its canvas (video only, transparent background)
    this.app.renderer.render(this.app.stage);

    // Composite with shadows to final output canvas
    this.compositeWithShadows();
  }

  private updateLayout(): void {
    if (!this.app || !this.videoSprite || !this.maskGraphics || !this.videoContainer) return;

    const { width, height } = this.config;
    const { cropRegion } = this.config;
    const videoWidth = this.config.videoWidth;
    const videoHeight = this.config.videoHeight;

    // Calculate cropped video dimensions
    const cropStartX = cropRegion.x;
    const cropStartY = cropRegion.y;
    const cropEndX = cropRegion.x + cropRegion.width;
    const cropEndY = cropRegion.y + cropRegion.height;

    const croppedVideoWidth = videoWidth * (cropEndX - cropStartX);
    const croppedVideoHeight = videoHeight * (cropEndY - cropStartY);

    // Calculate viewport scale from padding (0-50) -> (1.0-0.5)
    // If padding is not provided, use the default VIEWPORT_SCALE constant
    const viewportScale = this.config.padding !== undefined ? 1 - (this.config.padding / 100) : VIEWPORT_SCALE;
    
    // Calculate scale to fit in viewport
    const viewportWidth = width * viewportScale;
    const viewportHeight = height * viewportScale;
    const scale = Math.min(viewportWidth / croppedVideoWidth, viewportHeight / croppedVideoHeight);

    // Position video sprite
    this.videoSprite.width = videoWidth * scale;
    this.videoSprite.height = videoHeight * scale;

    const cropPixelX = cropStartX * videoWidth * scale;
    const cropPixelY = cropStartY * videoHeight * scale;
    this.videoSprite.x = -cropPixelX;
    this.videoSprite.y = -cropPixelY;

    // Position video container
    const croppedDisplayWidth = croppedVideoWidth * scale;
    const croppedDisplayHeight = croppedVideoHeight * scale;
    const centerOffsetX = (width - croppedDisplayWidth) / 2;
    const centerOffsetY = (height - croppedDisplayHeight) / 2;
    this.videoContainer.x = centerOffsetX;
    this.videoContainer.y = centerOffsetY;

    // Update mask with squircle or rounded corners
    const cornerSettings = this.config.cornerSettings;
    const radius = (cornerSettings?.radius ?? this.config.cornerRadius ?? 0) * scale;
    
    this.maskGraphics.clear();
    
    if (radius > 0) {
      const useSquircle = cornerSettings?.style === 'squircle' || !cornerSettings;
      const corners = cornerSettings ? {
        tl: cornerSettings.topLeft,
        tr: cornerSettings.topRight,
        bl: cornerSettings.bottomLeft,
        br: cornerSettings.bottomRight,
      } : { tl: true, tr: true, bl: true, br: true };
      
      if (useSquircle) {
        // Draw squircle path
        this.drawSquircleMask(0, 0, croppedDisplayWidth, croppedDisplayHeight, radius, corners);
      } else {
        // Draw standard rounded rect with individual corners
        this.drawRoundedMask(0, 0, croppedDisplayWidth, croppedDisplayHeight, radius, corners);
      }
    } else {
      this.maskGraphics.rect(0, 0, croppedDisplayWidth, croppedDisplayHeight);
      this.maskGraphics.fill({ color: 0xffffff });
    }

    // Cache layout info
    this.layoutCache = {
      stageSize: { width, height },
      videoSize: { width: croppedVideoWidth, height: croppedVideoHeight },
      baseScale: scale,
      baseOffset: { x: centerOffsetX, y: centerOffsetY },
      maskRect: { x: 0, y: 0, width: croppedDisplayWidth, height: croppedDisplayHeight },
    };
  }

  private clampFocusToStage(focus: { cx: number; cy: number }, depth: number): { cx: number; cy: number } {
    if (!this.layoutCache) return focus;
    return clampFocusToStageUtil(focus, depth as any, this.layoutCache);
  }

  private drawSquircleMask(
    x: number, y: number, width: number, height: number,
    radius: number, corners: { tl: boolean; tr: boolean; bl: boolean; br: boolean }
  ): void {
    if (!this.maskGraphics) return;
    
    const maxRadius = Math.min(width, height) / 2;
    const r = Math.min(radius, maxRadius);
    
    // iOS-style squircle uses extended bezier control points
    const smoothness = 1.28; // iOS uses ~1.28 for continuous curvature
    const p = smoothness * r * 0.5; // Control point extension
    const c = r * 0.5522847498; // Standard bezier circular approximation
    
    const tl = corners.tl ? r : 0;
    const tr = corners.tr ? r : 0;
    const bl = corners.bl ? r : 0;
    const br = corners.br ? r : 0;
    
    // Calculate extended points for squircle effect
    const tlP = corners.tl ? p : 0;
    const trP = corners.tr ? p : 0;
    const blP = corners.bl ? p : 0;
    const brP = corners.br ? p : 0;
    
    // Start at top-left after the corner
    this.maskGraphics.moveTo(x + tl + tlP, y);
    
    // Top edge
    this.maskGraphics.lineTo(x + width - tr - trP, y);
    
    // Top-right corner (squircle)
    if (tr > 0) {
      this.maskGraphics.bezierCurveTo(
        x + width - tr + c, y,
        x + width, y + tr - c,
        x + width, y + tr + trP
      );
    } else {
      this.maskGraphics.lineTo(x + width, y);
    }
    
    // Right edge
    this.maskGraphics.lineTo(x + width, y + height - br - brP);
    
    // Bottom-right corner (squircle)
    if (br > 0) {
      this.maskGraphics.bezierCurveTo(
        x + width, y + height - br + c,
        x + width - br + c, y + height,
        x + width - br - brP, y + height
      );
    } else {
      this.maskGraphics.lineTo(x + width, y + height);
    }
    
    // Bottom edge
    this.maskGraphics.lineTo(x + bl + blP, y + height);
    
    // Bottom-left corner (squircle)
    if (bl > 0) {
      this.maskGraphics.bezierCurveTo(
        x + bl - c, y + height,
        x, y + height - bl + c,
        x, y + height - bl - blP
      );
    } else {
      this.maskGraphics.lineTo(x, y + height);
    }
    
    // Left edge
    this.maskGraphics.lineTo(x, y + tl + tlP);
    
    // Top-left corner (squircle)
    if (tl > 0) {
      this.maskGraphics.bezierCurveTo(
        x, y + tl - c,
        x + tl - c, y,
        x + tl + tlP, y
      );
    } else {
      this.maskGraphics.lineTo(x, y);
    }
    
    this.maskGraphics.closePath();
    this.maskGraphics.fill({ color: 0xffffff });
  }

  private drawRoundedMask(
    x: number, y: number, width: number, height: number,
    radius: number, corners: { tl: boolean; tr: boolean; bl: boolean; br: boolean }
  ): void {
    if (!this.maskGraphics) return;
    
    const tl = corners.tl ? radius : 0;
    const tr = corners.tr ? radius : 0;
    const bl = corners.bl ? radius : 0;
    const br = corners.br ? radius : 0;
    
    this.maskGraphics.moveTo(x + tl, y);
    this.maskGraphics.lineTo(x + width - tr, y);
    if (tr > 0) this.maskGraphics.arcTo(x + width, y, x + width, y + tr, tr);
    else this.maskGraphics.lineTo(x + width, y);
    this.maskGraphics.lineTo(x + width, y + height - br);
    if (br > 0) this.maskGraphics.arcTo(x + width, y + height, x + width - br, y + height, br);
    else this.maskGraphics.lineTo(x + width, y + height);
    this.maskGraphics.lineTo(x + bl, y + height);
    if (bl > 0) this.maskGraphics.arcTo(x, y + height, x, y + height - bl, bl);
    else this.maskGraphics.lineTo(x, y + height);
    this.maskGraphics.lineTo(x, y + tl);
    if (tl > 0) this.maskGraphics.arcTo(x, y, x + tl, y, tl);
    else this.maskGraphics.lineTo(x, y);
    this.maskGraphics.closePath();
    this.maskGraphics.fill({ color: 0xffffff });
  }

  private updateAnimationState(timeMs: number): number {
    if (!this.cameraContainer || !this.layoutCache) return 0;

    const { region, strength } = findDominantRegion(this.config.zoomRegions, timeMs);
    
    const defaultFocus = DEFAULT_FOCUS;
    let targetScaleFactor = 1;
    let targetFocus = { ...defaultFocus };

    if (region && strength > 0) {
      const zoomScale = ZOOM_DEPTH_SCALES[region.depth];
      const regionFocus = this.clampFocusToStage(region.focus, region.depth);
      
      targetScaleFactor = 1 + (zoomScale - 1) * strength;
      targetFocus = {
        cx: defaultFocus.cx + (regionFocus.cx - defaultFocus.cx) * strength,
        cy: defaultFocus.cy + (regionFocus.cy - defaultFocus.cy) * strength,
      };
    }

    const state = this.animationState;

    const prevScale = state.scale;
    const prevFocusX = state.focusX;
    const prevFocusY = state.focusY;

    const scaleDelta = targetScaleFactor - state.scale;
    const focusXDelta = targetFocus.cx - state.focusX;
    const focusYDelta = targetFocus.cy - state.focusY;

    let nextScale = prevScale;
    let nextFocusX = prevFocusX;
    let nextFocusY = prevFocusY;

    if (Math.abs(scaleDelta) > MIN_DELTA) {
      nextScale = prevScale + scaleDelta * SMOOTHING_FACTOR;
    } else {
      nextScale = targetScaleFactor;
    }

    if (Math.abs(focusXDelta) > MIN_DELTA) {
      nextFocusX = prevFocusX + focusXDelta * SMOOTHING_FACTOR;
    } else {
      nextFocusX = targetFocus.cx;
    }

    if (Math.abs(focusYDelta) > MIN_DELTA) {
      nextFocusY = prevFocusY + focusYDelta * SMOOTHING_FACTOR;
    } else {
      nextFocusY = targetFocus.cy;
    }

    state.scale = nextScale;
    state.focusX = nextFocusX;
    state.focusY = nextFocusY;

    return Math.max(
      Math.abs(nextScale - prevScale),
      Math.abs(nextFocusX - prevFocusX),
      Math.abs(nextFocusY - prevFocusY)
    );
  }

  private compositeWithShadows(): void {
    if (!this.compositeCanvas || !this.compositeCtx || !this.app) return;

    const videoCanvas = this.app.canvas as HTMLCanvasElement;
    const ctx = this.compositeCtx;
    const w = this.compositeCanvas.width;
    const h = this.compositeCanvas.height;

    // Clear composite canvas
    ctx.clearRect(0, 0, w, h);

    // Step 1: Draw background layer (with optional blur, not affected by zoom)
    if (this.backgroundSprite) {
      const bgCanvas = this.backgroundSprite as any as HTMLCanvasElement;
      
      if (this.config.showBlur) {
        ctx.save();
        ctx.filter = 'blur(6px)'; // Canvas blur is weaker than CSS
        ctx.drawImage(bgCanvas, 0, 0, w, h);
        ctx.restore();
      } else {
        ctx.drawImage(bgCanvas, 0, 0, w, h);
      }
    } else {
      console.warn('[FrameRenderer] No background sprite found during compositing!');
    }

    // Draw video layer with shadows on top of background
    if (this.config.showShadow && this.config.shadowIntensity > 0 && this.shadowCanvas && this.shadowCtx) {
      const shadowCtx = this.shadowCtx;
      shadowCtx.clearRect(0, 0, w, h);
      shadowCtx.save();
      
      // Calculate shadow parameters based on intensity (0-1)
      const intensity = this.config.shadowIntensity;
      const baseBlur1 = 48 * intensity;
      const baseBlur2 = 16 * intensity;
      const baseBlur3 = 8 * intensity;
      const baseAlpha1 = 0.7 * intensity;
      const baseAlpha2 = 0.5 * intensity;
      const baseAlpha3 = 0.3 * intensity;
      const baseOffset = 12 * intensity;
      
      shadowCtx.filter = `drop-shadow(0 ${baseOffset}px ${baseBlur1}px rgba(0,0,0,${baseAlpha1})) drop-shadow(0 ${baseOffset/3}px ${baseBlur2}px rgba(0,0,0,${baseAlpha2})) drop-shadow(0 ${baseOffset/6}px ${baseBlur3}px rgba(0,0,0,${baseAlpha3}))`;
      shadowCtx.drawImage(videoCanvas, 0, 0, w, h);
      shadowCtx.restore();
      ctx.drawImage(this.shadowCanvas, 0, 0, w, h);
    } else {
      ctx.drawImage(videoCanvas, 0, 0, w, h);
    }

    // Draw cursor overlay
    this.drawCursor(ctx);
  }

  private async loadCursorImage(type: CursorType, size: number): Promise<HTMLImageElement | null> {
    const cacheKey = `${type}-${size}`;
    if (this.cursorImages.has(cacheKey)) {
      return this.cursorImages.get(cacheKey)!;
    }
    try {
      const svg = CURSOR_SVGS[type];
      const img = await svgToImage(svg, size);
      this.cursorImages.set(cacheKey, img);
      return img;
    } catch (e) {
      console.warn(`Failed to load cursor image: ${type}`, e);
      return null;
    }
  }

  private drawCursor(ctx: CanvasRenderingContext2D): void {
    const { cursorData, showCursor, cursorSettings = DEFAULT_CURSOR_SETTINGS } = this.config;
    
    if (!showCursor || !cursorData || !cursorData.positions || cursorData.positions.length === 0 || !this.layoutCache) {
      return;
    }

    const timeMs = this.currentVideoTime * 1000;
    const cursorPos = interpolateCursorPosition(cursorData, timeMs);
    
    if (!cursorPos) return;

    // Auto-hide: Check if cursor has been stationary
    if (cursorSettings.autoHide) {
      const isStationary = isCursorStationary(cursorData, timeMs, cursorSettings.autoHideDelay || 3000);
      if (isStationary) {
        // Fade out over 300ms
        const stationaryTime = timeMs - this.lastCursorMoveTime;
        const fadeStart = cursorSettings.autoHideDelay || 3000;
        const fadeDuration = 300;
        if (stationaryTime > fadeStart) {
          this.cursorOpacity = Math.max(0, 1 - (stationaryTime - fadeStart) / fadeDuration);
        }
        if (this.cursorOpacity <= 0) return;
      } else {
        this.cursorOpacity = 1;
        this.lastCursorMoveTime = timeMs;
      }
    }

    // Map cursor from screen coordinates to canvas coordinates
    const videoW = this.config.videoWidth;
    const videoH = this.config.videoHeight;
    const scale = this.layoutCache.baseScale;
    const offset = this.layoutCache.baseOffset;

    // Calculate raw cursor position on the rendered video
    const rawX = offset.x + (cursorPos.x / cursorData.screenWidth) * videoW * scale;
    const rawY = offset.y + (cursorPos.y / cursorData.screenHeight) * videoH * scale;
    
    // Apply spring physics for smooth movement
    const springState = this.springInterpolator.update(rawX, rawY, timeMs);
    const canvasX = springState.x;
    const canvasY = springState.y;
    const velocity = this.springInterpolator.getVelocity();
    
    // Cursor size based on settings - Screen Studio style is larger
    const baseCursorSize = CURSOR_SIZE_MAP[cursorSettings.size];
    const cursorSize = baseCursorSize * scale * 1.2; // 20% bigger for visibility
    const borderWidth = 3 * scale; // Thicker border
    
    // Detect new click for ripple
    if (cursorPos.pressed && !this.lastPressed && cursorSettings.showRipple) {
      this.clickRipples.push(createClickRipple(canvasX, canvasY, timeMs));
    }
    this.lastPressed = cursorPos.pressed;
    
    ctx.save();
    
    // Apply auto-hide opacity
    if (cursorSettings.autoHide && this.cursorOpacity < 1) {
      ctx.globalAlpha = this.cursorOpacity;
    }
    
    // Update and draw motion trail (Screen Studio style - bezier-smoothed trail)
    if (cursorSettings.motionBlur) {
      this.motionTrail = updateMotionTrail(this.motionTrail, canvasX, canvasY, velocity, timeMs);
      
      // Draw bezier-interpolated trail for smoothness
      const trailPoints = getTrailBezierPoints(this.motionTrail, canvasX, canvasY);
      for (let i = trailPoints.length - 1; i >= 0; i--) {
        const pos = trailPoints[i];
        const trailSize = cursorSize * (0.2 + (i / trailPoints.length) * 0.4);
        const gradient = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, trailSize);
        gradient.addColorStop(0, `rgba(0, 0, 0, ${pos.alpha * 0.4})`);
        gradient.addColorStop(1, `rgba(0, 0, 0, 0)`);
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, trailSize, 0, Math.PI * 2);
        ctx.fillStyle = gradient;
        ctx.fill();
      }
    }
    
    // Draw click ripples (Screen Studio style - multiple expanding rings)
    if (cursorSettings.showRipple) {
      const activeRipples = processClickRipples(this.clickRipples, timeMs);
      this.clickRipples = this.clickRipples.filter(r => (timeMs - r.startTime) < r.duration);
      
      for (const ripple of activeRipples) {
        // First ring - faster, smaller
        const ring1Size = cursorSize * (1 + ripple.progress * 4);
        const ring1Alpha = (1 - ripple.progress) * 0.4;
        ctx.beginPath();
        ctx.arc(ripple.x, ripple.y, ring1Size, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(52, 178, 123, ${ring1Alpha})`;
        ctx.lineWidth = 3 * scale;
        ctx.stroke();
        
        // Second ring - slower, larger
        const ring2Progress = Math.max(0, ripple.progress - 0.1) / 0.9;
        if (ring2Progress > 0) {
          const ring2Size = cursorSize * (1 + ring2Progress * 6);
          const ring2Alpha = (1 - ring2Progress) * 0.25;
          ctx.beginPath();
          ctx.arc(ripple.x, ripple.y, ring2Size, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(52, 178, 123, ${ring2Alpha})`;
          ctx.lineWidth = 2 * scale;
          ctx.stroke();
        }
        
        // Inner flash
        if (ripple.progress < 0.3) {
          const flashAlpha = (1 - ripple.progress / 0.3) * 0.3;
          const flashSize = cursorSize * 1.5;
          const flashGradient = ctx.createRadialGradient(ripple.x, ripple.y, 0, ripple.x, ripple.y, flashSize);
          flashGradient.addColorStop(0, `rgba(52, 178, 123, ${flashAlpha})`);
          flashGradient.addColorStop(1, `rgba(52, 178, 123, 0)`);
          ctx.beginPath();
          ctx.arc(ripple.x, ripple.y, flashSize, 0, Math.PI * 2);
          ctx.fillStyle = flashGradient;
          ctx.fill();
        }
      }
    }
    
    // Draw highlight/spotlight effect (Screen Studio style - soft glow)
    if (cursorSettings.showHighlight) {
      const highlightSize = cursorSize * 5;
      const gradient = ctx.createRadialGradient(canvasX, canvasY, cursorSize, canvasX, canvasY, highlightSize);
      gradient.addColorStop(0, 'rgba(255, 255, 255, 0.15)');
      gradient.addColorStop(0.5, 'rgba(255, 255, 255, 0.05)');
      gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.beginPath();
      ctx.arc(canvasX, canvasY, highlightSize, 0, Math.PI * 2);
      ctx.fillStyle = gradient;
      ctx.fill();
    }
    
    // Draw glow effect (Screen Studio style - color matched glow)
    if (cursorSettings.showGlow) {
      const glowSize = cursorSize * 2.5;
      const glowColor = cursorSettings.glowColor || '#34B27B';
      const r = parseInt(glowColor.slice(1, 3), 16);
      const g = parseInt(glowColor.slice(3, 5), 16);
      const b = parseInt(glowColor.slice(5, 7), 16);
      
      const gradient = ctx.createRadialGradient(canvasX, canvasY, cursorSize * 0.5, canvasX, canvasY, glowSize);
      gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${cursorSettings.glowIntensity * 0.5})`);
      gradient.addColorStop(0.5, `rgba(${r}, ${g}, ${b}, ${cursorSettings.glowIntensity * 0.2})`);
      gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
      ctx.beginPath();
      ctx.arc(canvasX, canvasY, glowSize, 0, Math.PI * 2);
      ctx.fillStyle = gradient;
      ctx.fill();
    }
    
    // Draw the cursor based on style
    const cursorStyle = cursorSettings.cursorStyle || 'circle';
    
    if (cursorStyle === 'circle') {
      // Draw circle cursor (Screen Studio style)
      this.drawCircleCursor(ctx, canvasX, canvasY, cursorSize, borderWidth, scale, cursorPos.pressed, cursorSettings);
    } else {
      // Draw SVG cursor (pointer, crosshair, etc.)
      this.drawSvgCursor(ctx, canvasX, canvasY, cursorSize * 2, cursorStyle, cursorPos.pressed);
    }
    
    // Click pulse effect (Screen Studio style - pulsing glow)
    if (cursorPos.pressed) {
      const pulseSize = cursorSize * 2.2;
      const pulseGradient = ctx.createRadialGradient(canvasX, canvasY, cursorSize, canvasX, canvasY, pulseSize);
      pulseGradient.addColorStop(0, 'rgba(52, 178, 123, 0.5)');
      pulseGradient.addColorStop(0.7, 'rgba(52, 178, 123, 0.2)');
      pulseGradient.addColorStop(1, 'rgba(52, 178, 123, 0)');
      ctx.beginPath();
      ctx.arc(canvasX, canvasY, pulseSize, 0, Math.PI * 2);
      ctx.fillStyle = pulseGradient;
      ctx.fill();
    }
    
    ctx.restore();
  }

  private drawCircleCursor(
    ctx: CanvasRenderingContext2D,
    canvasX: number,
    canvasY: number,
    cursorSize: number,
    borderWidth: number,
    scale: number,
    pressed: boolean,
    cursorSettings: CursorSettings
  ): void {
    // Draw cursor shadow (Screen Studio style - subtle drop shadow)
    ctx.beginPath();
    ctx.arc(canvasX + 1 * scale, canvasY + 2 * scale, cursorSize + borderWidth, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.fill();
    
    // Outer white border with subtle gradient
    const borderGradient = ctx.createRadialGradient(
      canvasX - cursorSize * 0.3, canvasY - cursorSize * 0.3, 0,
      canvasX, canvasY, cursorSize + borderWidth
    );
    borderGradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
    borderGradient.addColorStop(1, 'rgba(230, 230, 230, 0.95)');
    
    ctx.beginPath();
    ctx.arc(canvasX, canvasY, cursorSize + borderWidth, 0, Math.PI * 2);
    ctx.fillStyle = borderGradient;
    ctx.fill();
    
    // Inner circle with gradient (Screen Studio style)
    const innerGradient = ctx.createRadialGradient(
      canvasX - cursorSize * 0.3, canvasY - cursorSize * 0.3, 0,
      canvasX, canvasY, cursorSize
    );
    
    if (pressed) {
      // Green when pressed with gradient
      innerGradient.addColorStop(0, 'rgba(72, 198, 143, 1)');
      innerGradient.addColorStop(1, 'rgba(42, 158, 103, 1)');
    } else {
      // Normal color with gradient
      const color = cursorSettings.color || '#000000';
      const r = parseInt(color.slice(1, 3), 16);
      const g = parseInt(color.slice(3, 5), 16);
      const b = parseInt(color.slice(5, 7), 16);
      // Lighten for gradient start
      const lr = Math.min(255, r + 40);
      const lg = Math.min(255, g + 40);
      const lb = Math.min(255, b + 40);
      innerGradient.addColorStop(0, `rgba(${lr}, ${lg}, ${lb}, 1)`);
      innerGradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 1)`);
    }
    
    ctx.beginPath();
    ctx.arc(canvasX, canvasY, cursorSize, 0, Math.PI * 2);
    ctx.fillStyle = innerGradient;
    ctx.fill();
    
    // Small inner highlight (Screen Studio style - gives 3D effect)
    const highlightGradient = ctx.createRadialGradient(
      canvasX - cursorSize * 0.3, canvasY - cursorSize * 0.4, 0,
      canvasX, canvasY, cursorSize * 0.7
    );
    highlightGradient.addColorStop(0, 'rgba(255, 255, 255, 0.4)');
    highlightGradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
    
    ctx.beginPath();
    ctx.arc(canvasX, canvasY, cursorSize * 0.7, 0, Math.PI * 2);
    ctx.fillStyle = highlightGradient;
    ctx.fill();
  }

  private drawSvgCursor(
    ctx: CanvasRenderingContext2D,
    canvasX: number,
    canvasY: number,
    size: number,
    cursorType: 'pointer' | 'crosshair',
    pressed: boolean
  ): void {
    // Map cursor style to SVG type
    const svgType = cursorType === 'crosshair' ? 'crosshair' : (pressed ? 'circlePressed' : 'pointer');
    const cacheKey = `${svgType}-${Math.round(size)}`;
    
    // Try to get cached image
    const cachedImg = this.cursorImages.get(cacheKey);
    if (cachedImg) {
      const hotspot = getCursorHotspot(svgType);
      const drawX = canvasX - hotspot.x * size;
      const drawY = canvasY - hotspot.y * size;
      
      // Draw shadow
      ctx.save();
      ctx.globalAlpha = 0.3;
      ctx.drawImage(cachedImg, drawX + 2, drawY + 3, size, size);
      ctx.restore();
      
      // Draw cursor
      ctx.drawImage(cachedImg, drawX, drawY, size, size);
      return;
    }
    
    // Load image async and cache for next frame
    this.loadCursorImage(svgType, Math.round(size)).then(img => {
      if (img) {
        this.cursorImages.set(cacheKey, img);
      }
    });
    
    // Fallback: draw simple cursor while SVG loads
    ctx.beginPath();
    if (cursorType === 'pointer') {
      // macOS style pointer arrow
      const arrowScale = size * 0.05;
      
      // Arrow shape points (macOS pointer style)
      const arrowPath = [
        { x: 0, y: 0 },           // Tip
        { x: 0, y: 18 },          // Left side down
        { x: 4, y: 14 },          // Left inner
        { x: 7.5, y: 21 },        // Left of stem
        { x: 10.5, y: 19 },       // Right of stem
        { x: 7, y: 12 },          // Right inner
        { x: 12, y: 12 },         // Right wing
      ];
      
      // Draw shadow
      ctx.save();
      ctx.globalAlpha = 0.3;
      ctx.beginPath();
      ctx.moveTo(canvasX + arrowPath[0].x * arrowScale + 2, canvasY + arrowPath[0].y * arrowScale + 3);
      for (let i = 1; i < arrowPath.length; i++) {
        ctx.lineTo(canvasX + arrowPath[i].x * arrowScale + 2, canvasY + arrowPath[i].y * arrowScale + 3);
      }
      ctx.closePath();
      ctx.fillStyle = '#000000';
      ctx.fill();
      ctx.restore();
      
      // Draw black outline
      ctx.beginPath();
      ctx.moveTo(canvasX + arrowPath[0].x * arrowScale, canvasY + arrowPath[0].y * arrowScale);
      for (let i = 1; i < arrowPath.length; i++) {
        ctx.lineTo(canvasX + arrowPath[i].x * arrowScale, canvasY + arrowPath[i].y * arrowScale);
      }
      ctx.closePath();
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 2 * arrowScale;
      ctx.stroke();
      
      // Draw white fill
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      
      // Click indicator
      if (pressed) {
        const centerX = canvasX + 5 * arrowScale;
        const centerY = canvasY + 9 * arrowScale;
        ctx.beginPath();
        ctx.arc(centerX, centerY, size * 0.4, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(52, 178, 123, 0.4)';
        ctx.fill();
      }
    } else {
      // Crosshair
      const armLen = size * 0.4;
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 3;
      ctx.moveTo(canvasX - armLen, canvasY);
      ctx.lineTo(canvasX + armLen, canvasY);
      ctx.moveTo(canvasX, canvasY - armLen);
      ctx.lineTo(canvasX, canvasY + armLen);
      ctx.stroke();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.moveTo(canvasX - armLen, canvasY);
      ctx.lineTo(canvasX + armLen, canvasY);
      ctx.moveTo(canvasX, canvasY - armLen);
      ctx.lineTo(canvasX, canvasY + armLen);
      ctx.stroke();
    }
  }

  getCanvas(): HTMLCanvasElement {
    if (!this.compositeCanvas) {
      throw new Error('Renderer not initialized');
    }
    return this.compositeCanvas;
  }

  updateConfig(config: Partial<FrameRenderConfig>): void {
    this.config = { ...this.config, ...config };
    if (config.wallpaper) {
      this.setupBackground();
    }
  }

  destroy(): void {
    if (this.videoSprite) {
      this.videoSprite.destroy();
      this.videoSprite = null;
    }
    this.backgroundSprite = null;
    if (this.app) {
      this.app.destroy(true, { children: true, texture: true, textureSource: true });
      this.app = null;
    }
    this.cameraContainer = null;
    this.videoContainer = null;
    this.maskGraphics = null;
    this.blurFilter = null;
    this.shadowCanvas = null;
    this.shadowCtx = null;
    this.compositeCanvas = null;
    this.compositeCtx = null;
  }
}
