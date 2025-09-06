/* boardLayouts.js
   Dynamic Board Layout Descriptors & Peg Position Generators
   (Spiral layout REMOVED per request.)

   Exported API:
     getLayoutDescriptor(id, fallback?)
     generatePegPositions(descriptor, boardWidth)
     registerCustomLayout(id, descriptor)
     hasLayout(id)
     getAllLayoutIds()
     getLayoutLibrarySnapshot()

   Supported descriptor types now:
     'triangular' | 'honeycomb' | 'gaps'
*/

const INTERNAL_LAYOUTS = {
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
    gapPattern: { every: 3, skipMod: 1 }
  }
};

// Holds custom (server-loaded) layouts
const CUSTOM_LAYOUTS = Object.create(null);

function clamp(v,a,b){ return v < a ? a : v > b ? b : v; }

export function registerCustomLayout(id, descriptor){
  if(!id || typeof id!=='string') return;
  const safeId = id.trim();
  if(!safeId) return;
  const copy = { ...descriptor, id: safeId };
  copy.rows = clamp(parseInt(copy.rows)||12, 4, 60);
  copy.type = ['triangular','honeycomb','gaps'].includes(copy.type) ? copy.type : 'triangular';
  copy.spacingScale = clamp(Number(copy.spacingScale)||1, 0.5, 2.0);
  if(copy.type === 'gaps' && copy.gapPattern){
    copy.gapPattern = {
      every: clamp(parseInt(copy.gapPattern.every)||3, 2, 12),
      skipMod: clamp(parseInt(copy.gapPattern.skipMod)||1, 0, 10)
    };
  }
  CUSTOM_LAYOUTS[safeId] = copy;
}

export function hasLayout(id){
  return !!(INTERNAL_LAYOUTS[id] || CUSTOM_LAYOUTS[id]);
}

export function getAllLayoutIds(){
  return [
    ...Object.keys(INTERNAL_LAYOUTS),
    ...Object.keys(CUSTOM_LAYOUTS)
  ];
}

export function getLayoutLibrarySnapshot(){
  return {
    internal: { ...INTERNAL_LAYOUTS },
    custom: { ...CUSTOM_LAYOUTS }
  };
}

export function getLayoutDescriptor(layoutId, fallbackId='classic'){
  return CUSTOM_LAYOUTS[layoutId] ||
         INTERNAL_LAYOUTS[layoutId] ||
         CUSTOM_LAYOUTS[fallbackId] ||
         INTERNAL_LAYOUTS[fallbackId] ||
         INTERNAL_LAYOUTS.classic;
}

/**
 * Generate peg positions for a descriptor.
 * @param {object} descriptor
 * @param {number} boardWidth
 * @returns {{pegPositions:Array<{x:number,y:number}>, rows:number, slotCount:number}}
 */
export function generatePegPositions(descriptor, boardWidth){
  const type = descriptor.type;
  const rows = descriptor.rows;
  const spacingScale = descriptor.spacingScale ?? 1;
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
  // Fallback
  return generateTriangular(rows, baseSpacing);
}

function generateTriangular(rows, spacing){
  const startX = -((rows - 1) * spacing)/2;
  const pegPositions=[];
  for(let r=0;r<rows;r++){
    const y = (rows/2 * spacing) - r * spacing * 0.9;
    for(let c=0;c<=r;c++){
      const x = startX + c*spacing + (rows-1-r)*(spacing/2);
      pegPositions.push({x,y});
    }
  }
  return { pegPositions, rows, slotCount: rows + 1 };
}

function generateHoneycomb(rows, spacing){
  const cols = rows + 2;
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
      if(r % every === skipMod){
        if(c % 2 === 1) continue;
      }
      const x = startX + c*spacing + (rows-1-r)*(spacing/2);
      pegPositions.push({x,y});
    }
  }
  return { pegPositions, rows, slotCount: rows + 1 };
}

if(typeof window!=='undefined'){
  window.__BoardLayouts = {
    registerCustomLayout,
    getAllLayoutIds,
    hasLayout,
    getLayoutDescriptor
  };
}