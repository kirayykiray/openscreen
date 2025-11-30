// Spring physics for smooth cursor animation
// Based on react-spring/motion.dev spring physics

export interface SpringConfig {
  tension: number;    // Spring stiffness (default: 170)
  friction: number;   // Damping coefficient (default: 26)
  mass: number;       // Mass of the object (default: 1)
  velocity: number;   // Initial velocity (default: 0)
}

// Presets inspired by react-spring
export const SPRING_PRESETS = {
  default: { tension: 170, friction: 26, mass: 1, velocity: 0 },
  gentle: { tension: 120, friction: 14, mass: 1, velocity: 0 },
  wobbly: { tension: 180, friction: 12, mass: 1, velocity: 0 },
  stiff: { tension: 210, friction: 20, mass: 1, velocity: 0 },
  slow: { tension: 280, friction: 60, mass: 1, velocity: 0 },
  molasses: { tension: 280, friction: 120, mass: 1, velocity: 0 },
  // Screen Studio style - smooth trailing effect with slight lag
  cursor: { tension: 180, friction: 22, mass: 1.2, velocity: 0 },
  // More pronounced trailing (like Screen Studio "smooth" mode)
  cursorSmooth: { tension: 100, friction: 16, mass: 1.8, velocity: 0 },
  // Snappy response (minimal lag)
  cursorSnappy: { tension: 280, friction: 30, mass: 0.8, velocity: 0 },
  // Ultra smooth - maximum trailing (for demos)
  cursorUltraSmooth: { tension: 60, friction: 12, mass: 2.5, velocity: 0 },
} as const;

export type SpringPreset = keyof typeof SPRING_PRESETS;

// Create custom spring config from smoothness value (0-100)
export function createSpringConfigFromSmoothness(smoothness: number): SpringConfig {
  // smoothness: 0 = snappy, 100 = very smooth/trailing
  const t = Math.max(0, Math.min(100, smoothness)) / 100;
  
  // Interpolate between snappy and ultra-smooth
  return {
    tension: 280 - (220 * t),      // 280 -> 60
    friction: 30 - (18 * t),       // 30 -> 12
    mass: 0.8 + (1.7 * t),         // 0.8 -> 2.5
    velocity: 0,
  };
}

export interface SpringState {
  position: number;
  velocity: number;
}

// Spring physics simulation for a single axis
export function springStep(
  current: number,
  target: number,
  velocity: number,
  config: SpringConfig,
  dt: number // delta time in seconds
): SpringState {
  const { tension, friction, mass } = config;
  
  // Spring force: F = -k * (x - target) where k is tension
  const displacement = current - target;
  const springForce = -tension * displacement;
  
  // Damping force: F = -c * v where c is friction
  const dampingForce = -friction * velocity;
  
  // Total force
  const force = springForce + dampingForce;
  
  // Acceleration: a = F / m
  const acceleration = force / mass;
  
  // Update velocity: v = v + a * dt
  const newVelocity = velocity + acceleration * dt;
  
  // Update position: x = x + v * dt
  const newPosition = current + newVelocity * dt;
  
  return {
    position: newPosition,
    velocity: newVelocity,
  };
}

// Check if spring has settled (position close to target with low velocity)
export function isSpringSettled(
  position: number,
  target: number,
  velocity: number,
  threshold: number = 0.01
): boolean {
  return Math.abs(position - target) < threshold && Math.abs(velocity) < threshold;
}

// 2D spring state for cursor position
export interface Spring2DState {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

// Step 2D spring physics
export function spring2DStep(
  state: Spring2DState,
  targetX: number,
  targetY: number,
  config: SpringConfig,
  dt: number
): Spring2DState {
  const xResult = springStep(state.x, targetX, state.vx, config, dt);
  const yResult = springStep(state.y, targetY, state.vy, config, dt);
  
  return {
    x: xResult.position,
    y: yResult.position,
    vx: xResult.velocity,
    vy: yResult.velocity,
  };
}

// Calculate velocity magnitude for motion blur effect
export function getVelocityMagnitude(state: Spring2DState): number {
  return Math.sqrt(state.vx * state.vx + state.vy * state.vy);
}

// Cursor settings for appearance customization
export interface CursorSettings {
  size: 'small' | 'medium' | 'large' | 'xlarge';
  cursorStyle: 'circle' | 'pointer' | 'crosshair'; // SVG cursor type
  color: string;           // Hex color for cursor (used with circle style)
  showGlow: boolean;       // Enable glow effect
  glowColor: string;       // Glow color (usually same as cursor color)
  glowIntensity: number;   // Glow intensity 0-1
  showHighlight: boolean;  // Show spotlight/highlight around cursor
  showRipple: boolean;     // Show click ripple animation
  springPreset: SpringPreset;
  smoothness: number;      // 0-100, overrides springPreset when set
  motionBlur: boolean;     // Enable motion blur trail
  trailLength: number;     // 0-10, number of trail segments
  autoHide: boolean;       // Auto-hide cursor when stationary
  autoHideDelay: number;   // ms before cursor hides (default: 3000)
}

export const DEFAULT_CURSOR_SETTINGS: CursorSettings = {
  size: 'medium',          // Medium size by default
  cursorStyle: 'pointer',  // macOS arrow style by default
  color: '#1a1a1a',
  showGlow: false,
  glowColor: '#34B27B',
  glowIntensity: 0.5,
  showHighlight: false,
  showRipple: true,        // Show click effects
  springPreset: 'cursor',  // Normal cursor tracking
  smoothness: 30,          // Less smoothness = more responsive
  motionBlur: false,       // No trail by default
  trailLength: 3,
  autoHide: false,
  autoHideDelay: 3000,
};

// Size mappings in pixels (base size, will be scaled)
export const CURSOR_SIZE_MAP = {
  small: 12,
  medium: 18,
  large: 24,
  xlarge: 32,
} as const;

// Click ripple state for animation
export interface ClickRipple {
  x: number;
  y: number;
  startTime: number;
  duration: number; // ms
}

// Motion blur trail - stores last N positions with bezier interpolation
export interface MotionTrail {
  positions: Array<{ x: number; y: number; alpha: number; time: number }>;
  maxLength: number;
}

export function createMotionTrail(maxLength: number = 8): MotionTrail {
  return {
    positions: [],
    maxLength,
  };
}

export function updateMotionTrail(
  trail: MotionTrail,
  x: number,
  y: number,
  velocity: number,
  time: number
): MotionTrail {
  // Only add to trail if moving fast enough
  const minVelocity = 30; // pixels per second
  if (velocity < minVelocity) {
    // Fade out existing trail faster when stationary
    return {
      ...trail,
      positions: trail.positions
        .map(p => ({ ...p, alpha: p.alpha * 0.7 }))
        .filter(p => p.alpha > 0.02),
    };
  }
  
  // Calculate alpha based on velocity (faster = more visible trail)
  const velocityAlpha = Math.min(1, velocity / 500) * 0.7;
  
  // Add new position to front
  const newPositions = [
    { x, y, alpha: velocityAlpha, time },
    ...trail.positions.slice(0, trail.maxLength - 1).map((p, i) => ({
      ...p,
      alpha: p.alpha * (0.85 - i * 0.05), // Progressive fade
    })),
  ].filter(p => p.alpha > 0.02);
  
  return {
    ...trail,
    positions: newPositions,
  };
}

// Get bezier-interpolated trail points for smooth rendering
export function getTrailBezierPoints(
  trail: MotionTrail,
  currentX: number,
  currentY: number
): Array<{ x: number; y: number; alpha: number }> {
  if (trail.positions.length < 2) return [];
  
  const points: Array<{ x: number; y: number; alpha: number }> = [];
  const allPoints = [{ x: currentX, y: currentY, alpha: 1 }, ...trail.positions];
  
  // Generate smooth bezier curve through points
  for (let i = 0; i < allPoints.length - 1; i++) {
    const p0 = allPoints[Math.max(0, i - 1)];
    const p1 = allPoints[i];
    const p2 = allPoints[i + 1];
    const p3 = allPoints[Math.min(allPoints.length - 1, i + 2)];
    
    // Catmull-Rom to Bezier conversion for smooth curves
    const segments = 3;
    for (let t = 0; t < segments; t++) {
      const u = t / segments;
      const u2 = u * u;
      const u3 = u2 * u;
      
      const x = 0.5 * (
        (2 * p1.x) +
        (-p0.x + p2.x) * u +
        (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * u2 +
        (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * u3
      );
      
      const y = 0.5 * (
        (2 * p1.y) +
        (-p0.y + p2.y) * u +
        (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * u2 +
        (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * u3
      );
      
      // Interpolate alpha
      const alpha = p1.alpha + (p2.alpha - p1.alpha) * u;
      
      points.push({ x, y, alpha: alpha * 0.6 });
    }
  }
  
  return points;
}

// Process click ripples - returns active ripples with progress
export function processClickRipples(
  ripples: ClickRipple[],
  currentTime: number
): Array<{ x: number; y: number; progress: number }> {
  return ripples
    .map(ripple => {
      const elapsed = currentTime - ripple.startTime;
      const progress = Math.min(1, elapsed / ripple.duration);
      return { x: ripple.x, y: ripple.y, progress };
    })
    .filter(r => r.progress < 1);
}

// Create a new click ripple
export function createClickRipple(x: number, y: number, currentTime: number): ClickRipple {
  return {
    x,
    y,
    startTime: currentTime,
    duration: 400, // 400ms ripple animation
  };
}
