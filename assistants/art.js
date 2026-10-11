/* Shared artwork helpers for the game assistants.
   TWArt.hero(appid, title) returns a banner using the game's Steam header art.
   Newer games aren't on Steam's old cdn.cloudflare /steam/apps/ path, so each
   image tries Steam's current store_item_assets CDN first, then older hosts and
   other Steam art (capsule, library hero). If none load (offline, blocked), the
   image removes itself.
   Plain <img data-steam="appid" onerror="TWArt.next(this)"> works too. */
(function () {
  const css = `
.tw-hero{position:relative;aspect-ratio:460/215;max-width:460px;border-radius:12px;overflow:hidden;margin:0 0 16px;
  background:linear-gradient(135deg,var(--panel2,#1b2a27),var(--panel,#131d1b));border:1px solid var(--line,#2b423d);
  display:flex;align-items:flex-end;padding:14px 16px;font-size:22px;font-weight:700;color:var(--dim,#94aaa2)}
.tw-hero img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.tw-map{width:100%;height:auto;display:block;border-radius:10px;background:var(--panel,#131d1b);border:1px solid var(--line,#2b423d);margin:0 0 14px}
.tw-map a{cursor:pointer}
.tw-map a:hover .hit,.tw-map a:focus .hit{stroke:var(--acc,#e9b45a);stroke-width:3}
.tw-map text{font-family:"Segoe UI",system-ui,sans-serif}
.tw-map .lbl{paint-order:stroke;stroke:#0f1c22;stroke-width:4px;stroke-linejoin:round}
.tw-cap{color:var(--dim,#94aaa2);font-size:12px;margin:-8px 0 14px}`;
  const st = document.createElement('style');
  st.textContent = css;
  document.head.appendChild(st);

  const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  window.TWArt = {
    urls: id => [
      'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/' + id + '/header.jpg',
      'https://cdn.akamai.steamstatic.com/steam/apps/' + id + '/header.jpg',
      'https://cdn.cloudflare.steamstatic.com/steam/apps/' + id + '/header.jpg',
      'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/' + id + '/capsule_616x353.jpg',
      'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/' + id + '/library_hero.jpg'
    ],
    steam(id) { return this.urls(id)[0]; },
    // onerror handler: move to the next Steam URL, or remove the image (and with
    // data-steam-drop="parent", its banner) once every URL has failed.
    next(img) {
      const list = this.urls(img.dataset.steam), i = (+img.dataset.steamTry || 0) + 1;
      if (i < list.length) { img.dataset.steamTry = i; img.src = list[i]; return; }
      (img.dataset.steamDrop === 'parent' ? img.parentNode : img).remove();
    },
    hero(id, title) {
      return `<div class="tw-hero">${esc(title)}<img src="${this.steam(id)}" data-steam="${esc(id)}" data-steam-drop="parent" alt="${esc(title)} key art" loading="lazy" onerror="TWArt.next(this)"></div>`;
    },
    esc
  };
})();
