// 像素篝火调色板 —— 颜色集中在这里，方便整体换色
export const PALETTE = {
  // 火焰：由外到内逐层升温
  flame0: "#93210a",
  flame1: "#d13f08",
  flame2: "#f4700c",
  flame3: "#ffa21a",
  flame4: "#ffcb45",
  flame5: "#fff0a6",
  flame6: "#fffdf2",

  // 木柴：a 最暗 -> f 最亮
  bark: "#1f1108",
  wood0: "#3a2112",
  wood1: "#5b3517",
  wood2: "#7d4a20",
  wood3: "#a2672f",
  wood4: "#c68c4e",

  // 余烬
  ember0: "#8a1d02",
  ember1: "#d43a03",
  ember2: "#ff7a12",
  ember3: "#ffb43c",
  ember4: "#ffe085",

  // 灰堆 / 地面
  ash0: "#24242b",
  ash1: "#33333c",
  ash2: "#45454f",
  ash3: "#57575f",
  ground: "rgba(6,5,10,0.45)",
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


