// A narrow, hash-locked runtime patch. The installed upstream stays intact.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {homedir} from 'node:os';
import path from 'node:path';
const lock = JSON.parse(await readFile(new URL('./sources.lock.json', import.meta.url)));
const upstream=process.env.PAPER_PAL_DIR || path.join(homedir(),'.local/share/paper-pal');
export function adaptServer(source) {
  source='import {cleanupConsultationRuntime,cleanupAllConsultationRuntimes,trackConsultationChild,settleConsultationChild,renderConsultationAnswer} from '+JSON.stringify(new URL('./consultation-cli.mjs',import.meta.url).href)+';\n'+source;
  const replaceOnce = (from, to) => {
    if (source.split(from).length !== 2) throw new Error('Paper AI backend anchor changed: ' + from.slice(0, 80));
    source = source.replace(from, to);
  };
  // Class metadata must be classified before expansion: cas-dc shorttitle
  // otherwise expands into expl3 assignments and is mistaken for prose.
  replaceOnce('const MAX_MACRO_EXPANSIONS = 1500;',String.raw`
defineTextCommands("shorttitle shortauthors shortauthor runningtitle runningauthor runninghead markright fancyhead fancyfoot", { sig: "om" });
defineTextCommands("sep", { text: " · " });
const MAX_MACRO_EXPANSIONS = 1500;`);
  replaceOnce('  await visit(path.resolve(compileRoot, mainArgument), 0);',String.raw`
  const entry=path.resolve(compileRoot,mainArgument);
  if(existsSync(entry)&&insideSourceRoot(entry))await visit(entry,0);
  else await visit(resolveDocument(config.defaultDocument),0);`);
  // An input inside a macro definition is not a document include. Splitting
  // there truncated definitions, so section files lost their main-file macros.
  replaceOnce('function collectMacros(source) {','function collectMacros(source, definitionRanges = null) {');
  replaceOnce('    const value = body.value.trim();','    if(definitionRanges)definitionRanges.push([match.index,body.end]);\n    const value = body.value.trim();');
  replaceOnce('    const events = includeCommands(masked).map((item) => ({ index: item.index, targets: [path.extname(item.target) ? item.target : `${item.target}.tex`] }));',String.raw`
    const definitionRanges=[];collectMacros(source,definitionRanges);
    const isDefinition=index=>definitionRanges.some(([start,end])=>index>=start&&index<end);
    const events = includeCommands(masked).filter(item=>!isDefinition(item.index)).map((item) => ({ index: item.index, targets: [path.extname(item.target) ? item.target : `+'`${item.target}.tex`'+String.raw`] }));`);
  replaceOnce('      const extension = /documentclass/.test(match[0]) ? ".cls" : ".sty";',
    '      if(isDefinition(match.index))continue;\n      const extension = /documentclass/.test(match[0]) ? ".cls" : ".sty";');
  // Follow only standalone, one-argument include wrappers through the existing
  // source-root resolver. Never broaden the readable/editable source boundary.
  source=String.raw`
async function paperHubIncludedMacroArtifact(block,relativePath,macros,references) {
  if(block.kind!=="paragraph")return null;
  const call=/^\s*\\([A-Za-z@]+)\s*\{([^{}\r\n]+)\}\s*$/.exec(maskLatex(block.raw));
  if(!call)return null;
  const macro=macros.get(call[1]);
  if(macro?.params!==1||macro.optional!=null)return null;
  let body=maskLatex(macro.body||"").trim();
  const pureInclude=/^\\(?:input|include)\s*\{([^{}]+)\}\s*$/;
  if(body.startsWith("\\IfFileExists")){
    let at="\\IfFileExists".length;const args=[];
    for(let index=0;index<3;index++){
      while(/\s/.test(body[at]||"")&&at<body.length)at++;
      const group=braceGroupAt(body,at);if(!group)return null;
      args.push(group.value);at=group.end;
    }
    const included=pureInclude.exec(args[1].trim());
    const normalize=value=>value.trim().replace(/\.tex$/,"");
    if(body.slice(at).trim()||!included||normalize(args[0])!==normalize(included[1])||/\\(?:input|include)\b/.test(args[2]))return null;
    body=args[1].trim();
  }
  const include=pureInclude.exec(body);
  if(!include)return null;
  const target=include[1].replace(/#1/g,call[2]);
  if(/#[1-9]/.test(target))return null;
  const artifact=await resolveIncludedArtifact(relativePath,target,macros,references,{onlyArtifacts:true});
  if(artifact)return artifact;
  if(/(?:^|[/\\])(?:table|tabs?)[_/-]/i.test(target))
    return {artifactType:"table",fallback:true,caption:"See the table in the compiled PDF.",label:null,page:null};
  return null;
}
`+source;
  replaceOnce('    const rawSemantic = await semanticBlock(block, relativePath, macros, references);',
    '    const includedMacro = await paperHubIncludedMacroArtifact(block, relativePath, macros, references);\n'+
    '    if(includedMacro)block={...block,kind:includedMacro.artifactType};\n'+
    '    const rawSemantic = includedMacro || await semanticBlock(block, relativePath, macros, references);');
  // Float captions use the same trusted math/style renderer as table cells.
  const captionRenderAnchor='    const captionRendered = normalizeCaptionDisplay(renderTex(captionRaw, macros, references));';
  if(source.split(captionRenderAnchor).length!==3)throw new Error('Caption math anchor changed');
  source=source.replaceAll(captionRenderAnchor,'    const captionRendered = latexToDisplay(captionRaw, "paragraph", macros, references);');
  const captionAnchor='      captionDisplay: captionRendered.display,';
  if(source.split(captionAnchor).length!==3)throw new Error('Caption formatting anchor changed');
  source=source.replaceAll(captionAnchor,captionAnchor+'\n      captionFormatted: {text:captionRendered.display,annotations:captionRendered.annotations||[],styles:captionRendered.styles||[]},');
  replaceOnce('  return normalizeProvider(requested, defaultProvider);',
    '  const provider = normalizeProvider(requested, defaultProvider);\n  if (!["codex", "claude"].includes(provider)) throw new HttpError(400, "论文 AI 仅支持 Codex / Claude 订阅登录。");\n  return provider;');
  replaceOnce('    model = providerModel(provider, config, { chat: true });',
    '    model = resolveModel(provider, session.model);\n    if(provider === "claude" && /(^|-)haiku($|-)/i.test(model || "")) reasoningEffort = null;');
  replaceOnce('  const reasoningEffort = config.codex?.chatReasoningEffort || "medium";',
    '  let reasoningEffort = config.codex?.chatReasoningEffort || "medium";');
  replaceOnce('  session.provider = resolveProvider(body.provider);\n  session.messages.push(message);',
    '  session.provider = resolveProvider(body.provider);\n  session.model = resolveModel(session.provider, body.model);\n  message.model = session.model;\n  message.webConsultation = body.webConsultation === true;\n  session.messages.push(message);');
  const persist = '    request = await persistRewriteRequest(request, { autoProcess: body.autoProcess !== false });';
  // Restrict to the chat->proposal function; other request flows have their own model contract.
  const start = source.indexOf('async function createProposalFromChat(body) {');
  const end = source.indexOf('async function processRewriteRequest(body)', start);
  let segment = source.slice(start, end);
  if (segment.split(persist).length !== 3) throw new Error('Chat proposal anchors changed');
  segment = segment.replaceAll(persist,
    '    request.provider = resolveProvider(discussion.assistant.provider || session.provider);\n' +
    '    request.model = resolveModel(request.provider, discussion.assistant.model || session.model);\n' + persist);
  source = source.slice(0, start) + segment + source.slice(end);
  replaceOnce('      "You are the author\'s project chat inside a local manuscript-review app. The project is an academic manuscript written in LaTeX; it may belong to any field.",',
    '      "You are 论文 AI, the author\'s manuscript workspace. Reply in Chinese unless English manuscript prose is requested. Follow your current user-level instructions and the project AGENTS.md. Read current shared global rules from ~/.ai-shared/rules/ and shared skills from ~/.agents/skills/ as applicable. For paper work, first read .agents/skills/paper-ai/SKILL.md when present, then the writing guidance it routes to. Rules and skills are live files, not copied snapshots.",');
  const chatStart=source.indexOf('async function runChatTurn(');
  const chatEnd=source.indexOf('async function sendChatMessage(body)',chatStart);
  if(chatStart<0||chatEnd<0)throw new Error('Chat consultation scope changed');
  let chat=source.slice(chatStart,chatEnd);
  const historyAnchor='    const history = boundedChatHistory(session.messages);';
  const callAnchor='      reasoningEffort,\n      timeoutMs,\n    });';
  const cleanupAnchor='    await fs.rm(temporaryRoot, { recursive: true, force: true });';
  if(chat.split(callAnchor).length!==2||chat.split(cleanupAnchor).length!==2||chat.split(historyAnchor).length!==2)throw new Error('Chat consultation anchors changed');
  chat=chat.replace(historyAnchor,historyAnchor+'\n    const webConsultation=[...session.messages].reverse().find(message=>message.role==="user")?.webConsultation===true;');
  const modeAnchor='      "Conversation JSON follows. The final item is the latest user message. Reply only with the conversational answer, not JSON and not a tool trace.",';
  if(chat.split(modeAnchor).length!==2)throw new Error('Chat consultation prompt anchor changed');
  chat=chat.replace(modeAnchor,'      webConsultation ? "The user opted into browser ChatGPT consultation for this message; follow the runtime instructions for that capability." : "Browser ChatGPT consultation is not enabled for this message. If requested, ask the user to select 请 ChatGPT 网页咨询 beside the composer and click Send; do not attempt browser operations in this ordinary read-only mode.",\n'+modeAnchor);
  chat=chat.replace(callAnchor,'      reasoningEffort,\n      timeoutMs,\n      webConsultation,\n    });');
  const childAnchor='      onChild: (child) => {\n        const run = activeChatRuns.get(sessionId);';
  const captureAnchor='    await captureAgentOutput({ invocation, result, outputPath });';
  if(chat.split(childAnchor).length!==2||chat.split(captureAnchor).length!==2)throw new Error('Consultation child lifecycle anchor changed');
  chat=chat.replace(childAnchor,'      onChild: (child) => {\n        trackConsultationChild(outputPath,child);\n        const run = activeChatRuns.get(sessionId);');
  chat=chat.replace(captureAnchor,'    await settleConsultationChild(outputPath);\n'+captureAnchor);
  const answerAnchor='    const rawContent = (await fs.readFile(outputPath, "utf8")).trim();';
  if(chat.split(answerAnchor).length!==2)throw new Error('Consultation outcome anchor changed');
  chat=chat.replace(answerAnchor,'    let rawContent = (await fs.readFile(outputPath, "utf8")).trim();');
  const emptyAnchor='    if (!rawContent) throw new Error(`${providerLabel(provider)} chat returned an empty answer.`);';
  if(chat.split(emptyAnchor).length!==2)throw new Error('Consultation empty-answer anchor changed');
  chat=chat.replace(emptyAnchor,emptyAnchor+'\n    if(webConsultation)rawContent=await renderConsultationAnswer(outputPath,rawContent);');
  chat=chat.replace(cleanupAnchor,'    try { await cleanupConsultationRuntime(outputPath); } finally {\n'+cleanupAnchor+'\n    }');
  source=source.slice(0,chatStart)+chat+source.slice(chatEnd);
  replaceOnce('Promise.race([waitForChildren, new Promise((resolve) => setTimeout(resolve, 2500))]).then(() => process.exit(0));',
    'Promise.race([waitForChildren, new Promise((resolve) => setTimeout(resolve, 2500))]).then(async () => { await cleanupAllConsultationRuntimes(); process.exit(0); });');
  return source;
}
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (url === pathToFileURL(path.join(upstream,'server.mjs')).href) {
    const source = String(result.source);
    if (createHash('sha256').update(source).digest('hex') !== lock.backend.sha256)
      throw new Error('Paper Pal backend changed; review Paper AI adapter before upgrading');
    return { ...result, source: adaptServer(source) };
  }
  if (url === pathToFileURL(path.join(upstream,'agent-providers.mjs')).href) {
    let source=String(result.source);
    if(createHash('sha256').update(source).digest('hex')!==lock.providers.sha256) throw new Error('Paper Pal provider adapter changed');
    const marker='export async function buildAgentInvocation({';
    if(source.split(marker).length!==2)throw new Error('Provider invocation anchor changed');
    source=source.replace(marker,'async function upstreamAgentInvocation({');
    source='import {createConsultationInvocation} from '+JSON.stringify(new URL('./consultation-cli.mjs',import.meta.url).href)+';\n'+source;
    source+=`\nexport async function buildAgentInvocation(options) {
      if (!["codex","claude"].includes(options.provider)) throw new Error("仅支持 Codex / Claude 订阅登录。");
      if(options.provider==="claude" && /(^|-)haiku($|-)/i.test(options.model||"")) options={...options,reasoningEffort:null};
      const call=await upstreamAgentInvocation(options);
      if(options.webConsultation===true)return createConsultationInvocation(call,options);
      if(call.provider==="claude")call.args.push("--tools","Read,Glob,Grep","--strict-mcp-config");
      return {...call,command:process.execPath,args:[${JSON.stringify(fileURLToPath(new URL('./subscription-cli.mjs',import.meta.url)))},call.provider,call.command,...call.args]};
    }\n`;
    return {...result,source};
  }
  return result;
}
