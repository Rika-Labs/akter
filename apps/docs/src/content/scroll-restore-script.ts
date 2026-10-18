/**
 * Inline script that puts a reloaded or revisited page back at its scroll position while the
 * document is still being parsed. WebKit restores its own position only after every
 * script has loaded, so without this the first frames paint at the top and the page then
 * jumps. The script runs after the page content and before the render-blocking marker, so
 * the position is set before the first paint; where the browser restores on its own it
 * restores the same position. A plain visit never restores, so a stale value cannot move it.
 */
export const scrollRestoreScript = [
  "(function(){var w=window;",
  "var key=function(){return'akter:scroll:'+w.location.pathname};",
  "try{var nav=w.performance.getEntriesByType('navigation')[0];",
  "var y=Number(w.sessionStorage.getItem(key()));",
  "if(nav&&(nav.type==='reload'||nav.type==='back_forward')&&y>0)w.scrollTo(0,y)}catch(e){}",
  "var queued=false;",
  "w.addEventListener('scroll',function(){if(queued)return;queued=true;",
  "w.requestAnimationFrame(function(){queued=false;",
  "try{w.sessionStorage.setItem(key(),String(w.scrollY))}catch(e){}})},{passive:true})})()",
].join("")
