/* boardLayouts.js
   Dynamic Board Layout Descriptors & Peg Position Generators

   Exported API:
     getLayoutDescriptor(layoutId: string, fallbackId?: string) -> descriptor
     generatePegPositions(descriptor, boardWidth, baseRows?) -> { pegPositions, rows, slotCount }

   Descriptor Shape:
   {
     id: 'classic' | 'honeycomb' | 'gaps' | 'spiral' | custom,
     rows: number,                 // logical “rows” for Galton / honeycomb / gaps
     type: 'triangular' | 'honeycomb' | 'gaps' | 'spiral',
     spacingScale: number,         // scale multiplier for peg spacing (1 = default)
     gapPattern?: { every: number, skipMod: number },  // for 'gaps'
     spiral?: { turns: number, radialStart: number, radialEnd: number },
     slotCountOverride?: number    // optional custom slot count
   }

   Notes:
   - All coordinates use same world space (centered board).
   - For spiral we ignore traditional row logic and generate an outward (or inward) spiral
     then derive slotCount from descriptor.slotCountOverride || default (rows+1 fallback).
*/

const LAYOUT_LIBRARY = {
  classic: {
    id: 'classic',
    rows: 12,
    type: 'triangular',
    spacingScale: 1
  },
  honeycomb: {
    id: 'honeycomb',
    rows: 13,
    type: 'honeycomb',
    spacingScale: 0.92
  },
  gaps: {
    id: 'gaps',
    rows: 14,
    type: 'gaps',
    spacingScale: 1,
    gapPattern: { every: 3, skipMod: 1 } // every 3rd row skip every second peg
  },
  spiral: {
    id: 'spiral',
    rows: 14, // conceptual ring count
    type: 'spiral',
    spacingScale: 1,
    spiral: { turns: 2.2, radialStart: 0.1, radialEnd: 0.92 },
    slotCountOverride: 15
  }
};

export function getLayoutDescriptor(layoutId, fallbackId='classic'){
  return LAYOUT_LIBRARY[layoutId] || LAYOUT_LIBRARY[fallbackId] || LAYOUT_LIBRARY.classic;
}

/**
 * Generate peg positions for a given descriptor.
 * @param {object} descriptor
 * @param {number} boardWidth
 * @param {number} baseRows optional override base
 * @returns {{pegPositions: Array<{x:number,y:number}>, rows:number, slotCount:number}}
 */
export function generatePegPositions(descriptor, boardWidth, baseRows){
  const type = descriptor.type;
  const rows = baseRows || descriptor.rows;
  const spacingScale = descriptor.spacingScale ?? 1;
  // Base spacing similar to original: width / (rows+1)
  const baseSpacing = (boardWidth / (rows + 1)) * spacingScale;

  if(type === 'triangular'){
    return generateTriangular(rows, baseSpacing);
  }
  if(type === 'honeycomb'){
    return generateHoneycomb(rows, baseSpacing);
  }
  if(type === 'gaps'){
    return generateGaps(rows, baseSpacing, descriptor.gapPattern);
  }
  if(type === 'spiral'){
    return generateSpiral(descriptor, boardWidth, rows);
  }
  // fallback
  return generateTriangular(rows, baseSpacing);
}

function generateTriangular(rows, spacing){
  const startX = -((rows - 1) * spacing)/2;
  const pegPositions=[];
  for(let r=0;r<rows;r++){
    const y = (rows/2 * spacing) - r * spacing * 0.9; // 0.9 vertical compression as original
    for(let c=0;c<=r;c++){
      const x = startX + c*spacing + (rows-1-r)*(spacing/2);
      pegPositions.push({x,y});
    }
  }
  return { pegPositions, rows, slotCount: rows + 1 };
}

function generateHoneycomb(rows, spacing){
  // Build a roughly hex/grid pattern – each row has same count; offset alternating rows by half spacing
  const cols = rows + 2; // a bit wider
  const totalWidth = (cols - 1) * spacing;
  const startX = -totalWidth / 2;
  const pegPositions=[];
  for(let r=0;r<rows;r++){
    const y = (rows/2 * spacing) - r * spacing * 0.85;
    const xOffset = (r % 2 === 0) ? 0 : spacing * 0.5;
    for(let c=0;c<cols;c++){
      const x = startX + c*spacing + xOffset;
      pegPositions.push({x,y});
    }
  }
  // Slot count could be closer to cols; use cols
  return { pegPositions, rows, slotCount: cols };
}

function generateGaps(rows, spacing, pattern){
  const startX = -((rows - 1) * spacing)/2;
  const pegPositions=[];
  const every = pattern?.every ?? 3;
  const skipMod = pattern?.skipMod ?? 1;
  for(let r=0;r<rows;r++){
    const y = (rows/2 * spacing) - r * spacing * 0.9;
    for(let c=0;c<=r;c++){
      // Determine if this peg should be skipped
      if(r % every === skipMod){
        // Skip every other peg in this special row
        if(c % 2 === 1) continue;
      }
      const x = startX + c*spacing + (rows-1-r)*(spacing/2);
      pegPositions.push({x,y});
    }
  }
  return { pegPositions, rows, slotCount: rows + 1 };
}

function generateSpiral(descriptor, boardWidth, rows){
  // Generate a spiral of pegs – center at 0,0
  const { turns=2, radialStart=0.1, radialEnd=0.9 } = descriptor.spiral || {};
  const pegPositions=[];
  const pegCount = rows * 28; // approximate density
  const maxRadius = (boardWidth/2) * radialEnd;
  const minRadius = (boardWidth/2) * radialStart;
  for(let i=0;i<pegCount;i++){
    const t = i / (pegCount - 1);
    const angle = t * Math.PI * 2 * turns;
    const radius = minRadius + (maxRadius - minRadius) * t;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius * 0.6; // vertical squash to fit board shape
    pegPositions.push({x,y});
  }
  const slotCount = descriptor.slotCountOverride || (rows + 1);
  return { pegPositions, rows, slotCount };
}