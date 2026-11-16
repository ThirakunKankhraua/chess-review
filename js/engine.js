// Thin promise wrapper around the Stockfish WASM worker (UCI protocol over postMessage).

export class Engine {
  /**
   * @param {string} path URL of the Stockfish worker script (must be same-origin).
   */
  constructor(path) {
    this.worker = new Worker(path);
    this.listeners = new Set();
    this.name = 'Stockfish';
    /** Chain used to run one search at a time; UCI has no request ids. */
    this.queue = Promise.resolve();

    this.worker.onmessage = (e) => {
      const line = typeof e.data === 'string' ? e.data : String(e.data);
      if (line.startsWith('id name ')) this.name = line.slice(8);
      for (const listener of [...this.listeners]) listener(line);
    };
    this.ready = new Promise((resolve, reject) => {
      this.worker.onerror = (e) => reject(new Error(e.message || 'engine failed to load'));
      this._handshake().then(resolve, reject);
    });
  }

  /**
   * Send one UCI command.
   * @param {string} cmd
   */
  _send(cmd) {
    this.worker.postMessage(cmd);
  }

  /**
   * Resolve with the first engine output line that satisfies a test.
   * @param {(line: string) => boolean} test
   * @returns {Promise<string>}
   */
  _waitFor(test) {
    return new Promise((resolve) => {
      const listener = (line) => {
        if (test(line)) {
          this.listeners.delete(listener);
          resolve(line);
        }
      };
      this.listeners.add(listener);
    });
  }

  /** Run the UCI start-up exchange. */
  async _handshake() {
    const uciok = this._waitFor((l) => l === 'uciok');
    this._send('uci');
    await uciok;
    const readyok = this._waitFor((l) => l === 'readyok');
    this._send('isready');
    await readyok;
  }

  /** Clear the engine's hash table before a new game so results are repeatable. */
  newGame() {
    this.queue = this.queue.then(async () => {
      await this.ready;
      const readyok = this._waitFor((l) => l === 'readyok');
      this._send('ucinewgame');
      this._send('isready');
      await readyok;
    });
    return this.queue;
  }

  /**
   * Search one position to a fixed depth.
   * @param {string} fen Position to search.
   * @param {number} depth Search depth in plies.
   * @returns {Promise<{type: 'cp' | 'mate', value: number, best: string | null, pv: string[], depth: number}>}
   *   Score is from the point of view of the side to move, as UCI reports it.
   */
  analyse(fen, depth) {
    const run = async () => {
      await this.ready;
      let last = null;
      const onInfo = (line) => {
        if (!line.startsWith('info ') || line.includes('bound')) return;
        const score = line.match(/ score (cp|mate) (-?\d+)/);
        const pv = line.match(/ pv (.+)$/);
        if (!score || !pv) return;
        const d = line.match(/ depth (\d+)/);
        last = {
          type: score[1],
          value: Number(score[2]),
          pv: pv[1].trim().split(/\s+/),
          depth: d ? Number(d[1]) : 0,
        };
      };
      this.listeners.add(onInfo);
      const done = this._waitFor((l) => l.startsWith('bestmove'));
      this._send(`position fen ${fen}`);
      this._send(`go depth ${depth}`);
      const bestLine = await done;
      this.listeners.delete(onInfo);

      const bestMove = bestLine.split(/\s+/)[1];
      const best = bestMove && bestMove !== '(none)' ? bestMove : null;
      if (!last) return { type: 'cp', value: 0, best, pv: best ? [best] : [], depth: 0 };
      return { ...last, best: best || last.pv[0] || null };
    };
    const result = this.queue.then(run);
    this.queue = result.catch(() => {});
    return result;
  }

  /** Ask the engine to end the current search early. */
  stop() {
    this._send('stop');
  }
}
