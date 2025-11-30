// SVG Cursor definitions for Screen Studio-style cursor rendering
// These are high-resolution vector cursors that look crisp at any scale

export const CURSOR_SVGS = {
  // Default pointer cursor - macOS style
  pointer: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
    <defs>
      <filter id="shadow" x="-50%" y="-50%" width="200%" height="200%">
        <feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-opacity="0.3"/>
      </filter>
      <linearGradient id="pointerGrad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" style="stop-color:#ffffff"/>
        <stop offset="100%" style="stop-color:#f0f0f0"/>
      </linearGradient>
    </defs>
    <g filter="url(#shadow)">
      <path d="M8.5 3.5 L8.5 26.5 L13.5 21.5 L18 28.5 L21.5 26.5 L17 19.5 L24 19.5 Z" 
            fill="url(#pointerGrad)" 
            stroke="#1a1a1a" 
            stroke-width="1.5" 
            stroke-linejoin="round"/>
    </g>
  </svg>`,

  // Pointing hand cursor
  hand: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
    <defs>
      <filter id="shadowHand" x="-50%" y="-50%" width="200%" height="200%">
        <feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-opacity="0.3"/>
      </filter>
    </defs>
    <g filter="url(#shadowHand)">
      <path d="M13 6 C13 4.5 14.5 3.5 16 4 C17.5 4.5 17 6 17 8 L17 12 C18 11.5 19.5 11.5 20 13 L20 14 C21 13.5 22.5 13.5 23 15 L23 16 C24 15.5 25.5 15.5 26 17 L26 24 C26 27 24 28 21 28 L15 28 C12 28 10 27 9 24 L6 16 C5.5 14.5 7 13 8.5 14 L10 15 L10 8 C10 6 11.5 5.5 13 6 Z"
            fill="#ffffff" 
            stroke="#1a1a1a" 
            stroke-width="1.2" 
            stroke-linejoin="round"/>
    </g>
  </svg>`,

  // Text I-beam cursor
  text: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
    <defs>
      <filter id="shadowText" x="-50%" y="-50%" width="200%" height="200%">
        <feDropShadow dx="0" dy="1" stdDeviation="1" flood-opacity="0.25"/>
      </filter>
    </defs>
    <g filter="url(#shadowText)">
      <path d="M12 6 L20 6 M16 6 L16 26 M12 26 L20 26" 
            fill="none" 
            stroke="#1a1a1a" 
            stroke-width="2.5" 
            stroke-linecap="round"/>
      <path d="M12 6 L20 6 M16 6 L16 26 M12 26 L20 26" 
            fill="none" 
            stroke="#ffffff" 
            stroke-width="1.5" 
            stroke-linecap="round"/>
    </g>
  </svg>`,

  // Crosshair/precision cursor
  crosshair: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
    <defs>
      <filter id="shadowCross" x="-50%" y="-50%" width="200%" height="200%">
        <feDropShadow dx="0" dy="1" stdDeviation="1" flood-opacity="0.25"/>
      </filter>
    </defs>
    <g filter="url(#shadowCross)">
      <circle cx="16" cy="16" r="8" fill="none" stroke="#1a1a1a" stroke-width="2.5"/>
      <circle cx="16" cy="16" r="8" fill="none" stroke="#ffffff" stroke-width="1.5"/>
      <line x1="16" y1="4" x2="16" y2="10" stroke="#1a1a1a" stroke-width="2.5" stroke-linecap="round"/>
      <line x1="16" y1="4" x2="16" y2="10" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round"/>
      <line x1="16" y1="22" x2="16" y2="28" stroke="#1a1a1a" stroke-width="2.5" stroke-linecap="round"/>
      <line x1="16" y1="22" x2="16" y2="28" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round"/>
      <line x1="4" y1="16" x2="10" y2="16" stroke="#1a1a1a" stroke-width="2.5" stroke-linecap="round"/>
      <line x1="4" y1="16" x2="10" y2="16" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round"/>
      <line x1="22" y1="16" x2="28" y2="16" stroke="#1a1a1a" stroke-width="2.5" stroke-linecap="round"/>
      <line x1="22" y1="16" x2="28" y2="16" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round"/>
    </g>
  </svg>`,

  // Circle cursor (Screen Studio default style)
  circle: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
    <defs>
      <filter id="shadowCircle" x="-50%" y="-50%" width="200%" height="200%">
        <feDropShadow dx="0" dy="2" stdDeviation="2" flood-opacity="0.35"/>
      </filter>
      <radialGradient id="circleGrad" cx="35%" cy="35%" r="60%">
        <stop offset="0%" style="stop-color:#4a4a4a"/>
        <stop offset="100%" style="stop-color:#1a1a1a"/>
      </radialGradient>
      <radialGradient id="circleHighlight" cx="30%" cy="30%" r="50%">
        <stop offset="0%" style="stop-color:rgba(255,255,255,0.5)"/>
        <stop offset="100%" style="stop-color:rgba(255,255,255,0)"/>
      </radialGradient>
    </defs>
    <g filter="url(#shadowCircle)">
      <circle cx="16" cy="16" r="12" fill="url(#circleGrad)"/>
      <circle cx="16" cy="16" r="11" fill="none" stroke="#ffffff" stroke-width="2.5" stroke-opacity="0.9"/>
      <circle cx="14" cy="14" r="5" fill="url(#circleHighlight)"/>
    </g>
  </svg>`,

  // Circle with click state (pressed)
  circlePressed: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
    <defs>
      <filter id="shadowCircleP" x="-50%" y="-50%" width="200%" height="200%">
        <feDropShadow dx="0" dy="2" stdDeviation="2" flood-opacity="0.35"/>
      </filter>
      <radialGradient id="circleGradP" cx="35%" cy="35%" r="60%">
        <stop offset="0%" style="stop-color:#45c98b"/>
        <stop offset="100%" style="stop-color:#34B27B"/>
      </radialGradient>
      <radialGradient id="circleHighlightP" cx="30%" cy="30%" r="50%">
        <stop offset="0%" style="stop-color:rgba(255,255,255,0.6)"/>
        <stop offset="100%" style="stop-color:rgba(255,255,255,0)"/>
      </radialGradient>
    </defs>
    <g filter="url(#shadowCircleP)">
      <circle cx="16" cy="16" r="12" fill="url(#circleGradP)"/>
      <circle cx="16" cy="16" r="11" fill="none" stroke="#ffffff" stroke-width="2.5" stroke-opacity="0.95"/>
      <circle cx="14" cy="14" r="5" fill="url(#circleHighlightP)"/>
    </g>
  </svg>`,
} as const;

export type CursorType = keyof typeof CURSOR_SVGS;

// Pre-render SVG to Image for canvas drawing
const svgCache = new Map<string, HTMLImageElement>();

export function svgToImage(svg: string, size: number = 64): Promise<HTMLImageElement> {
  const cacheKey = `${svg}-${size}`;
  const cached = svgCache.get(cacheKey);
  if (cached) return Promise.resolve(cached);

  return new Promise((resolve, reject) => {
    const img = new Image();
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    
    img.onload = () => {
      URL.revokeObjectURL(url);
      svgCache.set(cacheKey, img);
      resolve(img);
    };
    
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    
    img.width = size;
    img.height = size;
    img.src = url;
  });
}

// Pre-load all cursor images
export async function preloadCursorImages(size: number = 64): Promise<Map<CursorType, HTMLImageElement>> {
  const images = new Map<CursorType, HTMLImageElement>();
  
  const entries = Object.entries(CURSOR_SVGS) as [CursorType, string][];
  await Promise.all(
    entries.map(async ([type, svg]) => {
      try {
        const img = await svgToImage(svg, size);
        images.set(type, img);
      } catch (e) {
        console.warn(`Failed to preload cursor: ${type}`, e);
      }
    })
  );
  
  return images;
}

// Get the hotspot (click point) offset for each cursor type
export function getCursorHotspot(type: CursorType): { x: number; y: number } {
  switch (type) {
    case 'pointer':
      return { x: 0.25, y: 0.1 }; // Top-left tip
    case 'hand':
      return { x: 0.4, y: 0.15 }; // Finger tip
    case 'text':
      return { x: 0.5, y: 0.5 }; // Center
    case 'crosshair':
      return { x: 0.5, y: 0.5 }; // Center
    case 'circle':
    case 'circlePressed':
      return { x: 0.5, y: 0.5 }; // Center
    default:
      return { x: 0.5, y: 0.5 };
  }
}
