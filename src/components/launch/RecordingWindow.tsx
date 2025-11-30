import { useState, useEffect, useRef } from "react";
import { Button } from "../ui/button";
import { BsRecordCircle } from "react-icons/bs";
import { MdMonitor, MdRoundedCorner } from "react-icons/md";
import { FaFolderOpen } from "react-icons/fa6";
import { IoClose, IoChevronDown } from "react-icons/io5";
import { Slider } from "../ui/slider";
import { Switch } from "../ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { CursorTracker, smoothCursorPath, type CursorData } from "@/lib/cursor/cursorTracker";

type Resolution = "source" | "1440p" | "1080p" | "720p" | "480p";
type FPS = 120 | 60 | 48 | 30 | 24;
type Quality = "high" | "medium" | "low";

interface RecordingSettings {
  resolution: Resolution;
  fps: FPS;
  quality: Quality;
  cornerRadius: number;
  showCursor: boolean;
}

const RESOLUTION_OPTIONS: { value: Resolution; label: string }[] = [
  { value: "source", label: "Source (Native)" },
  { value: "1440p", label: "1440p (2K)" },
  { value: "1080p", label: "1080p (FHD)" },
  { value: "720p", label: "720p (HD)" },
  { value: "480p", label: "480p (SD)" },
];

const FPS_OPTIONS: { value: FPS; label: string }[] = [
  { value: 120, label: "120 FPS (High Refresh)" },
  { value: 60, label: "60 FPS (Recommended)" },
  { value: 48, label: "48 FPS (Film/HFR)" },
  { value: 30, label: "30 FPS" },
  { value: 24, label: "24 FPS (Cinematic)" },
];

const QUALITY_OPTIONS: { value: Quality; label: string }[] = [
  { value: "high", label: "High (Lossless-like)" },
  { value: "medium", label: "Medium (Balanced)" },
  { value: "low", label: "Low (Smaller File)" },
];

export function RecordingWindow() {
  const [recording, setRecording] = useState(false);
  const [sourceName, setSourceName] = useState("No source selected");
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [settings, setSettings] = useState<RecordingSettings>({
    resolution: "source",
    fps: 60,
    quality: "high",
    cornerRadius: 0,
    showCursor: true,
  });
  const [recordingTime, setRecordingTime] = useState(0);
  const [activeTab, setActiveTab] = useState("general");
  
  const mediaRecorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const startTime = useRef<number>(0);
  const timerInterval = useRef<NodeJS.Timeout | null>(null);
  const cursorTracker = useRef<CursorTracker>(new CursorTracker());
  const cursorDataRef = useRef<CursorData | null>(null);

  // Load settings from localStorage on mount only
  useEffect(() => {
    const savedSettings = localStorage.getItem("recordingSettings");
    if (savedSettings) {
      try {
        const parsed = JSON.parse(savedSettings);
        setSettings(prev => ({ ...prev, ...parsed }));
      } catch (e) {
        console.error("Failed to parse saved settings", e);
      }
    }
  }, []); // Empty dependency - only run once on mount

  // Save settings to localStorage when they change
  useEffect(() => {
    localStorage.setItem("recordingSettings", JSON.stringify(settings));
  }, [settings]);

  // Check for selected source
  useEffect(() => {
    const checkSelectedSource = async () => {
      if (window.electronAPI) {
        const source = await window.electronAPI.getSelectedSource();
        if (source) {
          setSelectedSourceId(source.id);
          setSourceName(source.name);
        } else {
          setSelectedSourceId(null);
          setSourceName("Select Source");
        }
      }
    };

    checkSelectedSource();
    const interval = setInterval(checkSelectedSource, 1000);
    return () => clearInterval(interval);
  }, []);

  // Listen for stop recording from tray
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    if (window.electronAPI?.onStopRecordingFromTray) {
      cleanup = window.electronAPI.onStopRecordingFromTray(() => {
        stopRecording();
      });
    }
    return () => {
      if (cleanup) cleanup();
      cleanupRecording();
    };
  }, []);

  const cleanupRecording = () => {
    // Always show system cursor when cleaning up
    window.electronAPI?.showSystemCursor();
    
    if (mediaRecorder.current?.state === "recording") {
      mediaRecorder.current.stop();
    }
    if (stream.current) {
      stream.current.getTracks().forEach(track => track.stop());
      stream.current = null;
    }
    if (timerInterval.current) {
      clearInterval(timerInterval.current);
      timerInterval.current = null;
    }
  };

  const getBitrate = (width: number, height: number, fps: number, quality: Quality) => {
    const pixelCount = width * height;
    let baseBitrate = 0;

    // Base bitrate calculation based on resolution
    if (pixelCount >= 3840 * 2160) baseBitrate = 60_000_000; // 4K
    else if (pixelCount >= 2560 * 1440) baseBitrate = 30_000_000; // 1440p
    else if (pixelCount >= 1920 * 1080) baseBitrate = 15_000_000; // 1080p
    else baseBitrate = 8_000_000; // 720p and below

    // Adjust for FPS (baseline is 60fps)
    baseBitrate = baseBitrate * (fps / 60);

    // Adjust for Quality setting
    switch (quality) {
      case "high": return baseBitrate * 3; // Very high quality
      case "medium": return baseBitrate * 1.5; // Good quality
      case "low": return baseBitrate * 0.8; // Compressed
      default: return baseBitrate;
    }
  };

  const startRecording = async () => {
    try {
      if (!selectedSourceId) {
        // Debug log removed
        window.electronAPI.openSourceSelector();
        return;
      }

      const source = await window.electronAPI.getSelectedSource();
      if (!source) {
        // Debug log removed
        window.electronAPI.openSourceSelector();
        return;
      }

      // Debug log removed

      // Use selected frame rate - note: actual capture may be limited by display refresh rate
      const captureFrameRate = settings.fps;

      // 1. Get initial stream to determine source dimensions
      const constraints: any = {
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: "desktop",
            chromeMediaSourceId: source.id,
            minFrameRate: Math.min(captureFrameRate, 60), // Initial capture
            maxFrameRate: captureFrameRate,
          },
        },
      };

      // Debug log removed
      
      let mediaStream: MediaStream;
      try {
        mediaStream = await (navigator.mediaDevices as any).getUserMedia(constraints);
      } catch (err) {
        console.error("Failed to get media stream:", err);
        // Try again with lower frame rate
        constraints.video.mandatory.minFrameRate = 30;
        constraints.video.mandatory.maxFrameRate = 30;
        // Debug log removed
        mediaStream = await (navigator.mediaDevices as any).getUserMedia(constraints);
      }
      
      const videoTrack = mediaStream.getVideoTracks()[0];
      const { width: sourceWidth = 1920, height: sourceHeight = 1080 } = videoTrack.getSettings();
      
      // 2. Calculate target dimensions
      let targetWidth = sourceWidth;
      let targetHeight = sourceHeight;

      if (settings.resolution !== "source") {
        switch (settings.resolution) {
          case "1440p": targetWidth = 2560; targetHeight = 1440; break;
          case "1080p": targetWidth = 1920; targetHeight = 1080; break;
          case "720p": targetWidth = 1280; targetHeight = 720; break;
          case "480p": targetWidth = 854; targetHeight = 480; break;
        }
      }

      // Ensure even dimensions for codecs
      targetWidth = Math.floor(targetWidth / 2) * 2;
      targetHeight = Math.floor(targetHeight / 2) * 2;

      // 3. Apply constraints if needed (resizing)
      if (targetWidth !== sourceWidth || targetHeight !== sourceHeight) {
        try {
          await videoTrack.applyConstraints({
            width: { ideal: targetWidth },
            height: { ideal: targetHeight },
            frameRate: { ideal: settings.fps, max: settings.fps }
          });
        } catch (e) {
          console.warn("Failed to apply resolution constraints", e);
        }
      }

      stream.current = mediaStream;
      
      // 4. Setup MediaRecorder
      const bitrate = getBitrate(targetWidth, targetHeight, settings.fps, settings.quality);
      // Debug log removed.toFixed(1)}Mbps`);

      const mimeType = [
        'video/webm;codecs=vp9',
        'video/webm;codecs=vp8',
        'video/webm'
      ].find(type => MediaRecorder.isTypeSupported(type)) || 'video/webm';

      const recorder = new MediaRecorder(mediaStream, {
        mimeType,
        videoBitsPerSecond: bitrate
      });

      mediaRecorder.current = recorder;
      chunks.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.current.push(e.data);
      };

      recorder.onstop = async () => {
        // Stop cursor tracking and smooth the path
        const rawCursorData = cursorTracker.current.stop();
        cursorDataRef.current = smoothCursorPath(rawCursorData, 'cursor');
        // Debug log removed
        
        cleanupRecording();
        if (chunks.current.length === 0) return;

        const duration = Date.now() - startTime.current;
        const blob = new Blob(chunks.current, { type: mimeType });
        chunks.current = [];
        
        const timestamp = Date.now();
        const fileName = `recording-${timestamp}.webm`;

        try {
          const { fixWebmDuration } = await import("@fix-webm-duration/fix");
          const fixedBlob = await fixWebmDuration(blob, duration);
          const buffer = await fixedBlob.arrayBuffer();
          
          const result = await window.electronAPI.storeRecordedVideo(buffer, fileName);
          if (result.success) {
            // Save cursor data alongside video
            if (cursorDataRef.current && cursorDataRef.current.positions && cursorDataRef.current.positions.length > 0) {
              const cursorFileName = fileName.replace('.webm', '.cursor.json');
              const cursorJson = JSON.stringify(cursorDataRef.current);
              const cursorBuffer = new TextEncoder().encode(cursorJson).buffer;
              await window.electronAPI.storeRecordedVideo(cursorBuffer, cursorFileName);
              // Debug log removed
              cursorDataRef.current = null;
            }
            
            // Store recording metadata (FPS, resolution) for export
            const metadataFileName = fileName.replace('.webm', '.meta.json');
            const metadata = {
              fps: settings.fps,
              resolution: settings.resolution,
              quality: settings.quality,
              width: targetWidth,
              height: targetHeight,
              duration: duration,
              timestamp: timestamp,
            };
            try {
              await window.electronAPI.storeRecordedVideo(
                new TextEncoder().encode(JSON.stringify(metadata)).buffer,
                metadataFileName
              );
            } catch (e) {
              console.warn('Failed to save metadata:', e);
            }
            await window.electronAPI.switchToEditor();
          }
        } catch (error) {
          console.error("Save failed:", error);
        }
      };

      recorder.start(100); // 100ms timeslice for smoother recording and less frame drops
      startTime.current = Date.now();
      
      // Get actual display bounds for cursor tracking
      // This ensures cursor coordinates are relative to the recorded display
      let displayWidth = targetWidth;
      let displayHeight = targetHeight;
      try {
        const displayBounds = await window.electronAPI?.getDisplayBounds();
        if (displayBounds) {
          displayWidth = displayBounds.width;
          displayHeight = displayBounds.height;
          // Debug log removed
        }
      } catch (e) {
        console.warn('[Recording] Could not get display bounds, using video dimensions');
      }
      
      // Hide the system cursor during recording (so only our custom cursor shows)
      try {
        await window.electronAPI?.hideSystemCursor();
        // Debug log removed
      } catch (e) {
        console.warn('[Recording] Could not hide system cursor:', e);
      }
      
      // Start cursor tracking with display dimensions (not video dimensions)
      cursorTracker.current.start(displayWidth, displayHeight);
      // Debug log removed
      
      setRecording(true);
      setRecordingTime(0);

      timerInterval.current = setInterval(() => {
        setRecordingTime(Math.floor((Date.now() - startTime.current) / 1000));
      }, 1000);

      window.electronAPI?.setRecordingState(true);

    } catch (error) {
      console.error("Recording failed:", error);
      alert("Recording failed: " + (error instanceof Error ? error.message : String(error)));
      cleanupRecording();
      setRecording(false);
      // Make sure cursor is shown if recording failed
      window.electronAPI?.showSystemCursor();
    }
  };

  const stopRecording = () => {
    if (mediaRecorder.current?.state === "recording") {
      // Show system cursor again
      window.electronAPI?.showSystemCursor();
      // Stop cursor tracking first
      cursorTracker.current.stop();
      mediaRecorder.current.stop();
      setRecording(false);
      window.electronAPI?.setRecordingState(false);
    }
  };

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60).toString().padStart(2, '0');
    const s = (seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  return (
    <div className="w-full h-full flex flex-col bg-[#09090b] text-white overflow-hidden rounded-xl border border-white/10 shadow-2xl">
      {/* Header */}
      <div 
        className="h-9 flex items-center justify-between px-3 bg-white/5 border-b border-white/5 shrink-0"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-[#34B27B]" />
          <span className="text-xs font-medium text-white/80">OpenScreen Recorder</span>
        </div>
        <button
          onClick={() => window.close()}
          className="w-6 h-6 flex items-center justify-center rounded-md hover:bg-white/10 transition-colors"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <IoClose size={14} />
        </button>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col p-4 gap-4">
        {/* Source Selection */}
        <button
          onClick={() => window.electronAPI.openSourceSelector()}
          disabled={recording}
          className="w-full flex items-center gap-3 p-3 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 transition-all group text-left disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <div className="w-10 h-10 rounded-lg bg-[#34B27B]/10 flex items-center justify-center text-[#34B27B]">
            <MdMonitor size={20} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[10px] uppercase tracking-wider text-white/40 font-medium">Source</div>
            <div className="text-sm font-medium truncate">{sourceName}</div>
          </div>
          <IoChevronDown className="text-white/30 group-hover:text-white/60" />
        </button>

        {/* Settings Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col min-h-0">
          <TabsList className="w-full grid grid-cols-2 bg-white/5 p-1 rounded-lg mb-3">
            <TabsTrigger value="general" className="text-xs data-[state=active]:bg-white/10">General</TabsTrigger>
            <TabsTrigger value="advanced" className="text-xs data-[state=active]:bg-white/10">Advanced</TabsTrigger>
          </TabsList>

          <div className="flex-1 overflow-y-auto pr-1 custom-scrollbar">
            <TabsContent value="general" className="space-y-3 mt-0">
              <div className="space-y-1">
                <label className="text-xs text-white/50 ml-1">Resolution</label>
                <select
                  value={settings.resolution}
                  onChange={(e) => setSettings(s => ({ ...s, resolution: e.target.value as Resolution }))}
                  disabled={recording}
                  className="w-full h-9 px-3 rounded-lg bg-white/5 border border-white/10 text-sm focus:outline-none focus:border-[#34B27B]/50 disabled:opacity-50"
                >
                  {RESOLUTION_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value} className="bg-[#1a1a24]">{opt.label}</option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-xs text-white/50 ml-1">Frame Rate</label>
                <select
                  value={settings.fps}
                  onChange={(e) => setSettings(s => ({ ...s, fps: Number(e.target.value) as FPS }))}
                  disabled={recording}
                  className="w-full h-9 px-3 rounded-lg bg-white/5 border border-white/10 text-sm focus:outline-none focus:border-[#34B27B]/50 disabled:opacity-50"
                >
                  {FPS_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value} className="bg-[#1a1a24]">{opt.label}</option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-xs text-white/50 ml-1">Quality</label>
                <select
                  value={settings.quality}
                  onChange={(e) => setSettings(s => ({ ...s, quality: e.target.value as Quality }))}
                  disabled={recording}
                  className="w-full h-9 px-3 rounded-lg bg-white/5 border border-white/10 text-sm focus:outline-none focus:border-[#34B27B]/50 disabled:opacity-50"
                >
                  {QUALITY_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value} className="bg-[#1a1a24]">{opt.label}</option>
                  ))}
                </select>
              </div>
            </TabsContent>

            <TabsContent value="advanced" className="space-y-4 mt-0">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-xs text-white/70 flex items-center gap-2">
                    <MdRoundedCorner size={14} />
                    Corner Radius
                  </label>
                  <span className="text-xs font-mono text-white/50">{settings.cornerRadius}px</span>
                </div>
                <Slider
                  value={[settings.cornerRadius]}
                  onValueChange={([val]) => setSettings(s => ({ ...s, cornerRadius: val }))}
                  max={50}
                  step={1}
                  disabled={recording}
                  className="py-1"
                />
              </div>

              <div className="flex items-center justify-between p-2 rounded-lg bg-white/5 border border-white/5">
                <label className="text-xs text-white/70">Show Cursor</label>
                <Switch
                  checked={settings.showCursor}
                  onCheckedChange={(checked) => setSettings(s => ({ ...s, showCursor: checked }))}
                  disabled={recording}
                />
              </div>
            </TabsContent>
          </div>
        </Tabs>

        {/* Footer Controls */}
        <div className="mt-auto pt-2 flex gap-2">
          <Button
            variant="outline"
            size="icon"
            onClick={() => window.electronAPI.openVideoFilePicker()}
            disabled={recording}
            className="h-12 w-12 shrink-0 bg-white/5 border-white/10 hover:bg-white/10 hover:border-white/20 text-white/70"
          >
            <FaFolderOpen size={18} />
          </Button>

          <Button
            onClick={recording ? stopRecording : startRecording}
            disabled={!selectedSourceId && !recording}
            className={`flex-1 h-12 text-base font-semibold shadow-lg transition-all ${
              recording 
                ? 'bg-red-500 hover:bg-red-600 text-white shadow-red-500/20' 
                : 'bg-[#34B27B] hover:bg-[#2da36d] text-white shadow-[#34B27B]/20'
            } ${!selectedSourceId && !recording ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            {recording ? (
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-white animate-pulse" />
                <span>{formatTime(recordingTime)}</span>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <BsRecordCircle size={18} />
                <span>{selectedSourceId ? 'Start Recording' : 'Select Source First'}</span>
              </div>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
