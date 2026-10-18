/**
 * Inline script that owns scroll restoration for a loaded page. The page scrolls inside its
 * main panel, not the window. The script takes the position away from the browser
 * (`history.scrollRestoration = 'manual'`) and puts a reloaded or revisited page back at the
 * offset it saved, while the document is still being parsed. Two restorers disagree: WebKit
 * restores its own offset after the scripts have loaded, which on a quick reload overwrites
 * the saved one with zero, and then the saved value is overwritten too. A plain visit never
 * restores, so a stale value cannot move it. The offset is saved at most once per frame,
 * under the path it belongs to.
 */
export const scrollRestoreScript = [
  "(function(){var w=window;",
  "if('scrollRestoration' in w.history)w.history.scrollRestoration='manual';",
  "var main=w.document.getElementById('ak-main');if(!main)return;",
  "var key=function(){return'akter:scroll:'+w.location.pathname};",
  "try{var nav=w.performance.getEntriesByType('navigation')[0];",
  "var y=Number(w.sessionStorage.getItem(key()));",
  "if(nav&&(nav.type==='reload'||nav.type==='back_forward')&&y>0)main.scrollTop=y}catch(e){}",
  "var queued=false;",
  "main.addEventListener('scroll',function(){if(queued)return;queued=true;",
  "w.requestAnimationFrame(function(){queued=false;",
  "try{w.sessionStorage.setItem(key(),String(main.scrollTop))}catch(e){}})},{passive:true})})()",
].join("")
