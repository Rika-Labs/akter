/**
 * Inline script for the end of the document body. The page itself scrolls, so with scripts off
 * the browser restores a reloaded page's offset itself. With scripts on this script takes the
 * job (`history.scrollRestoration = 'manual'`), because the engines disagree about when to do
 * it: WebKit restores its own offset after the page's scripts have loaded, which draws the
 * first frame at the top, and the offset its history entry holds is the one it saved some time
 * after the last scroll, so a reload soon after a scroll is put back at a stale one and then
 * overrides any restoration made before it. At the end of the body the document has its full
 * height, so scrolling then happens before the first paint of an engine that waits for the whole
 * document. The offset is saved when the page is left, under the path it belongs to, and is read
 * back only for a reload or a back or forward visit, so a stale value cannot move a plain visit
 * or a link to an anchor.
 */
export const scrollRestoreScript = [
  "(function(){var w=window;try{",
  "if('scrollRestoration' in w.history)w.history.scrollRestoration='manual';",
  "var key='akter:scroll:'+w.location.pathname;",
  "var nav=w.performance.getEntriesByType('navigation')[0];",
  "var y=Number(w.sessionStorage.getItem(key));",
  "if(nav&&(nav.type==='reload'||nav.type==='back_forward')&&y>0)w.scrollTo(0,y);",
  "w.addEventListener('pagehide',function(){",
  "try{w.sessionStorage.setItem(key,String(w.scrollY))}catch(e){}})",
  "}catch(e){}})()",
].join("")
