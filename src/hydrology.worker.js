class MinHeap {
  constructor() { this.items = []; }
  push(index, value) {
    const item = { index, value };
    this.items.push(item);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.items[parent].value <= value) break;
      this.items[i] = this.items[parent];
      i = parent;
    }
    this.items[i] = item;
  }
  pop() {
    if (!this.items.length) return null;
    const root = this.items[0];
    const tail = this.items.pop();
    if (this.items.length) {
      let i = 0;
      while (true) {
        let child = i * 2 + 1;
        if (child >= this.items.length) break;
        if (child + 1 < this.items.length && this.items[child + 1].value < this.items[child].value) child++;
        if (this.items[child].value >= tail.value) break;
        this.items[i] = this.items[child];
        i = child;
      }
      this.items[i] = tail;
    }
    return root;
  }
  get length() { return this.items.length; }
}

const neighbours = [
  [-1, -1, Math.SQRT2], [0, -1, 1], [1, -1, Math.SQRT2],
  [-1, 0, 1],                         [1, 0, 1],
  [-1, 1, Math.SQRT2],  [0, 1, 1],   [1, 1, Math.SQRT2],
];

function isValid(value, noData) {
  return Number.isFinite(value) && (noData === null || value !== noData);
}

self.onmessage = ({ data }) => {
  const {
    elevations: buffer,
    width,
    height,
    noData: rawNoData,
    pixelArea,
    pixelWidth = 1,
    pixelHeight = 1,
  } = data;
  const noData = rawNoData === null ? null : Number(rawNoData);
  const source = new Float32Array(buffer);
  const size = width * height;
  const filled = new Float32Array(source);
  const depth = new Float32Array(size);
  const visited = new Uint8Array(size);
  const parent = new Int32Array(size);
  parent.fill(-1);
  const heap = new MinHeap();

  const addSeed = (index) => {
    if (visited[index] || !isValid(source[index], noData)) return;
    visited[index] = 1;
    heap.push(index, source[index]);
  };

  for (let x = 0; x < width; x++) {
    addSeed(x);
    addSeed((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y++) {
    addSeed(y * width);
    addSeed(y * width + width - 1);
  }

  // Cells next to NoData are also treated as open drainage boundaries.
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const index = y * width + x;
      if (!isValid(source[index], noData)) continue;
      for (const [dx, dy] of neighbours) {
        if (!isValid(source[(y + dy) * width + x + dx], noData)) {
          addSeed(index);
          break;
        }
      }
    }
  }

  self.postMessage({ type: 'progress', stage: 'Filling depression', value: 0.15 });
  let processed = 0;
  while (heap.length) {
    const current = heap.pop();
    const cx = current.index % width;
    const cy = Math.floor(current.index / width);
    for (const [dx, dy] of neighbours) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const ni = ny * width + nx;
      if (visited[ni] || !isValid(source[ni], noData)) continue;
      visited[ni] = 1;
      parent[ni] = current.index;
      filled[ni] = Math.max(source[ni], current.value);
      depth[ni] = Math.max(0, filled[ni] - source[ni]);
      heap.push(ni, filled[ni]);
    }
    processed++;
    if (processed % 100000 === 0) self.postMessage({ type: 'progress', stage: 'Filling depression', value: Math.min(0.45, 0.15 + processed / size * 0.3) });
  }

  self.postMessage({ type: 'progress', stage: 'Calculating D8 flow', value: 0.5 });
  const flowTo = new Int32Array(size);
  flowTo.fill(-1);
  const indegree = new Uint8Array(size);
  let validCount = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (!isValid(source[index], noData)) continue;
      validCount++;
      let target = -1;
      let bestDrop = 0;
      for (const [dx, dy] of neighbours) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const ni = ny * width + nx;
        if (!isValid(source[ni], noData)) continue;
        const distance = Math.hypot(dx * pixelWidth, dy * pixelHeight);
        const drop = (filled[index] - filled[ni]) / Math.max(0.01, distance);
        if (drop > bestDrop) {
          bestDrop = drop;
          target = ni;
        }
      }
      if (target < 0 && parent[index] >= 0) target = parent[index];
      flowTo[index] = target;
      if (target >= 0) indegree[target]++;
    }
  }

  self.postMessage({ type: 'progress', stage: 'Accumulating upstream area', value: 0.68 });
  const accumulation = new Float32Array(size);
  const queue = new Int32Array(validCount);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < size; i++) {
    if (isValid(source[i], noData)) {
      accumulation[i] = 1;
      if (indegree[i] === 0) queue[tail++] = i;
    }
  }

  let maxAccumulation = 1;
  while (head < tail) {
    const index = queue[head++];
    const target = flowTo[index];
    maxAccumulation = Math.max(maxAccumulation, accumulation[index]);
    if (target >= 0) {
      accumulation[target] += accumulation[index];
      indegree[target]--;
      if (indegree[target] === 0) queue[tail++] = target;
    }
  }

  let depressionPixels = 0;
  let maxDepth = 0;
  for (let i = 0; i < size; i++) {
    if (depth[i] > 0.02) depressionPixels++;
    maxDepth = Math.max(maxDepth, depth[i]);
  }

  self.postMessage({ type: 'progress', stage: 'Finalizing layers', value: 0.95 });
  self.postMessage({
    type: 'result',
    width,
    height,
    pixelArea,
    depressionPixels,
    maxDepth,
    maxAccumulation,
    filled: filled.buffer,
    depth: depth.buffer,
    flowTo: flowTo.buffer,
    accumulation: accumulation.buffer,
  }, [filled.buffer, depth.buffer, flowTo.buffer, accumulation.buffer]);
};
