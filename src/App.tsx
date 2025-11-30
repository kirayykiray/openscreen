import { useEffect, useState } from "react";
import { RecordingWindow } from "./components/launch/RecordingWindow";
import { SourceSelector } from "./components/launch/SourceSelector";
import VideoEditor from "./components/video-editor/VideoEditor";

// Splash Screen Component with animation
function SplashScreen({ onComplete }: { onComplete: () => void }) {
  const [fadeOut, setFadeOut] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setFadeOut(true);
      setTimeout(onComplete, 500);
    }, 2000);
    return () => clearTimeout(timer);
  }, [onComplete]);

  return (
    <div 
      className={`fixed inset-0 bg-[#09090b] flex flex-col items-center justify-center z-50 transition-opacity duration-500 ${fadeOut ? 'opacity-0' : 'opacity-100'}`}
    >
      {/* Animated background gradient */}
      <div className="absolute inset-0 overflow-hidden">
        <div className="absolute -inset-[100px] opacity-30">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-[#34B27B] rounded-full blur-[120px] animate-pulse" />
          <div className="absolute top-1/3 left-1/3 w-[400px] h-[400px] bg-[#2da36d] rounded-full blur-[100px] animate-pulse" style={{ animationDelay: '0.5s' }} />
        </div>
      </div>

      {/* Logo and text */}
      <div className="relative z-10 flex flex-col items-center gap-6">
        {/* Animated logo */}
        <div className="relative">
          <div className="w-24 h-24 rounded-3xl bg-gradient-to-br from-[#34B27B] to-[#1a8a5a] flex items-center justify-center shadow-2xl shadow-[#34B27B]/30 animate-bounce-slow">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" className="text-white">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" fill="none" className="animate-draw-circle" />
              <circle cx="12" cy="12" r="4" fill="currentColor" className="animate-scale-in" />
            </svg>
          </div>
          {/* Glow ring */}
          <div className="absolute inset-0 rounded-3xl bg-[#34B27B]/20 blur-xl animate-pulse" />
        </div>

        {/* Title with staggered animation */}
        <div className="flex flex-col items-center gap-2">
          <h1 className="text-3xl font-bold text-white tracking-tight animate-fade-in-up">
            OpenScreen
          </h1>
          <p className="text-sm text-white/50 animate-fade-in-up" style={{ animationDelay: '0.2s' }}>
            Screen Recording Made Beautiful
          </p>
        </div>

        {/* Loading indicator */}
        <div className="flex gap-1.5 mt-4 animate-fade-in-up" style={{ animationDelay: '0.4s' }}>
          <div className="w-2 h-2 rounded-full bg-[#34B27B] animate-bounce" style={{ animationDelay: '0ms' }} />
          <div className="w-2 h-2 rounded-full bg-[#34B27B] animate-bounce" style={{ animationDelay: '150ms' }} />
          <div className="w-2 h-2 rounded-full bg-[#34B27B] animate-bounce" style={{ animationDelay: '300ms' }} />
        </div>
      </div>

      {/* Version tag */}
      <div className="absolute bottom-6 text-xs text-white/30 animate-fade-in-up" style={{ animationDelay: '0.6s' }}>
        Modified Fork • v0.2.0
      </div>
    </div>
  );
}

export default function App() {
  const [windowType, setWindowType] = useState('');
  const [showSplash, setShowSplash] = useState(false);
  const [splashComplete, setSplashComplete] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const type = params.get('windowType') || '';
    setWindowType(type);
    
    // Show splash only for hud-overlay (main recording window)
    if (type === 'hud-overlay') {
      setShowSplash(true);
    } else {
      setSplashComplete(true);
    }
    
    if (type === 'hud-overlay' || type === 'source-selector') {
      document.body.style.background = 'transparent';
      document.documentElement.style.background = 'transparent';
      document.getElementById('root')?.style.setProperty('background', 'transparent');
    }
  }, []);

  const handleSplashComplete = () => {
    setSplashComplete(true);
    setShowSplash(false);
  };

  // Show splash screen first for recording window
  if (showSplash && !splashComplete) {
    return <SplashScreen onComplete={handleSplashComplete} />;
  }

  switch (windowType) {
    case 'hud-overlay':
      return <RecordingWindow />;
    case 'source-selector':
      return <SourceSelector />;
    case 'editor':
      return <VideoEditor />;
      default:
      return (
        <div className="w-full h-full bg-background text-foreground">
          <h1>Openscreen</h1>
        </div>
      );
  }
}
