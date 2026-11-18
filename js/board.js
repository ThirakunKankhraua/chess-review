// Read-only chess board renderer: draws a FEN position into a CSS grid.

const FILES = 'abcdefgh';
const PIECE_DIR = 'vendor/pieces/maestro/';
/** Duration of the slide when a piece moves, in milliseconds. */
const MOVE_MS = 170;

/**
 * Convert the piece-placement field of a FEN string into a square -> piece map.
 * @param {string} fen Full FEN string.
 * @returns {Map<string, string>} e.g. "e4" -> "wP", "g8" -> "bN".
 */
export function parseFenPieces(fen) {
  const pieces = new Map();
  const rows = fen.split(' ')[0].split('/');
  rows.forEach((row, rowIndex) => {
    let file = 0;
    for (const ch of row) {
      if (ch >= '1' && ch <= '8') {
        file += Number(ch);
      } else {
        const colour = ch === ch.toUpperCase() ? 'w' : 'b';
        pieces.set(FILES[file] + (8 - rowIndex), colour + ch.toUpperCase());
        file += 1;
      }
    }
  });
  return pieces;
}

export class Board {
  /**
   * @param {HTMLElement} el Container element that becomes the 8x8 grid.
   */
  constructor(el) {
    this.el = el;
    this.flipped = false;
    this.fen = null;
    this.lastMove = null;
    this.extras = {};
  }

  /**
   * Choose which side sits at the bottom of the board.
   * @param {boolean} flipped True puts Black at the bottom.
   */
  setFlipped(flipped) {
    this.flipped = flipped;
    if (this.fen) this.render(this.fen, this.lastMove, this.extras);
  }

  /**
   * Draw a position.
   * @param {string} fen Position to show.
   * @param {{from: string, to: string} | null} lastMove Squares to highlight, if any.
   * @param {{arrows?: {from: string, to: string, colour: string}[],
   *          badge?: {square: string, text: string, cls: string} | null,
   *          animate?: {from: string, to: string} | null}} extras Overlays; `animate` slides the
   *   piece now standing on `to` in from `from`.
   */
  render(fen, lastMove = null, extras = {}) {
    this.fen = fen;
    this.lastMove = lastMove;
    this.extras = extras;
    const pieces = parseFenPieces(fen);
    const frag = document.createDocumentFragment();

    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const fileIdx = this.flipped ? 7 - col : col;
        const rank = this.flipped ? row + 1 : 8 - row;
        const name = FILES[fileIdx] + rank;

        const sq = document.createElement('div');
        const isDark = (fileIdx + rank) % 2 === 1;
        sq.className = 'sq ' + (isDark ? 'dark' : 'light');
        sq.dataset.square = name;
        if (lastMove && (lastMove.from === name || lastMove.to === name)) sq.classList.add('hl');

        const piece = pieces.get(name);
        if (piece) {
          const img = document.createElement('img');
          img.src = PIECE_DIR + piece + '.svg';
          img.alt = piece;
          img.draggable = false;
          sq.appendChild(img);
        }
        if (col === 0) sq.appendChild(coordLabel('rank', String(rank)));
        if (row === 7) sq.appendChild(coordLabel('file', FILES[fileIdx]));
        if (extras.badge && extras.badge.square === name) {
          const badge = document.createElement('span');
          badge.className = 'badge ' + extras.badge.cls;
          badge.textContent = extras.badge.text;
          sq.appendChild(badge);
        }
        frag.appendChild(sq);
      }
    }

    if (extras.arrows && extras.arrows.length > 0) {
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', '0 0 8 8');
      svg.setAttribute('class', 'arrows');
      for (const arrow of extras.arrows) {
        svg.appendChild(this.arrowShape(arrow.from, arrow.to, arrow.colour));
      }
      frag.appendChild(svg);
    }
    this.el.replaceChildren(frag);
    if (extras.animate) this.slide(extras.animate.from, extras.animate.to);
  }

  /**
   * Slide the piece on `to` in from `from`, so a step through the game reads as a move
   * rather than a jump. Only the one moved piece is animated; the board itself is redrawn.
   * @param {string} from
   * @param {string} to
   */
  slide(from, to) {
    const img = this.el.querySelector(`[data-square="${to}"] img`);
    if (!img || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const [x1, y1] = this.squareCentre(from);
    const [x2, y2] = this.squareCentre(to);
    // The image is exactly one square in size, so 100% = one square.
    img.style.transform = `translate(${(x1 - x2) * 100}%, ${(y1 - y2) * 100}%)`;
    img.style.zIndex = '3';
    img.getBoundingClientRect(); // commit the start position before animating
    img.style.transition = `transform ${MOVE_MS}ms ease-out`;
    img.style.transform = '';
    img.addEventListener('transitionend', () => { img.style.zIndex = ''; img.style.transition = ''; }, { once: true });
  }

  /**
   * Centre of a square in board units (0..8), respecting orientation.
   * @param {string} name Square such as "e4".
   * @returns {[number, number]} [x, y]
   */
  squareCentre(name) {
    const fileIdx = FILES.indexOf(name[0]);
    const rank = Number(name[1]);
    const col = this.flipped ? 7 - fileIdx : fileIdx;
    const row = this.flipped ? rank - 1 : 8 - rank;
    return [col + 0.5, row + 0.5];
  }

  /**
   * Build one arrow polygon between two squares.
   * @param {string} from
   * @param {string} to
   * @param {string} colour CSS colour.
   * @returns {SVGPolygonElement}
   */
  arrowShape(from, to, colour) {
    const [x1, y1] = this.squareCentre(from);
    const [x2, y2] = this.squareCentre(to);
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    const ux = (x2 - x1) / len;
    const uy = (y2 - y1) / len;
    const px = -uy; // unit vector perpendicular to the arrow
    const py = ux;
    const shaft = 0.09;  // half-width of the shaft
    const head = 0.24;   // half-width of the arrow head
    const headLen = 0.42;
    const sx = x1 + ux * 0.28; // start a little away from the square centre
    const sy = y1 + uy * 0.28;
    const bx = x2 - ux * headLen; // base of the head
    const by = y2 - uy * headLen;
    const pts = [
      [sx + px * shaft, sy + py * shaft],
      [bx + px * shaft, by + py * shaft],
      [bx + px * head, by + py * head],
      [x2, y2],
      [bx - px * head, by - py * head],
      [bx - px * shaft, by - py * shaft],
      [sx - px * shaft, sy - py * shaft],
    ];
    const poly = document.createElementNS(SVG_NS, 'polygon');
    poly.setAttribute('points', pts.map((p) => p.map((v) => v.toFixed(3)).join(',')).join(' '));
    poly.setAttribute('fill', colour);
    poly.setAttribute('opacity', '0.9');
    // A thin dark edge keeps arrows readable on both the light and the dark wood squares.
    poly.setAttribute('stroke', 'rgba(0, 0, 0, 0.45)');
    poly.setAttribute('stroke-width', '0.03');
    poly.setAttribute('stroke-linejoin', 'round');
    return poly;
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';

// Load all twelve piece images up front so stepping through moves never shows an empty square.
const preloaded = [];
for (const colour of 'wb') {
  for (const type of 'KQRBNP') {
    const img = new Image();
    img.src = PIECE_DIR + colour + type + '.svg';
    preloaded.push(img);
  }
}

/**
 * Build one small coordinate label for a board edge square.
 * @param {'rank' | 'file'} kind Which edge the label belongs to.
 * @param {string} text Label text.
 * @returns {HTMLSpanElement}
 */
function coordLabel(kind, text) {
  const span = document.createElement('span');
  span.className = 'coord ' + kind;
  span.textContent = text;
  return span;
}
