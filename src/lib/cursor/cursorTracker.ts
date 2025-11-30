// Cursor tracking system for smooth cursor rendering
// Tracks mouse position during recording and stores it for playback

import { 
  spring2DStep, 
  getVelocityMagnitude,
  SPRING_PRESETS,
  createSpringConfigFromSmoothness,
  type SpringConfig,
  type Spring2DState,
  type SpringPreset
} from './springPhysics';

export interface CursorPosition {
  x: number;
  y: number;
  timestamp: number; // ms from start
  pressed: boolean;
  clickStart?: boolean; // True on the frame when click started
  clickEnd?: boolean;   // True on the frame when click ended (for release effect)
}

export interface CursorData {
  positions: CursorPosition[];
  screenWidth: number;
  screenHeight: number;
  recordedFps?: number;  // Store the FPS used during recording
}

export class CursorTracker {
  private positions: CursorPosition[] = [];
  private startTime: number = 0;
  private tracking: boolean = false;
  private screenWidth: number = 1920;
  private screenHeight: number = 1080;
  private mousePressed: boolean = false;
  private wasPressed: boolean = false;
  private pollIntervalId: ReturnType<typeof setInterval> | null = null;
  private sampleInterval: number = 4; // ~250 samples/sec for ultra-smooth interpolation
  private recordedFps: number = 60;

  async start(screenWidth: number, screenHeight: number, fps: number = 60): Promise<void> {
    this.positions = [];
    this.startTime = performance.now();
    this.tracking = true;
    this.screenWidth = screenWidth;
    this.screenHeight = screenHeight;
    this.wasPressed = false;
    this.recordedFps = fps;
    
    // Start polling loop for cursor position via Electron IPC
    this.pollIntervalId = setInterval(async () => {
      if (!this.tracking) return;
      
      try {
        const pos = await window.electronAPI.getCursorPosition();
        const elapsed = performance.now() - this.startTime;
        
        // Detect click start (transition from not pressed to pressed)
        const clickStart = this.mousePressed && !this.wasPressed;
        // Detect click end (transition from pressed to not pressed)
        const clickEnd = !this.mousePressed && this.wasPressed;
        this.wasPressed = this.mousePressed;
        
        this.positions.push({
          x: pos.x,
          y: pos.y,
          timestamp: elapsed,
          pressed: this.mousePressed,
          clickStart,
          clickEnd,
        });
      } catch (e) {
        // Ignore errors during polling
      }
    }, this.sampleInterval);
  }

  // Call this from mouse down/up events
  updatePressed(pressed: boolean): void {
    if (!this.tracking) return;
    this.mousePressed = pressed;
  }

  stop(): CursorData {
    this.tracking = false;
    if (this.pollIntervalId !== null) {
      clearInterval(this.pollIntervalId);
      this.pollIntervalId = null;
    }
    
    return {
      positions: this.positions,
      screenWidth: this.screenWidth,
      screenHeight: this.screenHeight,
      recordedFps: this.recordedFps,
    };
  }

  isTracking(): boolean {
    return this.tracking;
  }
}

// Interpolate cursor position at a given time using cubic interpolation
export function interpolateCursorPosition(
  data: CursorData,
  timeMs: number
): CursorPosition | null {
  const { positions } = data;
  
  if (positions.length === 0) return null;
  if (positions.length === 1) return positions[0];
  
  // Find the surrounding positions
  let i = 0;
  while (i < positions.length - 1 && positions[i + 1].timestamp < timeMs) {
    i++;
  }
  
  if (i >= positions.length - 1) {
    return positions[positions.length - 1];
  }
  
  const p0 = positions[Math.max(0, i - 1)];
  const p1 = positions[i];
  const p2 = positions[Math.min(positions.length - 1, i + 1)];
  const p3 = positions[Math.min(positions.length - 1, i + 2)];
  
  // Calculate interpolation factor
  const t = (timeMs - p1.timestamp) / (p2.timestamp - p1.timestamp || 1);
  
  // Catmull-Rom spline interpolation for smooth movement
  const t2 = t * t;
  const t3 = t2 * t;
  
  const x = 0.5 * (
    (2 * p1.x) +
    (-p0.x + p2.x) * t +
    (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
    (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3
  );
  
  const y = 0.5 * (
    (2 * p1.y) +
    (-p0.y + p2.y) * t +
    (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
    (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3
  );
  
  // Determine if pressed (use nearest)
  const pressed = t < 0.5 ? p1.pressed : p2.pressed;
  
  // Check for click start/end in the window
  const clickStart = p1.clickStart || (t >= 0.5 && p2.clickStart);
  const clickEnd = p1.clickEnd || (t >= 0.5 && p2.clickEnd);
  
  return {
    x: Math.max(0, Math.min(data.screenWidth, x)),
    y: Math.max(0, Math.min(data.screenHeight, y)),
    timestamp: timeMs,
    pressed,
    clickStart,
    clickEnd,
  };
}

// Check if cursor is stationary (for auto-hide)
export function isCursorStationary(
  data: CursorData,
  timeMs: number,
  thresholdMs: number = 3000,
  movementThreshold: number = 5
): boolean {
  const { positions } = data;
  if (positions.length < 2) return false;
  
  // Find current position index
  let endIdx = positions.length - 1;
  for (let i = positions.length - 1; i >= 0; i--) {
    if (positions[i].timestamp <= timeMs) {
      endIdx = i;
      break;
    }
  }
  
  // Look back thresholdMs
  const startTime = timeMs - thresholdMs;
  let startIdx = endIdx;
  for (let i = endIdx; i >= 0; i--) {
    if (positions[i].timestamp < startTime) {
      startIdx = i;
      break;
    }
  }
  
  if (startIdx === endIdx) return false;
  
  // Check if cursor moved significantly in this window
  const refPos = positions[endIdx];
  for (let i = startIdx; i <= endIdx; i++) {
    const pos = positions[i];
    const dx = Math.abs(pos.x - refPos.x);
    const dy = Math.abs(pos.y - refPos.y);
    if (dx > movementThreshold || dy > movementThreshold) {
      return false;
    }
  }
  
  return true;
}

// Spring-based cursor interpolation for smoother movement
export class SpringCursorInterpolator {
  private state: Spring2DState = { x: 0, y: 0, vx: 0, vy: 0 };
  private config: SpringConfig;
  private lastTime: number = 0;
  private initialized: boolean = false;
  private _smoothness: number | null = null;
  
  constructor(preset: SpringPreset = 'cursor', smoothness?: number) {
    this.config = { ...SPRING_PRESETS[preset] };
    if (smoothness !== undefined) {
      this._smoothness = smoothness;
      this.config = createSpringConfigFromSmoothness(smoothness);
    }
  }
  
  setPreset(preset: SpringPreset): void {
    this._smoothness = null;
    this.config = { ...SPRING_PRESETS[preset] };
  }
  
  setSmoothness(smoothness: number): void {
    this._smoothness = smoothness;
    this.config = createSpringConfigFromSmoothness(smoothness);
  }
  
  getSmoothness(): number | null {
    return this._smoothness;
  }
  
  update(targetX: number, targetY: number, currentTimeMs: number): Spring2DState {
    if (!this.initialized) {
      this.state = { x: targetX, y: targetY, vx: 0, vy: 0 };
      this.lastTime = currentTimeMs;
      this.initialized = true;
      return this.state;
    }
    
    // Handle time discontinuity (e.g., seek) - reset if time jumped backward or too far forward
    const timeDiff = currentTimeMs - this.lastTime;
    if (timeDiff < -100 || timeDiff > 500) {
      this.state = { x: targetX, y: targetY, vx: 0, vy: 0 };
      this.lastTime = currentTimeMs;
      return this.state;
    }
    
    const dt = Math.min(timeDiff / 1000, 0.05); // Cap at 50ms
    this.lastTime = currentTimeMs;
    
    if (dt > 0) {
      this.state = spring2DStep(this.state, targetX, targetY, this.config, dt);
    }
    
    return this.state;
  }
  
  getVelocity(): number {
    return getVelocityMagnitude(this.state);
  }
  
  reset(): void {
    this.initialized = false;
    this.state = { x: 0, y: 0, vx: 0, vy: 0 };
  }
}

// Smooth the entire cursor path with spring physics (pre-processing for export)
export function smoothCursorPath(
  data: CursorData,
  preset: SpringPreset = 'cursor'
): CursorData {
  if (data.positions.length < 2) return data;
  
  const config = SPRING_PRESETS[preset];
  const smoothed: CursorPosition[] = [];
  let state: Spring2DState = { 
    x: data.positions[0].x, 
    y: data.positions[0].y, 
    vx: 0, 
    vy: 0 
  };
  
  let lastTime = data.positions[0].timestamp;
  
  for (const pos of data.positions) {
    const dt = Math.min((pos.timestamp - lastTime) / 1000, 0.05);
    lastTime = pos.timestamp;
    
    if (dt > 0) {
      state = spring2DStep(state, pos.x, pos.y, config, dt);
    }
    
    smoothed.push({
      x: state.x,
      y: state.y,
      timestamp: pos.timestamp,
      pressed: pos.pressed,
      clickStart: pos.clickStart,
    });
  }
  
  return {
    ...data,
    positions: smoothed,
  };
}
