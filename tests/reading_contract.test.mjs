import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
test('reading classifies template metadata before expansion and preserves real prose and artifacts',async()=>{
 await fs.mkdir(path.join(root,'_tmp'),{recursive:true});
 const dir=await fs.mkdtemp(path.join(root,'_tmp/reading-contract-'));
 const source=String.raw`\documentclass{article}
\newcommand{\shorttitle}[1]{\cs_gset:Nn \__short_title: {#1}}
\newcommand{\meaning}[1]{\emph{#1}}
\newcommand{\loadtable}[1]{\IfFileExists{table_#1.tex}{\input{table_#1}}{Missing}}
\title{A real manuscript title}
\begin{document}
\shorttitle{Only a running header}
\shortauthors{Only running authors}

\runningtitle{Another header}
\markright{Page header}

\begin{abstract}
Real evidence has accuracy 96.1\% and \meaning{useful meaning}.
\end{abstract}

\begin{keywords}
First keyword \sep Second keyword
\end{keywords}

\section{Results}
The ratio is $\frac{a}{b}$ and \textbackslash{} is a literal symbol.

\loadtable{data}

\loadtable{missing}
\input{chapter}
\end{document}`;
 await fs.writeFile(path.join(dir,'main.tex'),source);
 await fs.mkdir(path.join(dir,'build'));
 await fs.writeFile(path.join(dir,'chapter.tex'),String.raw`\section{Separate section}\loadtable{data}`);
 await fs.writeFile(path.join(dir,'table_data.tex'),String.raw`\begin{table}\caption{Actual evidence}\label{tab:data}\begin{tabular}{lc}Class & Count \\ Poor & 27 \\\end{tabular}\end{table}`);
 await fs.writeFile(path.join(dir,'.paper-pal.json'),JSON.stringify({title:'Reading test',sourceRoot:'.',defaultDocument:'main.tex',pdf:'main.pdf',latex:{enabled:false,cwd:'build',command:'make',args:['-f','../Makefile','all']},agent:{enabled:false}}));
 const child=spawn(process.execPath,[path.join(root,'backend-launch.mjs'),'--repo',dir,'--port','0'],{env:{...process.env,PAPER_PAL_ENV_FILE:'none'},stdio:['ignore','pipe','pipe']});
 try{
  let output='';const base=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Reading startup timeout')),15000);const data=chunk=>{output+=chunk;const match=output.match(/running at (http:\/\/[^\s]+)/);if(match){clearTimeout(timer);resolve(match[1]);}};child.stdout.on('data',data);child.stderr.on('data',data);child.once('exit',()=>{clearTimeout(timer);reject(new Error('Reading backend stopped'));});});
  const response=await fetch(base+'/api/document?path=main.tex');assert.equal(response.status,200);const document=await response.json();
  const visible=document.blocks.filter(b=>!b.hidden&&b.display?.trim());
  assert.ok(!visible.some(b=>/cs_gset|__short|Only a running|Only running authors|Another header|Page header/.test(b.display)),'template instructions must not be prose');
  assert.equal(document.frontMatter.title.text,'A real manuscript title');
  assert.ok(visible.some(b=>b.display.includes('96.1%')&&b.display.includes('useful meaning')));
  assert.ok(visible.some(b=>b.display.includes('First keyword')&&b.display.includes('Second keyword')&&!b.display.includes('\\sep')));
  assert.ok(visible.some(b=>b.annotations?.some(a=>a.type==='math'&&a.latex.includes('frac'))),'math is preserved, not stripped as code');
  const table=visible.find(b=>b.semantic?.caption==='Actual evidence');assert.equal(table.kind,'table');assert.ok(table.semantic.rows.some(row=>row.includes('27')));
  const fallback=visible.find(b=>b.raw.includes('loadtable{missing}'));assert.equal(fallback.kind,'table');assert.equal(fallback.semantic.fallback,true);assert.ok(!fallback.display.includes('table_missing'));
  const chapter=await(await fetch(base+'/api/document?path=chapter.tex')).json();
  assert.ok(chapter.blocks.some(b=>b.kind==='table'&&b.semantic?.caption==='Actual evidence'),'make builds still discover main-file include macros in separate sections');
  for(const b of document.blocks){assert.equal(source.slice(b.start,b.end),b.raw);assert.equal(b.displayStarts.length,b.display.length);assert.equal(b.displayEnds.length,b.display.length);}
  assert.equal(await fs.readFile(path.join(dir,'main.tex'),'utf8'),source);
 }finally{if(child.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}await fs.rm(dir,{recursive:true,force:true});}
});
