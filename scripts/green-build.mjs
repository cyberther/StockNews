import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
export function greenBuild(output){
 const htmlPath=join(output,'templates/stock-news-web/StockNewsWeb.dc.html');let html=readFileSync(htmlPath,'utf8');
 const match=/<x-dc(?:\s[^>]*)?>([\s\S]*)<\/x-dc>/.exec(html);if(!match)throw Error('Missing production template');
 // Inert JSON preserves the raw template exactly, avoiding a second HTML download and native prefetch of unresolved bindings.
 const template=match[1].replace(/<script src="\.\.\/shared\/hif-(?:policy|scenario|impact|impact-client)\.js"><\/script>/g,'');
 const raw=JSON.stringify(template).replace(/</g,'\\u003c');
 html=html.replace(match[0],'<x-dc></x-dc><script type="application/json" id="dc-published-template">'+raw+'</script>');writeFileSync(htmlPath,html);
 const supportPath=join(output,'templates/stock-news-web/support.js');let support=readFileSync(supportPath,'utf8');
 const anchor='template: dc.innerHTML,';if(!support.includes(anchor))throw Error('Runtime parser changed; review production transform');
 support=support.replace(anchor,'template: doc.getElementById("dc-published-template") ? JSON.parse(doc.getElementById("dc-published-template").textContent) : dc.innerHTML,');
 support=support.replace('if (!window.__resources) {','if (!window.__resources && !doc.getElementById("dc-published-template")) {');writeFileSync(supportPath,support);
 const dataPath=join(output,'templates/shared/hif-data.js');let data=readFileSync(dataPath,'utf8');
 for(const [key,next,empty] of [['NEWS','FOLLOWS','[]'],['FOLLOWS','UNIVERSE','{}'],['EVENTS','SIGNALS','{}'],['SIGNALS','UI','{}'],['CROWD','ALL_ACCESS','{}']]){
  const start=data.indexOf('const '+key+' = '),end=data.indexOf('const '+next+' = ',start);if(start<0||end<0)throw Error('Demo structure changed: '+key);
  data=data.slice(0,start)+'const '+key+' = '+empty+';\n'+data.slice(end);
 }
 // Hosted Pages has no optional local admin content endpoint. Original source preserves it for local/design use.
 data=data.replace("if (typeof fetch === 'function' && /^https?:$/.test(location.protocol)) {","if (window.HIF_CONTENT_ENDPOINT && typeof fetch === 'function' && /^https?:$/.test(location.protocol)) {");
 writeFileSync(dataPath,data);
 const sha=createHash('sha256').update(html).digest('hex');
 const headersPath=join(output,'_headers');writeFileSync(headersPath,readFileSync(headersPath,'utf8')+'\n/\n  X-MP-Consumer-Sha256: '+sha+'\n/templates/stock-news-web/StockNewsWeb.dc\n  X-MP-Consumer-Sha256: '+sha+'\n/templates/stock-news-web/StockNewsWeb.dc.html\n  X-MP-Consumer-Sha256: '+sha+'\n');
 return sha;
}
