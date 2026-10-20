/**
 * Inline reload correction at the end of the body, where the document has its full height.
 * The browser owns history restoration throughout: a manual entry can be left by the browser's
 * Back control before a timer runs, and a later timer would change the new entry, not that one.
 * The script saves the current route's offset on pagehide and corrects only a reload with a
 * saved offset, zero included. WebKit can restore a stale native offset or scroll to a fragment
 * after this script, so competing scrolls are corrected until input, history traversal,
 * fragment navigation, pagehide or 400 ms after load. No callback changes a history entry's
 * restoration mode, and the correction cannot follow the reader into another history entry.
 * Ordinary visits, including links to anchors, are left alone; with scripts off the document
 * still scrolls and the browser restores it itself.
 */
export const scrollRestoreScript = [
  "(function(){var w=window;try{",
  "var key='akter:scroll:'+w.location.pathname;",
  "var nav=w.performance.getEntriesByType('navigation')[0];",
  "var saved=w.sessionStorage.getItem(key),y=Number(saved);",
  "w.addEventListener('pagehide',function(){",
  "try{w.sessionStorage.setItem('akter:scroll:'+w.location.pathname,String(w.scrollY))}catch(e){}});",
  "if(!nav||nav.type!=='reload'||saved===null||saved===''||!Number.isFinite(y)||y<0)return;",
  "w.scrollTo(0,y);",
  "var keep=function(){if(w.scrollY!==y)w.scrollTo(0,y)};",
  "var stops=['wheel','touchstart','keydown','mousedown','popstate','hashchange','pagehide'];",
  "var release=function(){",
  "w.removeEventListener('scroll',keep);",
  "for(var i=0;i<stops.length;i++)w.removeEventListener(stops[i],release)};",
  "w.addEventListener('scroll',keep);",
  "for(var i=0;i<stops.length;i++)w.addEventListener(stops[i],release,{passive:true});",
  "w.addEventListener('load',function(){w.setTimeout(release,400)})",
  "}catch(e){}})()",
].join("")
