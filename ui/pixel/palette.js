// 像素篝火调色板 —— 颜色集中在这里，方便整体换色
// 火焰按真实木火配色，冷端压一点紫罗兰：外缘紫红、中层红橙、火芯金黄发白，石块上刻着冰蓝符文
export const PALETTE = {
  // 木材火焰：由外到内逐层升温（紫红 → 红橙 → 橙 → 金黄 → 暖白）
  flame0: "#4c1247",
  flame1: "#7d1a40",
  flame2: "#b02b3c",
  flame3: "#e34c26",
  flame4: "#ff7d16",
  flame5: "#ffb237",
  flame6: "#fff1c2",

  // 余烬：炉膛里剩下的暖色
  ember0: "#6a1f3a",
  ember1: "#c34a08",
  ember2: "#ff7a12",
  ember3: "#ffb43c",
  ember4: "#ffe085",

  // 围炉的石头
  stone1: "#1e1c28",
  stone2: "#332f45",
  stone3: "#524c68",
  stone4: "#6e6788",

  // 符文：刻在石块上的冰蓝魔法纹样
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
