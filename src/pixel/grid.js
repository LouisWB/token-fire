// 像素网格工具：所有画面都先画成格子，再转成 SVG

export function createGrid(w, h) {
  return { w, h, cells: new Array(w * h).fill(null) };
}

export function put(grid, x, y, color) {
  if (color == null) return;
  if (x < 0 || y < 0 || x >= grid.w || y >= grid.h) return;
  grid.cells[y * grid.w + x] = color;
}

export function at(grid, x, y) {
  if (x < 0 || y < 0 || x >= grid.w || y >= grid.h) return null;
  return grid.cells[y * grid.w + x];
}

export function fillEllipse(grid, cx, cy, rx, ry, color) {
  const y0 = Math.floor(cy - ry);
  const y1 = Math.ceil(cy + ry);
  const x0 = Math.floor(cx - rx);
  const x1 = Math.ceil(cx + rx);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = (x + 0.5 - cx) / rx;
      const dy = (y + 0.5 - cy) / ry;
      if (dx * dx + dy * dy <= 1) put(grid, x, y, color);
    }
  }
}

// 同一行里相邻的同色像素合并成一条 rect，显著减小 SVG 体积
export function mergeRuns(grid) {
  const runs = [];
  for (let y = 0; y < grid.h; y++) {
    let x = 0;
    while (x < grid.w) {
      const color = grid.cells[y * grid.w + x];
      if (color == null) {
        x++;
        continue;
      }
      let end = x;
      while (end + 1 < grid.w && grid.cells[y * grid.w + end + 1] === color) end++;
      runs.push({ x, y, w: end - x + 1, color });
      x = end + 1;
    }
  }
  return runs;
}
