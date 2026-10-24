// Looks shared by the call screen (index.html) and the Settings window (settings.html): the wallpaper, and the
// call-screen style. Saved on the server (data/config.json "appearance"), so both windows always match.
//   wallpaper: a preset name below, or "custom" (your own picture, saved as data/wallpaper.jpg)
//   callStyle: "classic" (round picture, the default) or "photo" (their picture fills the screen, name across it)
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
  };
  const DEFAULTS = { wallpaper: "classic", callStyle: "classic", v: 0 };
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

  return { WALLPAPERS, load, save, wallpaperCss, photoCss, get: () => current };
})();
