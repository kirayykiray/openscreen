import { Application, Sprite, Graphics } from 'pixi.js';
import { VIEWPORT_SCALE } from "./constants";
import type { CropRegion, CornerSettings } from '../types';

// Draw a squircle (superellipse) path - iOS-style smooth corners
// Uses continuous curvature bezier approximation
function drawSquirclePath(
  graphics: Graphics,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  corners: { tl: boolean; tr: boolean; bl: boolean; br: boolean }
) {
  // Clamp radius to half the smaller dimension
  const maxRadius = Math.min(width, height) / 2;
  const r = Math.min(radius, maxRadius);
  
  // iOS-style squircle uses extended bezier control points
  // p = smoothness factor * radius, extends the curve into the straight edge
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
  graphics.moveTo(x + tl + tlP, y);
  
  // Top edge
  graphics.lineTo(x + width - tr - trP, y);
  
  // Top-right corner (squircle)
  if (tr > 0) {
    graphics.bezierCurveTo(
      x + width - tr + c, y,
      x + width, y + tr - c,
      x + width, y + tr + trP
    );
  } else {
    graphics.lineTo(x + width, y);
  }
  
  // Right edge
  graphics.lineTo(x + width, y + height - br - brP);
  
  // Bottom-right corner (squircle)
  if (br > 0) {
    graphics.bezierCurveTo(
      x + width, y + height - br + c,
      x + width - br + c, y + height,
      x + width - br - brP, y + height
    );
  } else {
    graphics.lineTo(x + width, y + height);
  }
  
  // Bottom edge
  graphics.lineTo(x + bl + blP, y + height);
  
  // Bottom-left corner (squircle)
  if (bl > 0) {
    graphics.bezierCurveTo(
      x + bl - c, y + height,
      x, y + height - bl + c,
      x, y + height - bl - blP
    );
  } else {
    graphics.lineTo(x, y + height);
  }
  
  // Left edge
  graphics.lineTo(x, y + tl + tlP);
  
  // Top-left corner (squircle)
  if (tl > 0) {
    graphics.bezierCurveTo(
      x, y + tl - c,
      x + tl - c, y,
      x + tl + tlP, y
    );
  } else {
    graphics.lineTo(x, y);
  }
  
  graphics.closePath();
}

interface LayoutParams {
  container: HTMLDivElement;
  app: Application;
  videoSprite: Sprite;
  maskGraphics: Graphics;
  videoElement: HTMLVideoElement;
  cropRegion?: CropRegion;
  lockedVideoDimensions?: { width: number; height: number } | null;
  cornerRadius?: number;
  cornerSettings?: CornerSettings;
  padding?: number; // 0-50: percentage of canvas to use as padding (default uses VIEWPORT_SCALE)
}

interface LayoutResult {
  stageSize: { width: number; height: number };
  videoSize: { width: number; height: number };
  baseScale: number;
  baseOffset: { x: number; y: number };
  maskRect: { x: number; y: number; width: number; height: number };
  cropBounds: { startX: number; endX: number; startY: number; endY: number };
}

export function layoutVideoContent(params: LayoutParams): LayoutResult | null {
  const { container, app, videoSprite, maskGraphics, videoElement, cropRegion, lockedVideoDimensions, cornerRadius = 0, cornerSettings, padding } = params;

  // Calculate viewport scale from padding (0-50) -> (1.0-0.5)
  // padding=0 means no padding (100% of canvas used) -> scale=1.0
  // padding=50 means maximum padding (50% of canvas used) -> scale=0.5
  // If padding is not provided, use the default VIEWPORT_SCALE
  const viewportScale = padding !== undefined ? 1 - (padding / 100) : VIEWPORT_SCALE;


  const videoWidth = lockedVideoDimensions?.width || videoElement.videoWidth;
  const videoHeight = lockedVideoDimensions?.height || videoElement.videoHeight;

  if (!videoWidth || !videoHeight) {
    return null;
  }

  const width = container.clientWidth;
  const height = container.clientHeight;

  if (!width || !height) {
    return null;
  }

  app.renderer.resize(width, height);
  app.canvas.style.width = '100%';
  app.canvas.style.height = '100%';

  // Apply crop region
  const crop = cropRegion || { x: 0, y: 0, width: 1, height: 1 };
  
  // Calculate the cropped dimensions
  const croppedVideoWidth = videoWidth * crop.width;
  const croppedVideoHeight = videoHeight * crop.height;

  const cropStartX = crop.x * videoWidth;
  const cropStartY = crop.y * videoHeight;
  const cropEndX = cropStartX + croppedVideoWidth;
  const cropEndY = cropStartY + croppedVideoHeight;
  
  // Calculate scale to fit the cropped area in the viewport
  const maxDisplayWidth = width * viewportScale;
  const maxDisplayHeight = height * viewportScale;

  const scale = Math.min(
    maxDisplayWidth / croppedVideoWidth,
    maxDisplayHeight / croppedVideoHeight,
    1
  );

  videoSprite.scale.set(scale);
  
  // Calculate display size of the full video at this scale
  const fullVideoDisplayWidth = videoWidth * scale;
  const fullVideoDisplayHeight = videoHeight * scale;
  
  // Calculate display size of just the cropped region
  const croppedDisplayWidth = croppedVideoWidth * scale;
  const croppedDisplayHeight = croppedVideoHeight * scale;

  // Center the cropped region in the container
  const centerOffsetX = (width - croppedDisplayWidth) / 2;
  const centerOffsetY = (height - croppedDisplayHeight) / 2;
  
  // Position the full video sprite so that when we apply the mask,
  // the cropped region appears centered
  // The crop starts at (crop.x * videoWidth, crop.y * videoHeight) in video coordinates
  // In display coordinates, that's (crop.x * fullVideoDisplayWidth, crop.y * fullVideoDisplayHeight)
  // We want that point to be at centerOffsetX, centerOffsetY
  const spriteX = centerOffsetX - (crop.x * fullVideoDisplayWidth);
  const spriteY = centerOffsetY - (crop.y * fullVideoDisplayHeight);
  
  videoSprite.position.set(spriteX, spriteY);

  // Create a mask that only shows the cropped region (centered in container)
  const maskX = centerOffsetX;
  const maskY = centerOffsetY;
  // Scale the corner radius to match the video scale
  const radius = (cornerSettings?.radius ?? cornerRadius ?? 0) * scale;
  
  maskGraphics.clear();
  
  // Use squircle or rounded based on settings
  const useSquircle = cornerSettings?.style === 'squircle' || !cornerSettings;
  const corners = cornerSettings ? {
    tl: cornerSettings.topLeft,
    tr: cornerSettings.topRight,
    bl: cornerSettings.bottomLeft,
    br: cornerSettings.bottomRight,
  } : { tl: true, tr: true, bl: true, br: true };
  
  if (radius > 0 && useSquircle) {
    drawSquirclePath(maskGraphics, maskX, maskY, croppedDisplayWidth, croppedDisplayHeight, radius, corners);
    maskGraphics.fill({ color: 0xffffff });
  } else if (radius > 0) {
    // Standard rounded corners with individual corner control
    const tl = corners.tl ? radius : 0;
    const tr = corners.tr ? radius : 0;
    const bl = corners.bl ? radius : 0;
    const br = corners.br ? radius : 0;
    
    maskGraphics.moveTo(maskX + tl, maskY);
    maskGraphics.lineTo(maskX + croppedDisplayWidth - tr, maskY);
    if (tr > 0) maskGraphics.arcTo(maskX + croppedDisplayWidth, maskY, maskX + croppedDisplayWidth, maskY + tr, tr);
    else maskGraphics.lineTo(maskX + croppedDisplayWidth, maskY);
    maskGraphics.lineTo(maskX + croppedDisplayWidth, maskY + croppedDisplayHeight - br);
    if (br > 0) maskGraphics.arcTo(maskX + croppedDisplayWidth, maskY + croppedDisplayHeight, maskX + croppedDisplayWidth - br, maskY + croppedDisplayHeight, br);
    else maskGraphics.lineTo(maskX + croppedDisplayWidth, maskY + croppedDisplayHeight);
    maskGraphics.lineTo(maskX + bl, maskY + croppedDisplayHeight);
    if (bl > 0) maskGraphics.arcTo(maskX, maskY + croppedDisplayHeight, maskX, maskY + croppedDisplayHeight - bl, bl);
    else maskGraphics.lineTo(maskX, maskY + croppedDisplayHeight);
    maskGraphics.lineTo(maskX, maskY + tl);
    if (tl > 0) maskGraphics.arcTo(maskX, maskY, maskX + tl, maskY, tl);
    else maskGraphics.lineTo(maskX, maskY);
    maskGraphics.closePath();
    maskGraphics.fill({ color: 0xffffff });
  } else {
    maskGraphics.rect(maskX, maskY, croppedDisplayWidth, croppedDisplayHeight);
    maskGraphics.fill({ color: 0xffffff });
  }

  return {
    stageSize: { width, height },
    videoSize: { width: croppedVideoWidth, height: croppedVideoHeight },
    baseScale: scale,
    baseOffset: { x: spriteX, y: spriteY },
    maskRect: { x: maskX, y: maskY, width: croppedDisplayWidth, height: croppedDisplayHeight },
    cropBounds: { startX: cropStartX, endX: cropEndX, startY: cropStartY, endY: cropEndY },
  };
}
