// 像素篝火调色板 —— 颜色集中在这里，方便整体换色
// 走的是"秘法篝火"路线：外焰紫罗兰，火心转金白，柴面上刻着冰蓝符文
export const PALETTE = {
  // 奥术火焰：由外到内逐层升温（紫 → 品红 → 金 → 白）
  flame0: "#3a1a5e",
  flame1: "#6a2aa8",
  flame2: "#a63ad6",
  flame3: "#e062c8",
  flame4: "#ff9f5a",
  flame5: "#ffd27a",
  flame6: "#fff6dc",

  // 古木：做旧的深色木梁
  bark: "#18110c",
  wood0: "#2e2118",
  wood1: "#463322",
  wood2: "#5e452c",
  wood3: "#7a5a39",
  wood4: "#96764c",

  // 余烬：炉膛里剩下的暖色
  ember0: "#7a2a10",
  ember1: "#c34a08",
  ember2: "#ff7a12",
  ember3: "#ffb43c",
  ember4: "#ffe085",

  // 围炉的石头
  stone0: "#12131b",
  stone1: "#20222f",
  stone2: "#313444",
  stone3: "#474c60",
  stone4: "#646a80",

  // 符文：刻在石头上和木梁上的魔法纹样
  rune0: "#4de0ff",
  rune1: "#a06bff",
  rune2: "#e9f6ff",

  // 苔藓
  moss0: "#223a2c",
  moss1: "#31513a",

  // 圈内地面
  ash0: "#1a1a24",
  ash1: "#242634",
  ground: "rgba(6,5,12,0.5)",
};

// 火焰色阶，索引即热度 0..6
export const FLAME_RAMP = [
  "flame0",
  "flame1",
  "flame2",
  "flame3",
  "flame4",
  "flame5",
  "flame6",
];

// 余烬色阶，索引即热度 0..4
export const EMBER_RAMP = ["ember0", "ember1", "ember2", "ember3", "ember4"];
