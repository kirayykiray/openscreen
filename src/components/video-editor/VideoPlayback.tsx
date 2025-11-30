import type React from "react";
import { useEffect, useRef, useImperativeHandle, forwardRef, useState, useMemo, useCallback } from "react";
import { getAssetPath } from "@/lib/assetPath";
import { Application, Container, Sprite, Graphics, BlurFilter, Texture, VideoSource } from 'pixi.js';
import { ZOOM_DEPTH_SCALES, type ZoomRegion, type ZoomFocus, type ZoomDepth, type CornerSettings } from "./types";
import { DEFAULT_FOCUS, SMOOTHING_FACTOR, MIN_DELTA } from "./videoPlayback/constants";
import { clamp01 } from "./videoPlayback/mathUtils";
import { findDominantRegion } from "./videoPlayback/zoomRegionUtils";
import { clampFocusToStage as clampFocusToStageUtil } from "./videoPlayback/focusUtils";
import { updateOverlayIndicator } from "./videoPlayback/overlayUtils";
import { layoutVideoContent as layoutVideoContentUtil } from "./videoPlayback/layoutUtils";
import { applyZoomTransform } from "./videoPlayback/zoomTransform";
import { createVideoEventHandlers } from "./videoPlayback/videoEventHandlers";
import type { CursorData } from "@/lib/cursor/cursorTracker";
import { interpolateCursorPosition, isCursorStationary, SpringCursorInterpolator } from "@/lib/cursor/cursorTracker";
import type { CursorSettings, ClickRipple, MotionTrail } from "@/lib/cursor/springPhysics";
import { 
  DEFAULT_CURSOR_SETTINGS, 
  CURSOR_SIZE_MAP, 
  createMotionTrail, 
  updateMotionTrail,
  createClickRipple,
  processClickRipples
} from "@/lib/cursor/springPhysics";

interface VideoPlaybackProps {
  videoPath: string;
  onDurationChange: (duration: number) => void;
  onTimeUpdate: (time: number) => void;
  onPlayStateChange: (playing: boolean) => void;
  onError: (error: string) => void;
  wallpaper?: string;
  zoomRegions: ZoomRegion[];
  selectedZoomId: string | null;
  onSelectZoom: (id: string | null) => void;
  onZoomFocusChange: (id: string, focus: ZoomFocus) => void;
  isPlaying: boolean;
  showShadow?: boolean;
  shadowIntensity?: number;
  showBlur?: boolean;
  cropRegion?: import('./types').CropRegion;
  cornerRadius?: number;
  cornerSettings?: CornerSettings;
  cursorData?: CursorData | null;
  showCursor?: boolean;
  cursorSettings?: CursorSettings;
  padding?: number; // 0-50: percentage of canvas to use as padding around video
}

export interface VideoPlaybackRef {
  video: HTMLVideoElement | null;
  app: Application | null;
  videoSprite: Sprite | null;
  videoContainer: Container | null;
  play: () => Promise<void>;
  pause: () => void;
}

const VideoPlayback = forwardRef<VideoPlaybackRef, VideoPlaybackProps>(({
  videoPath,
  onDurationChange,
  onTimeUpdate,
  onPlayStateChange,
  onError,
  wallpaper,
  zoomRegions,
  selectedZoomId,
  onSelectZoom,
  onZoomFocusChange,
  isPlaying,
  showShadow,
  shadowIntensity = 0,
  showBlur,
  cropRegion,
  cornerRadius = 0,
  cornerSettings,
  cursorData,
  showCursor = true,
  cursorSettings = DEFAULT_CURSOR_SETTINGS,
  padding = 0,
}, ref) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const appRef = useRef<Application | null>(null);
  const videoSpriteRef = useRef<Sprite | null>(null);
  const videoContainerRef = useRef<Container | null>(null);
  const cameraContainerRef = useRef<Container | null>(null);
  const timeUpdateAnimationRef = useRef<number | null>(null);
  const [pixiReady, setPixiReady] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const focusIndicatorRef = useRef<HTMLDivElement | null>(null);
  const currentTimeRef = useRef(0);
  const zoomRegionsRef = useRef<ZoomRegion[]>([]);
  const selectedZoomIdRef = useRef<string | null>(null);
  const animationStateRef = useRef({ scale: 1, focusX: DEFAULT_FOCUS.cx, focusY: DEFAULT_FOCUS.cy });
  const blurFilterRef = useRef<BlurFilter | null>(null);
  const isDraggingFocusRef = useRef(false);
  const stageSizeRef = useRef({ width: 0, height: 0 });
  const videoSizeRef = useRef({ width: 0, height: 0 });
  const baseScaleRef = useRef(1);
  const baseOffsetRef = useRef({ x: 0, y: 0 });
  const baseMaskRef = useRef({ x: 0, y: 0, width: 0, height: 0 });
  const cropBoundsRef = useRef({ startX: 0, endX: 0, startY: 0, endY: 0 });
  const maskGraphicsRef = useRef<Graphics | null>(null);
  const isPlayingRef = useRef(isPlaying);
  const isSeekingRef = useRef(false);
  const allowPlaybackRef = useRef(false);
  const lockedVideoDimensionsRef = useRef<{ width: number; height: number } | null>(null);
  const layoutVideoContentRef = useRef<(() => void) | null>(null);
  const cursorGraphicsRef = useRef<Graphics | null>(null);
  const cursorDataRef = useRef<CursorData | null>(null);
  const showCursorRef = useRef(showCursor);
  const cursorSettingsRef = useRef<CursorSettings>(cursorSettings);
  const springInterpolatorRef = useRef<SpringCursorInterpolator>(new SpringCursorInterpolator(cursorSettings.springPreset));
  const motionTrailRef = useRef<MotionTrail>(createMotionTrail(5));
  const clickRipplesRef = useRef<ClickRipple[]>([]);
  const lastPressedRef = useRef(false);

  const clampFocusToStage = useCallback((focus: ZoomFocus, depth: ZoomDepth) => {
    return clampFocusToStageUtil(focus, depth, stageSizeRef.current);
  }, []);

  const updateOverlayForRegion = useCallback((region: ZoomRegion | null, focusOverride?: ZoomFocus) => {
    const overlayEl = overlayRef.current;
    const indicatorEl = focusIndicatorRef.current;
    
    if (!overlayEl || !indicatorEl) {
      return;
    }

    // Update stage size from overlay dimensions
    const stageWidth = overlayEl.clientWidth;
    const stageHeight = overlayEl.clientHeight;
    if (stageWidth && stageHeight) {
      stageSizeRef.current = { width: stageWidth, height: stageHeight };
    }

    updateOverlayIndicator({
      overlayEl,
      indicatorEl,
      region,
      focusOverride,
      videoSize: videoSizeRef.current,
      baseScale: baseScaleRef.current,
      isPlaying: isPlayingRef.current,
    });
  }, []);

  const layoutVideoContent = useCallback(() => {
    const container = containerRef.current;
    const app = appRef.current;
    const videoSprite = videoSpriteRef.current;
    const maskGraphics = maskGraphicsRef.current;
    const videoElement = videoRef.current;
    const cameraContainer = cameraContainerRef.current;

    if (!container || !app || !videoSprite || !maskGraphics || !videoElement || !cameraContainer) {
      return;
    }

    // Lock video dimensions on first layout to prevent resize issues
    if (!lockedVideoDimensionsRef.current && videoElement.videoWidth > 0 && videoElement.videoHeight > 0) {
      lockedVideoDimensionsRef.current = {
        width: videoElement.videoWidth,
        height: videoElement.videoHeight,
      };
    }

    const result = layoutVideoContentUtil({
      container,
      app,
      videoSprite,
      maskGraphics,
      videoElement,
      cropRegion,
      lockedVideoDimensions: lockedVideoDimensionsRef.current,
      cornerRadius,
      cornerSettings,
      padding,
    });

    if (result) {
      stageSizeRef.current = result.stageSize;
      videoSizeRef.current = result.videoSize;
      baseScaleRef.current = result.baseScale;
      baseOffsetRef.current = result.baseOffset;
      baseMaskRef.current = result.maskRect;
      cropBoundsRef.current = result.cropBounds;

      // Reset camera container to identity
      cameraContainer.scale.set(1);
      cameraContainer.position.set(0, 0);

      const selectedId = selectedZoomIdRef.current;
      const activeRegion = selectedId
        ? zoomRegionsRef.current.find((region) => region.id === selectedId) ?? null
        : null;

      updateOverlayForRegion(activeRegion);
    }
  }, [updateOverlayForRegion, cropRegion, cornerRadius, cornerSettings, padding]);

  useEffect(() => {
    layoutVideoContentRef.current = layoutVideoContent;
  }, [layoutVideoContent]);

  const selectedZoom = useMemo(() => {
    if (!selectedZoomId) return null;
    return zoomRegions.find((region) => region.id === selectedZoomId) ?? null;
  }, [zoomRegions, selectedZoomId]);

  useImperativeHandle(ref, () => ({
    video: videoRef.current,
    app: appRef.current,
    videoSprite: videoSpriteRef.current,
    videoContainer: videoContainerRef.current,
    play: async () => {
      const video = videoRef.current;
      if (!video) {
        allowPlaybackRef.current = false;
        return;
      }
      allowPlaybackRef.current = true;
      try {
        await video.play();
      } catch (error) {
        allowPlaybackRef.current = false;
        throw error;
      }
    },
    pause: () => {
      const video = videoRef.current;
      allowPlaybackRef.current = false;
      if (!video) {
        return;
      }
      video.pause();
    },
  }));

  const updateFocusFromClientPoint = (clientX: number, clientY: number) => {
    const overlayEl = overlayRef.current;
    if (!overlayEl) return;

    const regionId = selectedZoomIdRef.current;
    if (!regionId) return;

    const region = zoomRegionsRef.current.find((r) => r.id === regionId);
    if (!region) return;

    const rect = overlayEl.getBoundingClientRect();
    const stageWidth = rect.width;
    const stageHeight = rect.height;

    if (!stageWidth || !stageHeight) {
      return;
    }

    stageSizeRef.current = { width: stageWidth, height: stageHeight };

    const localX = clientX - rect.left;
    const localY = clientY - rect.top;

    const unclampedFocus: ZoomFocus = {
      cx: clamp01(localX / stageWidth),
      cy: clamp01(localY / stageHeight),
    };
    const clampedFocus = clampFocusToStage(unclampedFocus, region.depth);

    onZoomFocusChange(region.id, clampedFocus);
    updateOverlayForRegion({ ...region, focus: clampedFocus }, clampedFocus);
  };

  const handleOverlayPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (isPlayingRef.current) return;
    const regionId = selectedZoomIdRef.current;
    if (!regionId) return;
    const region = zoomRegionsRef.current.find((r) => r.id === regionId);
    if (!region) return;
    onSelectZoom(region.id);
    event.preventDefault();
    isDraggingFocusRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    updateFocusFromClientPoint(event.clientX, event.clientY);
  };

  const handleOverlayPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingFocusRef.current) return;
    event.preventDefault();
    updateFocusFromClientPoint(event.clientX, event.clientY);
  };

  const endFocusDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingFocusRef.current) return;
    isDraggingFocusRef.current = false;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      
    }
  };

  const handleOverlayPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    endFocusDrag(event);
  };

  const handleOverlayPointerLeave = (event: React.PointerEvent<HTMLDivElement>) => {
    endFocusDrag(event);
  };

  useEffect(() => {
    zoomRegionsRef.current = zoomRegions;
  }, [zoomRegions]);

  useEffect(() => {
    selectedZoomIdRef.current = selectedZoomId;
  }, [selectedZoomId]);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  // Keep cursor data and showCursor in sync
  useEffect(() => {
    cursorDataRef.current = cursorData ?? null;
  }, [cursorData]);

  useEffect(() => {
    showCursorRef.current = showCursor;
  }, [showCursor]);

  // Keep cursor settings in sync
  useEffect(() => {
    cursorSettingsRef.current = cursorSettings;
    // Use smoothness value if available, otherwise use preset
    if (cursorSettings.smoothness !== undefined) {
      springInterpolatorRef.current.setSmoothness(cursorSettings.smoothness);
    } else {
      springInterpolatorRef.current.setPreset(cursorSettings.springPreset);
    }
  }, [cursorSettings]);

  useEffect(() => {
    if (!pixiReady || !videoReady) return;

    const app = appRef.current;
    const cameraContainer = cameraContainerRef.current;
    const video = videoRef.current;

    if (!app || !cameraContainer || !video) return;

    const tickerWasStarted = app.ticker?.started || false;
    if (tickerWasStarted && app.ticker) {
      app.ticker.stop();
    }

    const wasPlaying = !video.paused;
    if (wasPlaying) {
      video.pause();
    }

    animationStateRef.current = {
      scale: 1,
      focusX: DEFAULT_FOCUS.cx,
      focusY: DEFAULT_FOCUS.cy,
    };

    if (blurFilterRef.current) {
      blurFilterRef.current.blur = 0;
    }

    requestAnimationFrame(() => {
      const container = cameraContainerRef.current;
      const videoStage = videoContainerRef.current;
      const sprite = videoSpriteRef.current;
      const currentApp = appRef.current;
      if (!container || !videoStage || !sprite || !currentApp) {
        return;
      }

      container.scale.set(1);
      container.position.set(0, 0);
      videoStage.scale.set(1);
      videoStage.position.set(0, 0);
      sprite.scale.set(1);
      sprite.position.set(0, 0);

      layoutVideoContent();

      applyZoomTransform({
        cameraContainer: container,
        blurFilter: blurFilterRef.current,
        stageSize: stageSizeRef.current,
        baseMask: baseMaskRef.current,
        zoomScale: 1,
        focusX: DEFAULT_FOCUS.cx,
        focusY: DEFAULT_FOCUS.cy,
        motionIntensity: 0,
        isPlaying: false,
      });

      requestAnimationFrame(() => {
        const finalApp = appRef.current;
        if (wasPlaying && video) {
          video.play().catch(() => {
          });
        }
        if (tickerWasStarted && finalApp?.ticker) {
          finalApp.ticker.start();
        }
      });
    });
  }, [pixiReady, videoReady, layoutVideoContent, cropRegion, cornerRadius, cornerSettings]);

  useEffect(() => {
    if (!pixiReady || !videoReady) return;
    const container = containerRef.current;
    if (!container) return;

    if (typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver(() => {
      layoutVideoContent();
    });

    observer.observe(container);
    return () => {
      observer.disconnect();
    };
  }, [pixiReady, videoReady, layoutVideoContent]);

  useEffect(() => {
    if (!pixiReady || !videoReady) return;
    updateOverlayForRegion(selectedZoom);
  }, [selectedZoom, pixiReady, videoReady, updateOverlayForRegion]);

  useEffect(() => {
    const overlayEl = overlayRef.current;
    if (!overlayEl) return;
    if (!selectedZoom) {
      overlayEl.style.cursor = 'default';
      overlayEl.style.pointerEvents = 'none';
      return;
    }
    overlayEl.style.cursor = isPlaying ? 'not-allowed' : 'grab';
    overlayEl.style.pointerEvents = isPlaying ? 'none' : 'auto';
  }, [selectedZoom, isPlaying]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let mounted = true;
    let app: Application | null = null;

    (async () => {
      app = new Application();
      
      await app.init({
        width: container.clientWidth,
        height: container.clientHeight,
        backgroundAlpha: 0,
        antialias: true,
        resolution: window.devicePixelRatio || 1,
        autoDensity: true,
      });

      app.ticker.maxFPS = 60;

      if (!mounted) {
        app.destroy(true, { children: true, texture: true, textureSource: true });
        return;
      }

      appRef.current = app;
      container.appendChild(app.canvas);

      // Camera container - this will be scaled/positioned for zoom
      const cameraContainer = new Container();
      cameraContainerRef.current = cameraContainer;
      app.stage.addChild(cameraContainer);

      // Video container - holds the masked video sprite
      const videoContainer = new Container();
      videoContainerRef.current = videoContainer;
      cameraContainer.addChild(videoContainer);

      // Cursor graphics - rendered on top of video
      const cursorGraphics = new Graphics();
      cursorGraphicsRef.current = cursorGraphics;
      cameraContainer.addChild(cursorGraphics);
      
      setPixiReady(true);
    })();

    return () => {
      mounted = false;
      setPixiReady(false);
      if (app && app.renderer) {
        app.destroy(true, { children: true, texture: true, textureSource: true });
      }
      appRef.current = null;
      cameraContainerRef.current = null;
      videoContainerRef.current = null;
      videoSpriteRef.current = null;
      cursorGraphicsRef.current = null;
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    video.currentTime = 0;
    allowPlaybackRef.current = false;
  }, [videoPath]);



  useEffect(() => {
    if (!pixiReady || !videoReady) return;

    const video = videoRef.current;
    const app = appRef.current;
    const videoContainer = videoContainerRef.current;
    
    if (!video || !app || !videoContainer) return;
    if (video.videoWidth === 0 || video.videoHeight === 0) return;
    
    // Ensure video has at least one frame loaded before creating texture
    const createVideoTexture = () => {
      // Create VideoSource for PixiJS 8 with proper type casting
      const source = VideoSource.from(video) as VideoSource;
      // Set properties after creation - use type assertion for protected properties
      (source as any).autoPlay = false;
      source.autoUpdate = true;
      source.updateFPS = 0; // Update every frame
      
      const videoTexture = Texture.from(source);
      
      const videoSprite = new Sprite(videoTexture);
      videoSpriteRef.current = videoSprite;
      
      const maskGraphics = new Graphics();
      videoContainer.addChild(videoSprite);
      videoContainer.addChild(maskGraphics);
      videoContainer.mask = maskGraphics;
      maskGraphicsRef.current = maskGraphics;

      animationStateRef.current = {
        scale: 1,
        focusX: DEFAULT_FOCUS.cx,
        focusY: DEFAULT_FOCUS.cy,
      };

      const blurFilter = new BlurFilter();
      blurFilter.quality = 3;
      blurFilter.resolution = app.renderer.resolution;
      blurFilter.blur = 0;
      videoContainer.filters = [blurFilter];
      blurFilterRef.current = blurFilter;
      
      layoutVideoContent();
      video.pause();

      const { handlePlay, handlePause, handleSeeked, handleSeeking } = createVideoEventHandlers({
        video,
        isSeekingRef,
        isPlayingRef,
        allowPlaybackRef,
        currentTimeRef,
        timeUpdateAnimationRef,
        onPlayStateChange,
        onTimeUpdate,
      });
      
      video.addEventListener('play', handlePlay);
      video.addEventListener('pause', handlePause);
      video.addEventListener('ended', handlePause);
      video.addEventListener('seeked', handleSeeked);
      video.addEventListener('seeking', handleSeeking);
      
      return () => {
        video.removeEventListener('play', handlePlay);
        video.removeEventListener('pause', handlePause);
        video.removeEventListener('ended', handlePause);
        video.removeEventListener('seeked', handleSeeked);
        video.removeEventListener('seeking', handleSeeking);
        
        if (timeUpdateAnimationRef.current) {
          cancelAnimationFrame(timeUpdateAnimationRef.current);
        }
        
        if (videoSprite) {
          videoContainer.removeChild(videoSprite);
          videoSprite.destroy();
        }
        if (maskGraphics) {
          videoContainer.removeChild(maskGraphics);
          maskGraphics.destroy();
        }
        videoContainer.mask = null;
        maskGraphicsRef.current = null;
        if (blurFilterRef.current) {
          videoContainer.filters = [];
          blurFilterRef.current.destroy();
          blurFilterRef.current = null;
        }
        videoTexture.destroy(true);
        
        videoSpriteRef.current = null;
      };
    };

    // Wait for video to have actual frame data
    if (video.readyState >= 2) {
      return createVideoTexture();
    } else {
      const handleCanPlay = () => {
        video.removeEventListener('canplay', handleCanPlay);
        createVideoTexture();
      };
      video.addEventListener('canplay', handleCanPlay);
      return () => {
        video.removeEventListener('canplay', handleCanPlay);
      };
    }
  }, [pixiReady, videoReady, onTimeUpdate, updateOverlayForRegion]);

  useEffect(() => {
    if (!pixiReady || !videoReady) return;

    const app = appRef.current;
    const videoSprite = videoSpriteRef.current;
    const videoContainer = videoContainerRef.current;
    if (!app || !videoSprite || !videoContainer) return;

    const applyTransform = (motionIntensity: number) => {
      const cameraContainer = cameraContainerRef.current;
      if (!cameraContainer) return;

      const state = animationStateRef.current;

      applyZoomTransform({
        cameraContainer,
        blurFilter: blurFilterRef.current,
        stageSize: stageSizeRef.current,
        baseMask: baseMaskRef.current,
        zoomScale: state.scale,
        focusX: state.focusX,
        focusY: state.focusY,
        motionIntensity,
        isPlaying: isPlayingRef.current,
      });
    };

    const ticker = () => {
      // currentTimeRef is in seconds, convert to ms for zoom region calculations
      const currentTimeMs = currentTimeRef.current * 1000;
      const { region, strength } = findDominantRegion(zoomRegionsRef.current, currentTimeMs);
      
      const defaultFocus = DEFAULT_FOCUS;
      let targetScaleFactor = 1;
      let targetFocus = defaultFocus;

      // If a zoom is selected but video is not playing, show default unzoomed view
      // (the overlay will show where the zoom will be)
      const selectedId = selectedZoomIdRef.current;
      const hasSelectedZoom = selectedId !== null;
      const shouldShowUnzoomedView = hasSelectedZoom && !isPlayingRef.current;

      if (region && strength > 0 && !shouldShowUnzoomedView) {
        const zoomScale = ZOOM_DEPTH_SCALES[region.depth];
        const regionFocus = clampFocusToStage(region.focus, region.depth);
        
        // Interpolate scale and focus based on region strength
        targetScaleFactor = 1 + (zoomScale - 1) * strength;
        targetFocus = {
          cx: defaultFocus.cx + (regionFocus.cx - defaultFocus.cx) * strength,
          cy: defaultFocus.cy + (regionFocus.cy - defaultFocus.cy) * strength,
        };
      }

      const state = animationStateRef.current;

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

      const motionIntensity = Math.max(
        Math.abs(nextScale - prevScale),
        Math.abs(nextFocusX - prevFocusX),
        Math.abs(nextFocusY - prevFocusY)
      );

      applyTransform(motionIntensity);

      // Render cursor
      const cursorGfx = cursorGraphicsRef.current;
      const curData = cursorDataRef.current;
      if (cursorGfx) {
        cursorGfx.clear();
        
        if (showCursorRef.current && curData && curData.positions && curData.positions.length > 0) {
          const timeMs = currentTimeRef.current * 1000;
          const cursorPos = interpolateCursorPosition(curData, timeMs);
          
          // Debug: Log cursor position periodically (every second)
          if (Math.floor(timeMs / 1000) !== Math.floor((timeMs - 50) / 1000)) {
            // Debug log removed, 'rawPos:', cursorPos?.x?.toFixed(0), cursorPos?.y?.toFixed(0), 'totalPositions:', curData.positions.length, 'screenW:', curData.screenWidth, 'screenH:', curData.screenHeight);
          }
          
          if (cursorPos) {
            const settings = cursorSettingsRef.current;
            
            // Calculate cursor position on stage
            const videoW = videoSizeRef.current.width || curData.screenWidth;
            const videoH = videoSizeRef.current.height || curData.screenHeight;
            const scale = baseScaleRef.current;
            const offset = baseOffsetRef.current;
            
            // Get raw position - map cursor position to video coordinates
            const rawX = offset.x + (cursorPos.x / curData.screenWidth) * videoW * scale;
            const rawY = offset.y + (cursorPos.y / curData.screenHeight) * videoH * scale;
            
            // Apply spring physics for smooth movement (Screen Studio style trailing)
            const springState = springInterpolatorRef.current.update(rawX, rawY, timeMs);
            const stageX = springState.x;
            const stageY = springState.y;
            const velocity = springInterpolatorRef.current.getVelocity();
            
            // Cursor size based on settings
            const baseCursorSize = CURSOR_SIZE_MAP[settings.size];
            const cursorSize = baseCursorSize * scale * 0.5; // Scaled to video size
            const borderWidth = 1.5 * scale;
            
            // Parse color from settings (default to dark)
            const cursorColorHex = settings.color || '#1a1a1a';
            const cursorColor = parseInt(cursorColorHex.slice(1), 16) || 0x1a1a1a;
            const glowColorHex = settings.glowColor || '#34B27B';
            const glowColor = parseInt(glowColorHex.slice(1), 16) || 0x34B27B;
            
            // Auto-hide: check if cursor is stationary
            let shouldHideCursor = false;
            if (settings.autoHide) {
              const hideDelay = settings.autoHideDelay || 3000;
              const isStationary = isCursorStationary(curData, timeMs, hideDelay);
              shouldHideCursor = isStationary;
            }
            
            // Skip drawing cursor if hidden
            if (shouldHideCursor) {
              // Don't draw cursor, but still process ripples etc.
            } else {
              // Detect new click for ripple
              if (cursorPos.pressed && !lastPressedRef.current && settings.showRipple) {
                clickRipplesRef.current.push(createClickRipple(stageX, stageY, timeMs));
              }
              lastPressedRef.current = cursorPos.pressed;
              
              // Update motion trail
              if (settings.motionBlur && velocity > 50) {
                motionTrailRef.current = updateMotionTrail(
                  motionTrailRef.current, 
                  stageX, 
                  stageY, 
                  velocity,
                  timeMs
                );
                
                // Draw motion trail - smooth gradient trail
                const trail = motionTrailRef.current;
                for (let i = trail.positions.length - 1; i >= 0; i--) {
                  const pos = trail.positions[i];
                  const progress = i / trail.positions.length;
                  const trailSize = cursorSize * (0.3 + progress * 0.5);
                  cursorGfx.circle(pos.x, pos.y, trailSize);
                  cursorGfx.fill({ color: cursorColor, alpha: pos.alpha * 0.3 });
                }
              }
              
              // Draw click ripples (Screen Studio style - expanding rings)
              if (settings.showRipple) {
                const activeRipples = processClickRipples(clickRipplesRef.current, timeMs);
                clickRipplesRef.current = clickRipplesRef.current.filter(
                  r => (timeMs - r.startTime) < r.duration
                );
                
                for (const ripple of activeRipples) {
                  // First ring
                  const ring1Size = cursorSize * (1.2 + ripple.progress * 4);
                  const ring1Alpha = (1 - ripple.progress) * 0.5;
                  cursorGfx.circle(ripple.x, ripple.y, ring1Size);
                  cursorGfx.stroke({ color: glowColor, width: 3 * scale, alpha: ring1Alpha });
                  
                  // Second ring (delayed)
                  const ring2Progress = Math.max(0, ripple.progress - 0.15) / 0.85;
                  if (ring2Progress > 0) {
                    const ring2Size = cursorSize * (1.2 + ring2Progress * 5);
                    const ring2Alpha = (1 - ring2Progress) * 0.3;
                    cursorGfx.circle(ripple.x, ripple.y, ring2Size);
                    cursorGfx.stroke({ color: glowColor, width: 2 * scale, alpha: ring2Alpha });
                  }
                }
              }
              
              // Draw highlight (spotlight effect behind cursor)
              if (settings.showHighlight) {
                const highlightSize = cursorSize * 6;
                cursorGfx.circle(stageX, stageY, highlightSize);
                cursorGfx.fill({ color: 0xffffff, alpha: 0.15 });
                cursorGfx.circle(stageX, stageY, highlightSize * 0.6);
                cursorGfx.fill({ color: 0xffffff, alpha: 0.1 });
              }
              
              // Draw glow effect
              if (settings.showGlow) {
                const glowIntensity = settings.glowIntensity || 0.5;
                const glowSize = cursorSize * (3 + glowIntensity * 2);
                cursorGfx.circle(stageX, stageY, glowSize);
                cursorGfx.fill({ color: glowColor, alpha: 0.2 * glowIntensity });
                cursorGfx.circle(stageX, stageY, glowSize * 0.6);
                cursorGfx.fill({ color: glowColor, alpha: 0.3 * glowIntensity });
              }
              
              // --- macOS STYLE POINTER CURSOR ---
              // The cursor style can be 'pointer' (arrow) or 'circle' (dot)
              const cursorStyle = settings.cursorStyle || 'pointer';
              
              if (cursorStyle === 'circle') {
                // Circle/dot cursor (Screen Studio style)
                // Drop shadow
                cursorGfx.circle(stageX + 1 * scale, stageY + 2 * scale, cursorSize + borderWidth);
                cursorGfx.fill({ color: 0x000000, alpha: 0.25 });
                
                // Outer white ring
                cursorGfx.circle(stageX, stageY, cursorSize + borderWidth);
                cursorGfx.fill({ color: 0xffffff, alpha: 1 });
                
                // Inner circle
                if (cursorPos.pressed) {
                  cursorGfx.circle(stageX, stageY, cursorSize);
                  cursorGfx.fill({ color: glowColor, alpha: 1 });
                  cursorGfx.circle(stageX - cursorSize * 0.2, stageY - cursorSize * 0.2, cursorSize * 0.4);
                  cursorGfx.fill({ color: 0x5FD89E, alpha: 0.6 });
                  cursorGfx.circle(stageX, stageY, cursorSize * 2);
                  cursorGfx.fill({ color: glowColor, alpha: 0.2 });
                } else {
                  cursorGfx.circle(stageX, stageY, cursorSize);
                  cursorGfx.fill({ color: cursorColor, alpha: 1 });
                  // Lighter highlight
                  const highlightColor = cursorColor === 0x1a1a1a ? 0x4a4a4a : 0xffffff;
                  cursorGfx.circle(stageX - cursorSize * 0.2, stageY - cursorSize * 0.2, cursorSize * 0.35);
                  cursorGfx.fill({ color: highlightColor, alpha: 0.5 });
                }
              } else {
                // macOS Pointer Arrow cursor (default)
                // This draws a proper macOS-style cursor arrow
                const arrowScale = scale * 1.2; // Scale factor for the arrow (relative to video scale)
                
                // Arrow shape points (macOS pointer style) - pointing top-left
                // The arrow tip is at (0, 0) relative to stageX, stageY
                const arrowPath = [
                  { x: 0, y: 0 },           // Tip
                  { x: 0, y: 18 },          // Left side down
                  { x: 4, y: 14 },          // Left inner
                  { x: 7.5, y: 21 },        // Left of stem
                  { x: 10.5, y: 19 },       // Right of stem
                  { x: 7, y: 12 },          // Right inner
                  { x: 12, y: 12 },         // Right wing
                ];
                
                // Draw drop shadow (offset and darker)
                cursorGfx.poly(arrowPath.map(p => ({ x: stageX + p.x * arrowScale + 1, y: stageY + p.y * arrowScale + 2 })));
                cursorGfx.fill({ color: 0x000000, alpha: 0.3 });
                
                // Draw the black outline (stroke)
                cursorGfx.poly(arrowPath.map(p => ({ x: stageX + p.x * arrowScale, y: stageY + p.y * arrowScale })));
                cursorGfx.stroke({ color: 0x000000, width: 2.5 * arrowScale, alpha: 1 });
                
                // Draw white fill
                cursorGfx.poly(arrowPath.map(p => ({ x: stageX + p.x * arrowScale, y: stageY + p.y * arrowScale })));
                cursorGfx.fill({ color: 0xffffff, alpha: 1 });
                
                // Add a subtle highlight on the left side for 3D effect
                const highlightPath = [
                  { x: 0.5, y: 1 },
                  { x: 0.5, y: 14 },
                  { x: 3, y: 11 },
                ];
                cursorGfx.poly(highlightPath.map(p => ({ x: stageX + p.x * arrowScale, y: stageY + p.y * arrowScale })));
                cursorGfx.fill({ color: 0xffffff, alpha: 0.3 });
                
                // Click indicator - add colored glow when pressed
                if (cursorPos.pressed) {
                  // Green glow behind cursor when clicking
                  cursorGfx.circle(stageX + 5 * arrowScale, stageY + 9 * arrowScale, 20 * arrowScale);
                  cursorGfx.fill({ color: glowColor, alpha: 0.3 });
                  
                  // Smaller green highlight
                  cursorGfx.circle(stageX + 5 * arrowScale, stageY + 9 * arrowScale, 12 * arrowScale);
                  cursorGfx.fill({ color: glowColor, alpha: 0.4 });
                }
              }
            }
          }
        }
      }
    };

    app.ticker.add(ticker);
    return () => {
      if (app && app.ticker) {
        app.ticker.remove(ticker);
      }
    };
  }, [pixiReady, videoReady, clampFocusToStage]);

  const handleLoadedMetadata = (e: React.SyntheticEvent<HTMLVideoElement, Event>) => {
    const video = e.currentTarget;
    onDurationChange(video.duration);
    video.currentTime = 0;
    video.pause();
    allowPlaybackRef.current = false;
    currentTimeRef.current = 0;
    
    // Wait for video to have actual frame data before marking as ready
    const checkReady = () => {
      if (video.readyState >= 2) {
        setVideoReady(true);
      } else {
        video.addEventListener('canplay', () => setVideoReady(true), { once: true });
      }
    };
    
    // Use requestVideoFrameCallback if available for more accurate frame timing
    if ('requestVideoFrameCallback' in video) {
      (video as any).requestVideoFrameCallback(() => {
        checkReady();
      });
    } else {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          checkReady();
        });
      });
    }
  };

  const [resolvedWallpaper, setResolvedWallpaper] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true
    ;(async () => {
      try {
        if (!wallpaper) {
          const def = await getAssetPath('wallpapers/wallpaper1.jpg')
          if (mounted) setResolvedWallpaper(def)
          return
        }

        if (wallpaper.startsWith('#') || wallpaper.startsWith('linear-gradient') || wallpaper.startsWith('radial-gradient')) {
          if (mounted) setResolvedWallpaper(wallpaper)
          return
        }

        // If it's a data URL (custom uploaded image), use as-is
        if (wallpaper.startsWith('data:')) {
          if (mounted) setResolvedWallpaper(wallpaper)
          return
        }

        // If it's an absolute web/http or file path, use as-is
        if (wallpaper.startsWith('http') || wallpaper.startsWith('file://') || wallpaper.startsWith('/')) {
          // If it's an absolute server path (starts with '/'), resolve via getAssetPath as well
          if (wallpaper.startsWith('/')) {
            const rel = wallpaper.replace(/^\//, '')
            const p = await getAssetPath(rel)
            if (mounted) setResolvedWallpaper(p)
            return
          }
          if (mounted) setResolvedWallpaper(wallpaper)
          return
        }
        const p = await getAssetPath(wallpaper.replace(/^\//, ''))
        if (mounted) setResolvedWallpaper(p)
      } catch (err) {
        if (mounted) setResolvedWallpaper(wallpaper || '/wallpapers/wallpaper1.jpg')
      }
    })()
    return () => { mounted = false }
  }, [wallpaper])

  const isImageUrl = Boolean(resolvedWallpaper && (resolvedWallpaper.startsWith('file://') || resolvedWallpaper.startsWith('http') || resolvedWallpaper.startsWith('/') || resolvedWallpaper.startsWith('data:')))
  const backgroundStyle = isImageUrl
    ? { backgroundImage: `url(${resolvedWallpaper || ''})` }
    : { background: resolvedWallpaper || '' };

  return (
    <div className="relative aspect-video rounded-sm overflow-hidden" style={{ width: '100%' }}>
      {/* Background layer - always render as DOM element with blur */}
      <div
        className="absolute inset-0 bg-cover bg-center"
        style={{
          ...backgroundStyle,
          filter: showBlur ? 'blur(2px)' : 'none',
        }}
      />
      <div
        ref={containerRef}
        className="absolute inset-0"
        style={{
          filter: (showShadow && shadowIntensity > 0)
            ? `drop-shadow(0 ${shadowIntensity * 12}px ${shadowIntensity * 48}px rgba(0,0,0,${shadowIntensity * 0.7})) drop-shadow(0 ${shadowIntensity * 4}px ${shadowIntensity * 16}px rgba(0,0,0,${shadowIntensity * 0.5})) drop-shadow(0 ${shadowIntensity * 2}px ${shadowIntensity * 8}px rgba(0,0,0,${shadowIntensity * 0.3}))`
            : 'none',
        }}
      />
      {/* Only render overlay after PIXI and video are fully initialized */}
      {pixiReady && videoReady && (
        <div
          ref={overlayRef}
          className="absolute inset-0 select-none"
          style={{ pointerEvents: 'none' }}
          onPointerDown={handleOverlayPointerDown}
          onPointerMove={handleOverlayPointerMove}
          onPointerUp={handleOverlayPointerUp}
          onPointerLeave={handleOverlayPointerLeave}
        >
          <div
            ref={focusIndicatorRef}
            className="absolute rounded-md border border-[#34B27B]/80 bg-[#34B27B]/20 shadow-[0_0_0_1px_rgba(52,178,123,0.35)]"
            style={{ display: 'none', pointerEvents: 'none' }}
          />
        </div>
      )}
      <video
        ref={videoRef}
        src={videoPath}
        className="hidden"
        preload="metadata"
        playsInline
        onLoadedMetadata={handleLoadedMetadata}
        onDurationChange={e => {
          onDurationChange(e.currentTarget.duration);
        }}
        onError={() => onError('Failed to load video')}
      />
    </div>
  );
});

VideoPlayback.displayName = 'VideoPlayback';

export default VideoPlayback;
