

import { useCallback, useEffect, useRef, useState } from "react";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";

import VideoPlayback, { VideoPlaybackRef } from "./VideoPlayback";
import PlaybackControls from "./PlaybackControls";
import TimelineEditor from "./timeline/TimelineEditor";
import { SettingsPanel } from "./SettingsPanel";
import { ExportDialog } from "./ExportDialog";

import type { Span } from "dnd-timeline";
import {
  DEFAULT_ZOOM_DEPTH,
  clampFocusToDepth,
  DEFAULT_CROP_REGION,
  DEFAULT_CORNER_SETTINGS,
  type ZoomDepth,
  type ZoomFocus,
  type ZoomRegion,
  type CropRegion,
  type CornerSettings,
} from "./types";
import { VideoExporter, type ExportProgress } from "@/lib/exporter";
import type { CursorData } from "@/lib/cursor/cursorTracker";
import type { CursorSettings } from "@/lib/cursor/springPhysics";
import { DEFAULT_CURSOR_SETTINGS } from "@/lib/cursor/springPhysics";

const WALLPAPER_COUNT = 20;
const WALLPAPER_PATHS = Array.from({ length: WALLPAPER_COUNT }, (_, i) => `/wallpapers/wallpaper${i + 1}.jpg`);

export default function VideoEditor() {
  const [videoPath, setVideoPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [wallpaper, setWallpaper] = useState<string>(WALLPAPER_PATHS[0]);
  const [shadowIntensity, setShadowIntensity] = useState(0);
  const [showBlur, setShowBlur] = useState(false);
  const [cropRegion, setCropRegion] = useState<CropRegion>(DEFAULT_CROP_REGION);
  const [cornerSettings, setCornerSettings] = useState<CornerSettings>(DEFAULT_CORNER_SETTINGS);
  const [zoomRegions, setZoomRegions] = useState<ZoomRegion[]>([]);
  const [selectedZoomId, setSelectedZoomId] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [cursorData, setCursorData] = useState<CursorData | null>(null);
  const [showCursor, setShowCursor] = useState(true); // Enabled by default (system cursor hidden during recording)
  const [cursorSettings, setCursorSettings] = useState<CursorSettings>(DEFAULT_CURSOR_SETTINGS);
  const [padding, setPadding] = useState(20); // Default 20% padding (visible background)

  const videoPlaybackRef = useRef<VideoPlaybackRef>(null);
  const nextZoomIdRef = useRef(1);
  const exporterRef = useRef<VideoExporter | null>(null);

  // Helper to convert file path to proper file:// URL
  const toFileUrl = (filePath: string): string => {
    // Normalize path separators to forward slashes
    const normalized = filePath.replace(/\\/g, '/');
    
    // Check if it's a Windows absolute path (e.g., C:/Users/...)
    if (normalized.match(/^[a-zA-Z]:/)) {
      const fileUrl = `file:///${normalized}`;
      return fileUrl;
    }
    
    // Unix-style absolute path
    const fileUrl = `file://${normalized}`;
    return fileUrl;
  };

  useEffect(() => {
    async function loadVideo() {
      try {
        // Debug log removed
        const result = await window.electronAPI.getCurrentVideoPath();
        // Debug log removed
        
        if (result.success && result.path) {
          // Debug log removed
          const videoUrl = toFileUrl(result.path);
          // Debug log removed
          setVideoPath(videoUrl);
          
          // Try to load cursor data for this video
          // Debug log removed
          const cursorResult = await window.electronAPI.getCursorData(result.path);
          // Debug log removed
          if (cursorResult.success && cursorResult.data && cursorResult.data.positions) {
            setCursorData(cursorResult.data);
            // Debug log removed
          }
        } else {
          // Debug log removed
          setError('No video to load. Please record or select a video.');
        }
      } catch (err) {
        console.error('[VideoEditor] Error loading video:', err);
        setError('Error loading video: ' + String(err));
      } finally {
        setLoading(false);
      }
    }
    loadVideo();
  }, []);

  // Load settings from localStorage
  useEffect(() => {
    const savedSettings = localStorage.getItem("recordingSettings");
    if (savedSettings) {
      try {
        const settings = JSON.parse(savedSettings);
        if (settings.cornerRadius !== undefined) {
          setCornerSettings(prev => ({ ...prev, radius: settings.cornerRadius }));
        }
        if (settings.cornerSettings) {
          setCornerSettings(settings.cornerSettings);
        }
      } catch (e) {
        console.error("Failed to parse saved settings", e);
      }
    }
  }, []);

  function togglePlayPause() {
    const playback = videoPlaybackRef.current;
    const video = playback?.video;
    if (!playback || !video) return;

    if (isPlaying) {
      playback.pause();
    } else {
      playback.play().catch(err => console.error('Video play failed:', err));
    }
  }

  function handleSeek(time: number) {
    const video = videoPlaybackRef.current?.video;
    if (!video) return;
    video.currentTime = time;
  }

  const handleSelectZoom = useCallback((id: string | null) => {
    setSelectedZoomId(id);
  }, []);

  const handleZoomAdded = useCallback((span: Span) => {
    const id = `zoom-${nextZoomIdRef.current++}`;
    const newRegion: ZoomRegion = {
      id,
      startMs: Math.round(span.start),
      endMs: Math.round(span.end),
      depth: DEFAULT_ZOOM_DEPTH,
      focus: { cx: 0.5, cy: 0.5 },
    };
    // Debug log removed
    setZoomRegions((prev) => [...prev, newRegion]);
    setSelectedZoomId(id);
  }, []);

  const handleZoomSpanChange = useCallback((id: string, span: Span) => {
    // Debug log removed, end: Math.round(span.end) });
    setZoomRegions((prev) =>
      prev.map((region) =>
        region.id === id
          ? {
              ...region,
              startMs: Math.round(span.start),
              endMs: Math.round(span.end),
            }
          : region,
      ),
    );
  }, []);

  const handleZoomFocusChange = useCallback((id: string, focus: ZoomFocus) => {
    setZoomRegions((prev) =>
      prev.map((region) =>
        region.id === id
          ? {
              ...region,
              focus: clampFocusToDepth(focus, region.depth),
            }
          : region,
      ),
    );
  }, []);

  const handleZoomDepthChange = useCallback((depth: ZoomDepth) => {
    if (!selectedZoomId) return;
    setZoomRegions((prev) =>
      prev.map((region) =>
        region.id === selectedZoomId
          ? {
              ...region,
              depth,
              focus: clampFocusToDepth(region.focus, depth),
            }
          : region,
      ),
    );
  }, [selectedZoomId]);

  const handleZoomDelete = useCallback((id: string) => {
    // Debug log removed
    setZoomRegions((prev) => prev.filter((region) => region.id !== id));
    if (selectedZoomId === id) {
      setSelectedZoomId(null);
    }
  }, [selectedZoomId]);



  useEffect(() => {
    if (selectedZoomId && !zoomRegions.some((region) => region.id === selectedZoomId)) {
      setSelectedZoomId(null);
    }
  }, [selectedZoomId, zoomRegions]);

  const handleExport = useCallback(async () => {
    if (!videoPath) {
      toast.error('No video loaded');
      return;
    }

    const video = videoPlaybackRef.current?.video;
    if (!video) {
      toast.error('Video not ready');
      return;
    }

    setShowExportDialog(true);
    setIsExporting(true);
    setExportProgress(null);
    setExportError(null);

    try {
      const wasPlaying = isPlaying;
      if (wasPlaying) {
        videoPlaybackRef.current?.pause();
      }

      // Get actual video dimensions to match recording resolution
      const video = videoPlaybackRef.current?.video;
      if (!video) {
        toast.error('Video not ready');
        return;
      }
      
      const width = video.videoWidth || 1920;
      const height = video.videoHeight || 1080;

      // Use higher bitrates for better export quality
      const totalPixels = width * height;
      let bitrate = 50_000_000; // 50 Mbps base for 1080p
      if (totalPixels > 1920 * 1080 && totalPixels <= 2560 * 1440) {
        bitrate = 80_000_000; // 80 Mbps for 1440p
      } else if (totalPixels > 2560 * 1440) {
        bitrate = 120_000_000; // 120 Mbps for 4K
      }

      // Use 0 to let the exporter auto-detect from the source video
      // This ensures exports match the original recording frame rate
      const exportFrameRate = 0;

      const exporter = new VideoExporter({
        videoUrl: videoPath,
        width,
        height,
        frameRate: exportFrameRate,
        bitrate,
        codec: 'avc1.640033',
        wallpaper,
        zoomRegions,
        showShadow: shadowIntensity > 0,
        shadowIntensity,
        showBlur,
        cropRegion,
        cornerRadius: cornerSettings.radius,
        cornerSettings,
        cursorData,
        showCursor,
        cursorSettings,
        padding,
        onProgress: (progress: ExportProgress) => {
          setExportProgress(progress);
        },
      });

      exporterRef.current = exporter;
      const result = await exporter.export();

      if (result.success && result.blob) {
        const arrayBuffer = await result.blob.arrayBuffer();
        const timestamp = Date.now();
        const fileName = `export-${timestamp}.mp4`;
        
        const saveResult = await window.electronAPI.saveExportedVideo(arrayBuffer, fileName);
        
        if (saveResult.cancelled) {
          toast.info('Export cancelled');
        } else if (saveResult.success) {
          toast.success(`Video exported successfully to ${saveResult.path}`);
        } else {
          setExportError(saveResult.message || 'Failed to save video');
          toast.error(saveResult.message || 'Failed to save video');
        }
      } else {
        setExportError(result.error || 'Export failed');
        toast.error(result.error || 'Export failed');
      }

      if (wasPlaying) {
        videoPlaybackRef.current?.play();
      }
    } catch (error) {
      console.error('Export error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      setExportError(errorMessage);
      toast.error(`Export failed: ${errorMessage}`);
    } finally {
      setIsExporting(false);
      exporterRef.current = null;
    }
  }, [videoPath, wallpaper, zoomRegions, shadowIntensity, showBlur, cropRegion, isPlaying, cornerSettings, cursorData, showCursor, cursorSettings, padding]);

  const handleCancelExport = useCallback(() => {
    if (exporterRef.current) {
      exporterRef.current.cancel();
      toast.info('Export cancelled');
      setShowExportDialog(false);
      setIsExporting(false);
      setExportProgress(null);
      setExportError(null);
    }
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <div className="text-foreground">Loading video...</div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <div className="text-destructive">{error}</div>
      </div>
    );
  }


  return (
    <div className="flex flex-col h-screen bg-[#09090b] text-slate-200 overflow-hidden selection:bg-[#34B27B]/30">
      <div 
        className="h-10 flex-shrink-0 bg-[#09090b]/80 backdrop-blur-md border-b border-white/5 flex items-center justify-between px-6 z-50"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className="flex-1" />
      </div>

      <div className="flex-1 p-4 gap-4 flex min-h-0 relative">
        {/* Left Column - Video & Timeline */}
        <div className="flex-[7] flex flex-col gap-3 min-w-0 h-full">
          {/* Top section: video preview and controls */}
          <div className="w-full flex flex-col items-center justify-center bg-black/40 rounded-2xl border border-white/5 shadow-2xl overflow-hidden" style={{ height: '80%' }}>
            {/* Video preview */}
            <div className="w-full flex justify-center items-center" style={{ flex: '1 1 auto', padding: '24px 0' }}>
              <div className="relative" style={{ width: '100%', maxWidth: '1000px', aspectRatio: '16/9', boxSizing: 'border-box', overflow: 'hidden' }}>
                <VideoPlayback
                  ref={videoPlaybackRef}
                  videoPath={videoPath || ''}
                  onDurationChange={setDuration}
                  onTimeUpdate={setCurrentTime}
                  onPlayStateChange={setIsPlaying}
                  onError={setError}
                  wallpaper={wallpaper}
                  zoomRegions={zoomRegions}
                  selectedZoomId={selectedZoomId}
                  onSelectZoom={handleSelectZoom}
                  onZoomFocusChange={handleZoomFocusChange}
                  isPlaying={isPlaying}
                  showShadow={shadowIntensity > 0}
                  shadowIntensity={shadowIntensity}
                  showBlur={showBlur}
                  cropRegion={cropRegion}
                  cornerRadius={cornerSettings.radius}
                  cornerSettings={cornerSettings}
                  cursorData={cursorData}
                  showCursor={showCursor}
                  cursorSettings={cursorSettings}
                  padding={padding}
                />
              </div>
            </div>
            {/* Playback controls */}
            <div className="w-full flex justify-center items-center" style={{ padding: '0 0 24px 0' }}>
              <div style={{ maxWidth: '700px', width: '80%' }}>
                <PlaybackControls
                  isPlaying={isPlaying}
                  currentTime={currentTime}
                  duration={duration}
                  onTogglePlayPause={togglePlayPause}
                  onSeek={handleSeek}
                />
              </div>
            </div>
          </div>

          {/* Timeline section */}
          <div className="flex-1 min-h-[180px] bg-[#09090b] rounded-2xl border border-white/5 shadow-lg overflow-hidden flex flex-col">
            <TimelineEditor
              videoDuration={duration}
              currentTime={currentTime}
              onSeek={handleSeek}
              zoomRegions={zoomRegions}
              onZoomAdded={handleZoomAdded}
              onZoomSpanChange={handleZoomSpanChange}
              onZoomDelete={handleZoomDelete}
              selectedZoomId={selectedZoomId}
              onSelectZoom={handleSelectZoom}
            />
          </div>
        </div>

          {/* Right section: settings panel */}
        <SettingsPanel
          selected={wallpaper}
          onWallpaperChange={setWallpaper}
          selectedZoomDepth={selectedZoomId ? zoomRegions.find(z => z.id === selectedZoomId)?.depth : null}
          onZoomDepthChange={(depth) => selectedZoomId && handleZoomDepthChange(depth)}
          selectedZoomId={selectedZoomId}
          onZoomDelete={handleZoomDelete}
          shadowIntensity={shadowIntensity}
          onShadowChange={setShadowIntensity}
          showBlur={showBlur}
          onBlurChange={setShowBlur}
          cropRegion={cropRegion}
          onCropChange={setCropRegion}
          cornerRadius={cornerSettings.radius}
          onCornerRadiusChange={(r) => setCornerSettings(prev => ({ ...prev, radius: r }))}
          cornerSettings={cornerSettings}
          onCornerSettingsChange={setCornerSettings}
          videoElement={videoPlaybackRef.current?.video || null}
          onExport={handleExport}
          showCursor={showCursor}
          onShowCursorChange={setShowCursor}
          hasCursorData={cursorData !== null && cursorData.positions && cursorData.positions.length > 0}
          cursorSettings={cursorSettings}
          onCursorSettingsChange={setCursorSettings}
          padding={padding}
          onPaddingChange={setPadding}
        />
      </div>

      <Toaster theme="dark" className="pointer-events-auto" />
      
      <ExportDialog
        isOpen={showExportDialog}
        onClose={() => setShowExportDialog(false)}
        progress={exportProgress}
        isExporting={isExporting}
        error={exportError}
        onCancel={handleCancelExport}
      />
    </div>
  );
}
