// Looks for the phone (index.html): the wallpaper, the text color on it, the phone outline, and the
// call-screen style. Saved on the server (data/config.json "appearance"), so every window matches.
//   wallpaper: a preset name below, or "custom" (your own picture, saved as data/wallpaper.jpg)
//   callStyle: "classic" (round picture, the default) or "photo" (their picture fills the screen, name across it)
//   frame:     the phone's outline color (FRAMES below), black by default
window.CallJoeTheme = (() => {
  const WALLPAPERS = {
    classic: { name: "Classic", css: "radial-gradient(circle at 50% 20%, #3a2a1c, #1d1712 70%)" },
    midnight: { name: "Midnight", css: "radial-gradient(circle at 30% 10%, #1e2a4a, #0b0f1c 70%)" },
    sunset: { name: "Sunset", css: "linear-gradient(160deg, #3b1f3f 0%, #7a2f2f 45%, #c46a2b 100%)" },
    lake: { name: "Lake", css: "linear-gradient(180deg, #0f2a3a 0%, #1d4b5e 55%, #0b1820 100%)" },
    forest: { name: "Forest", css: "radial-gradient(circle at 70% 0%, #2f4a2a, #121a10 70%)" },
    flannel: {
      name: "Flannel",
      css: "repeating-linear-gradient(90deg, rgba(0,0,0,.35) 0 18px, transparent 18px 60px), repeating-linear-gradient(0deg, rgba(0,0,0,.35) 0 18px, transparent 18px 60px), repeating-linear-gradient(90deg, rgba(160,40,40,.35) 0 4px, transparent 4px 60px), #2a1d1a",
    },
    wood: {
      name: "Wood paneling",
      css: "repeating-linear-gradient(90deg, rgba(0,0,0,.28) 0 2px, transparent 2px 70px), repeating-linear-gradient(90deg, #4a2f1a 0 9px, #53351d 9px 23px, #4e321b 23px 41px, #5a3a20 41px 70px)",
    },
    blush: { name: "Blush", css: "radial-gradient(circle at 30% 15%, #fde4ec, #f3b8c9 70%)", ink: "#3b1f2b" },
    lavender: { name: "Lavender", css: "linear-gradient(170deg, #ece2fb 0%, #c9b6ec 100%)", ink: "#2e2145" },
    peach: { name: "Peach", css: "linear-gradient(160deg, #ffe6d5 0%, #f6b99a 100%)", ink: "#4a2617" },
    rosegold: { name: "Rose gold", css: "linear-gradient(135deg, #f5d3c8 0%, #d9a59a 50%, #b97f7a 100%)", ink: "#3d1e1e" },
    floral: {
      name: "Floral",
      css: "radial-gradient(circle at 20% 25%, #f7a8c4 0 7%, transparent 8%), radial-gradient(circle at 75% 60%, #c9a3e8 0 6%, transparent 7%), radial-gradient(circle at 40% 85%, #ffc9a8 0 5%, transparent 6%), radial-gradient(circle at 85% 15%, #f7a8c4 0 4%, transparent 5%), #fdf1f4",
      ink: "#3b1f2b",
    },
    berry: { name: "Berry", css: "radial-gradient(circle at 30% 10%, #7a2a5c, #2c0f22 70%)" },
    plum: { name: "Plum dusk", css: "linear-gradient(170deg, #4b2a5e 0%, #8a4a78 55%, #d08a8a 100%)" },
  };

  // Text on the wallpaper (the clock, app names, titles). "auto" uses what suits each wallpaper; you can pick
  // another color for each wallpaper separately.
  const INKS = {
    auto: { name: "Auto" },
    white: { name: "White", color: "#ffffff" },
    cream: { name: "Cream", color: "#f4ead9" },
    pink: { name: "Pink", color: "#ffc4d6" },
    gold: { name: "Gold", color: "#f2c46d" },
    black: { name: "Black", color: "#141414" },
    plum: { name: "Plum", color: "#4a1f45" },
    navy: { name: "Navy", color: "#1c2a4a" },
    brown: { name: "Brown", color: "#3d2616" },
  };
  // The phone's outline, around the edge of the window. "none" takes it away.
  const FRAMES = {
    black: { name: "Black", color: "#050505" },
    graphite: { name: "Graphite", color: "#3a3d42" },
    silver: { name: "Silver", color: "#b9bcc1" },
    blue: { name: "Blue", color: "#2c4a7a" },
    green: { name: "Sage", color: "#55705a" },
    rose: { name: "Rose", color: "#b97c7c" },
    pink: { name: "Pink", color: "#e8a3b8" },
    lavender: { name: "Lavender", color: "#b9a3d9" },
    rosegold: { name: "Rose gold", color: "#d8a48f" },
    white: { name: "White", color: "#f2efec" },
    none: { name: "None", color: "transparent" },
  };
  const DEFAULTS = { wallpaper: "classic", callStyle: "classic", frame: "black", ink: {}, v: 0 };
  let current = { ...DEFAULTS };

  async function load() {
    const a = await fetch("/api/appearance").then((r) => r.json()).catch(() => ({}));
    current = { ...DEFAULTS, ...a };
    return current;
  }

  // A darkened version of a custom picture, so text and buttons stay readable on top of it.
  function wallpaperCss(a = current) {
    if (a.wallpaper === "custom") {
      return `linear-gradient(rgba(18,14,10,.55), rgba(18,14,10,.78)), url("/api/wallpaper?v=${a.v}") center / cover no-repeat`;
    }
    return (WALLPAPERS[a.wallpaper] ?? WALLPAPERS.classic).css;
  }

  // The text color for the current wallpaper: your pick for it, or what suits it.
  function inkColor(a = current) {
    const pick = INKS[a.ink?.[a.wallpaper]]?.color;
    return pick ?? (a.wallpaper === "custom" ? "#f4ead9" : (WALLPAPERS[a.wallpaper] ?? WALLPAPERS.classic).ink ?? "#f4ead9");
  }

  // A friend's picture filling the screen, darker at the top and bottom where the name and buttons go.
  const photoCss = (face) =>
    `linear-gradient(to bottom, rgba(0,0,0,.55), rgba(0,0,0,.1) 30%, rgba(0,0,0,.15) 60%, rgba(0,0,0,.8)), url("/api/face?name=${encodeURIComponent(face)}") center 25% / cover no-repeat, #000`;

  async function save(changes) {
    const r = await fetch("/api/appearance", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(changes),
    });
    current = { ...DEFAULTS, ...(await r.json()) };
    if ("BroadcastChannel" in window) new BroadcastChannel("calljoe").postMessage({ type: "appearance-changed" });
    return current;
  }

  return { WALLPAPERS, FRAMES, INKS, inkColor, load, save, wallpaperCss, photoCss, get: () => current };
})();
