import { useState, useRef, useEffect } from "react";
import { fixWebmDuration } from "@fix-webm-duration/fix";
import { CursorTracker, CursorData, smoothCursorPath } from "../lib/cursor/cursorTracker";

type UseScreenRecorderReturn = {
  recording: boolean;
  toggleRecording: () => void;
};

export function useScreenRecorder(): UseScreenRecorderReturn {
  const [recording, setRecording] = useState(false);
  const mediaRecorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const startTime = useRef<number>(0);
  const cursorTracker = useRef<CursorTracker>(new CursorTracker());
  const cursorDataRef = useRef<CursorData | null>(null);

  const stopRecording = useRef(() => {
    if (mediaRecorder.current?.state === "recording") {
      if (stream.current) {
        stream.current.getTracks().forEach(track => track.stop());
      }
      // Stop cursor tracking and smooth the path
      const rawCursorData = cursorTracker.current.stop();
      cursorDataRef.current = smoothCursorPath(rawCursorData, 'cursor');
      
      mediaRecorder.current.stop();
      setRecording(false);

      window.electronAPI?.setRecordingState(false);
    }
  });

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    
    if (window.electronAPI?.onStopRecordingFromTray) {
      cleanup = window.electronAPI.onStopRecordingFromTray(() => {
        stopRecording.current();
      });
    }

    // Set up global mouse click tracking for cursor recording
    const handleMouseDown = () => {
      cursorTracker.current.updatePressed(true);
    };
    
    const handleMouseUp = () => {
      cursorTracker.current.updatePressed(false);
    };

    // Listen to mouse events on the document for click detection
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      if (cleanup) cleanup();
      
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('mouseup', handleMouseUp);
      
      if (mediaRecorder.current?.state === "recording") {
        mediaRecorder.current.stop();
      }
      if (stream.current) {
        stream.current.getTracks().forEach(track => track.stop());
        stream.current = null;
      }
    };
  }, []);

  const startRecording = async () => {
    try {
      const selectedSource = await window.electronAPI.getSelectedSource();
      if (!selectedSource) {
        alert("Please select a source to record");
        return;
      }

      // Capture screen at source resolution without constraints
      const mediaStream = await (navigator.mediaDevices as any).getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: "desktop",
            chromeMediaSourceId: selectedSource.id,
            frameRate: { ideal: 60, max: 60 }
          },
        },
      });
      stream.current = mediaStream;
      if (!stream.current) {
        throw new Error("Media stream is not available.");
      }
      const videoTrack = stream.current.getVideoTracks()[0];
      let { width = 1920, height = 1080 } = videoTrack.getSettings();
      
      // Ensure dimensions are divisible by 2 for VP9/AV1 codec compatibility
      width = Math.floor(width / 2) * 2;
      height = Math.floor(height / 2) * 2;
      
      // Debug log removed
      
      const totalPixels = width * height;
      // Use higher bitrates for better quality during recording
      let bitrate = 50_000_000; // 50 Mbps base for 1080p
      if (totalPixels > 1920 * 1080 && totalPixels <= 2560 * 1440) {
        bitrate = 80_000_000; // 80 Mbps for 1440p
      } else if (totalPixels > 2560 * 1440) {
        bitrate = 120_000_000; // 120 Mbps for 4K
      }
      chunks.current = [];
      // Prefer VP9 for best quality/performance balance, avoid AV1 due to encoding overhead
      const supportedCodecs = [
        'video/webm;codecs=vp9',
        'video/webm;codecs=vp8'
      ];
      const mimeType = supportedCodecs.find(codec => MediaRecorder.isTypeSupported(codec)) || 'video/webm;codecs=vp8';
      const recorder = new MediaRecorder(stream.current, { mimeType, videoBitsPerSecond: bitrate });
      mediaRecorder.current = recorder;
      recorder.ondataavailable = e => {
        if (e.data && e.data.size > 0) chunks.current.push(e.data);
      };
      recorder.onstop = async () => {
        stream.current = null;
        if (chunks.current.length === 0) return;
        const duration = Date.now() - startTime.current;
        const buggyBlob = new Blob(chunks.current, { type: mimeType });
        // Clear chunks early to free memory immediately after blob creation
        chunks.current = [];
        const timestamp = Date.now();
        const videoFileName = `recording-${timestamp}.webm`;
        const cursorFileName = `recording-${timestamp}.cursor.json`;

        try {
          const videoBlob = await fixWebmDuration(buggyBlob, duration);
          const arrayBuffer = await videoBlob.arrayBuffer();
          const videoResult = await window.electronAPI.storeRecordedVideo(arrayBuffer, videoFileName);
          if (!videoResult.success) {
            console.error('Failed to store video:', videoResult.message);
            return;
          }

          // Save cursor data alongside video
          if (cursorDataRef.current) {
            const cursorJson = JSON.stringify(cursorDataRef.current);
            const cursorBuffer = new TextEncoder().encode(cursorJson).buffer;
            await window.electronAPI.storeRecordedVideo(cursorBuffer, cursorFileName);
            cursorDataRef.current = null;
          }

          await window.electronAPI.switchToEditor();
        } catch (error) {
          console.error('Error saving recording:', error);
        }
      };
      recorder.onerror = () => setRecording(false);
      // Use smaller timeslice for smoother recording and faster data availability
      recorder.start(1000);
      startTime.current = Date.now();
      
      // Start cursor tracking with screen dimensions (async)
      await cursorTracker.current.start(width, height);
      
      setRecording(true);
      window.electronAPI?.setRecordingState(true);
    } catch (error) {
      console.error('Failed to start recording:', error);
      setRecording(false);
      if (stream.current) {
        stream.current.getTracks().forEach(track => track.stop());
        stream.current = null;
      }
    }
  };

  const toggleRecording = () => {
    recording ? stopRecording.current() : startRecording();
  };

  return { recording, toggleRecording };
}
