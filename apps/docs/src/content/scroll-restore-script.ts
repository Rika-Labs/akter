/**
 * Inline script for the end of the document body. The page itself scrolls, so the browser
 * restores a page it reaches by Back or Forward, whether it is a new document or a route Next
 * changed in place, and with scripts off it restores a reloaded page too. This script only
 * takes over a reload, where WebKit gets it wrong in two ways: it restores its own offset after
 * the page's scripts have loaded, from an entry it saved some time after the last scroll, so a
 * reload soon after a scroll is put back at a stale offset; and with a hash in the address it
 * scrolls to the heading the hash names after the script has run. The script saves the offset
 * under the current route's path when the page is left, and on a reload scrolls to it before the
 * first paint of an engine that waits for the whole document. It switches restoration to manual for
 * the reload so the engine's own cannot override it, puts the offset back for any scroll that
 * lands elsewhere until the reader scrolls or the page has been loaded for 400 ms, and then
 * gives restoration back to the browser, because an entry left manual would lose its place on
 * Back after the reader moves to another route. Any other visit, a link to an anchor included,
 * is left alone.
 */
export const scrollRestoreScript = [
  "(function(){var w=window,h=w.history;try{",
  "var key='akter:scroll:'+w.location.pathname;",
  "var nav=w.performance.getEntriesByType('navigation')[0];",
  "var y=Number(w.sessionStorage.getItem(key));",
  "w.addEventListener('pagehide',function(){",
  "try{w.sessionStorage.setItem('akter:scroll:'+w.location.pathname,String(w.scrollY))}catch(e){}});",
  "if(!nav||nav.type!=='reload'||!(y>0))return;",
  "h.scrollRestoration='manual';",
  "w.scrollTo(0,y);",
  "var keep=function(){if(w.scrollY!==y)w.scrollTo(0,y)};",
  "var inputs=['wheel','touchstart','keydown','mousedown'];",
  "var release=function(){",
  "w.removeEventListener('scroll',keep);",
  "for(var i=0;i<inputs.length;i++)w.removeEventListener(inputs[i],release);",
  "h.scrollRestoration='auto'};",
  "w.addEventListener('scroll',keep);",
  "for(var i=0;i<inputs.length;i++)w.addEventListener(inputs[i],release,{passive:true});",
  "w.addEventListener('load',function(){w.setTimeout(release,400)})",
  "}catch(e){}})()",
].join("")
