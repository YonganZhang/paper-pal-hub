/* Translate interface copy only. Manuscript, source diffs and chat prose remain intact. */
(() => {
  const words = {
    'Paper Pal':'论文共改', 'Review-first writing, locally':'阅读 · 讨论 · 修改',
    'Local LaTeX project':'论文工作区','Agent':'论文 AI','Model':'模型',
    'Undo':'撤销','Reload':'刷新','Saved':'已保存','Save':'保存','Saving…':'保存中…',
    'Compile':'编译','Preview':'PDF 预览','Connecting…':'连接中…','Connected':'已连接',
    'Disconnected':'连接已断开','Reconnecting…':'重新连接中…',
    'Theme':'外观','System':'跟随系统','Light':'浅色','Dark':'深色',
    'Paper review':'论文审阅','Opening outline…':'正在加载目录…','Sections':'章节',
    'Confirmed by you':'你已确认','Draft, not yet reviewed':'待审阅正文','Has a comment':'有批注',
    'Loading document…':'正在读取正文…','Text':'正文','Structure':'结构','Source reviewed':'审阅进度',
    'Review file':'审阅本章','Reviewing…':'正在审阅…','Confirm section':'确认本节','Unconfirm section':'取消本节确认',
    'References':'参考文献','References ·':'参考文献 ·','Find citation or label':'查找文献或标签',
    'Author, title, cite key…':'作者、标题、引用键…','The source changed outside this editor.':'源文件已在其他位置更新。',
    'Keep my edit':'保留我的修改','Use disk version':'读取最新版本',
    'Argument structure':'论证结构','Restructure the paper before rewriting prose':'先梳理论文结构，再修改正文',
    'Select one or more logical sections. Section boundaries follow the compiled paper, even when they cross LaTeX files.':'选择需要讨论的章节，章节划分以论文内容为准。',
    'Current':'当前','Current structure':'当前结构','Select main paper':'选择正文','Deselect main paper':'取消选择正文',
    'Proposed':'建议','Proposed structure':'建议结构','No proposal yet':'暂无修改建议',
    'The proposed tree will appear here; no LaTeX is changed.':'结构建议会显示在这里，确认前保留原稿。',
    'Ask about structure':'讨论结构','Ask in Chat':'与论文 AI 讨论','Open project chat':'打开论文 AI',
    'Project Chat':'论文 AI','Project chat':'论文 AI','Project agent':'论文 AI','Chat':'论文 AI','Comments':'批注','New comment':'新建批注',
    'Full manuscript + project':'当前论文与项目资料','Current document':'当前章节','Project context':'论文工作区',
    'Chats':'历史对话','Chat history':'历史对话','New chat':'新建对话','Untitled chat':'未命名对话',
    'Each chat keeps its own history and selected text.':'每个对话独立保存聊天记录与选中原文。',
    'Ask about the paper, code, or experiments.':'可以讨论论文、图表和实验。',
    'The agent can inspect the whole project. Inline comments remain the place for reviewable manuscript edits.':'论文 AI 可读取当前项目；选中原文讨论后，可生成修改候选供你确认。',
    'Codex can inspect the whole project. Inline comments remain the place for reviewable manuscript edits.':'论文 AI 可读取当前项目；选中原文讨论后，可生成修改候选供你确认。',
    'Message the agent about this project…':'告诉论文 AI 你想讨论或修改什么…',
    'Message Codex about this project…':'告诉论文 AI 你想讨论或修改什么…',
    'Message the agent':'与论文 AI 对话','Return to comments':'返回批注',
    'Ready':'就绪','Thinking…':'思考中…','Queued':'排队中','Running':'处理中','Stopped':'已停止',
    'Send':'发送','Stop':'停止生成','Cancel':'取消','Close':'关闭','Delete':'删除',
    'No saved chats yet.':'暂无历史对话。','Show more':'展开更多','Show less':'收起',
    'Generate reviewable edit':'生成修改候选','View in Comments':'查看修改候选',
    'Use this reply and its preceding discussion for the selected passage.':'按这轮讨论为选中原文生成修改候选。',
    'This reply is becoming a red/green proposal in Comments.':'正在生成修改候选，请到批注中查看。',
    'Nothing in your .tex files changes until you accept it.':'点击“接受修改”后才会写入论文。',
    'Accept':'接受修改','Accepted':'已接受','Reject':'拒绝修改','Rejected':'已拒绝',
    'Accept: keep the green text, drop the red':'接受绿色新文，替换红色旧文',
    'Reject: restore the red text, drop the green':'保留红色原文，拒绝绿色新文',
    'Comment':'批注','Confirm':'确认阅读','Confirmed':'已确认阅读','Unconfirm':'取消确认',
    'Follow up':'继续讨论','Generate proposal':'生成修改候选','Generate another version':'重新生成',
    'Continue chat':'继续对话','Take as comment':'转为批注','Discussion':'讨论','Rewrite':'改写',
    'Discard':'放弃','Discard group':'放弃本组','Dismiss':'关闭','Confirm all':'全部确认',
    'No comments here':'本章还没有批注','Review the draft one passage at a time:':'逐段阅读，随时留下想法：',
    'Ask a follow-up or choose an option…':'输入后续意见，或选择一项…',
    'Go to this passage in the manuscript':'回到正文对应段落','Delete comment and cancel its agent run':'删除批注并取消处理',
    'Comment deleted. Any active agent run was cancelled.':'批注已删除，相关处理已取消。',
    'Write a message first.':'请先输入内容。','Write a question first.':'请先输入问题。',
    'Write a follow-up question first.':'请先输入后续问题。','Write a follow-up instruction first.':'请先输入后续意见。',
    'Write a rewrite instruction first.':'请先说明修改要求。',
    'Reference':'参考资料','Paper preview':'论文预览','Compiled PDF':'论文 PDF','Compiled paper PDF':'编译后的论文 PDF',
    'Compiling…':'编译中…','Load PDF preview':'打开 PDF 预览','Open source figure PDF':'打开原始图 PDF',
    'Live output':'运行输出','Log':'运行日志','Git unavailable':'版本记录暂不可用',
    'Not a Git repository':'尚未建立版本库','Reloaded from disk.':'已读取最新源文件。',
    'Show source':'查看源码','Hide source':'收起源码','Source':'源码','Added':'新增','Removed':'删除',
    'Apply change set':'应用整组修改','Apply confirmed structure':'应用已确认结构',
    'Approve structure plan':'确认结构方案','Structure plan approved':'结构方案已确认',
    'Proposed outline':'建议目录','Showing proposed':'正在查看建议目录','Show proposed':'查看建议目录',
    'Current outline':'当前目录','View proposed tree':'查看建议结构',
    'Command-line agents':'本机智能体','API providers':'其他服务','Other':'其他',
    'Switch source file':'切换章节文件','Choose a LaTeX source':'选择论文章节',
    'Which model the agent uses':'选择论文 AI 模型','Which model this agent uses for comments':'论文 AI 使用的模型',
    'Which AI agent answers comments and project chat':'论文 AI 后端',
    'Nothing to undo':'暂无可撤销操作','Reload source from disk':'刷新正文',
    'Show or hide the compiled PDF':'打开或关闭论文 PDF','Rebuild the PDF with latexmk':'重新编译论文 PDF',
    'Save this file now. Edits also save automatically.':'保存当前修改，直接编辑也会自动保存。',
    'Document outline':'论文章节','Editable document':'论文正文','Writing workspace':'论文工作区',
    'Review actions':'审阅操作','Paper structure workspace':'论文结构工作区',
    'Select a scope and ask Codex.':'选择章节，与论文 AI 讨论。',
    'Comments and project chat':'批注与论文 AI','Close paper preview':'关闭 PDF 预览',
    'Review sidebar':'批注与论文 AI','Message Codex':'与论文 AI 对话',
    'Paragraph':'段落','Selection':'选中文字','Local':'局部','Smart':'智能','Project':'全项目',
    'Original':'原文','Proposal':'修改候选','Pending':'待处理','Discussed':'已讨论','Error':'处理失败',
    'medium reasoning':'中等推理','low reasoning':'轻量推理','high reasoning':'深入推理',
    'medium effort':'中等推理','low effort':'轻量推理','high effort':'深入推理',
    'Introduction':'引言','Data and methods':'数据与方法','Results':'结果','Discussion':'讨论','Conclusions':'结论','Supplementary material':'补充材料',
    'Discuss in Chat':'与论文 AI 讨论','Generate proposed tree':'生成结构建议',
    'Source changes':'源码变化','Review status':'审阅状态','No changes':'暂无修改',
    'Re-read this file from disk. Pending edits are saved first, so nothing you typed is lost.':'刷新前会保存已输入的修改，再读取最新源文件。',
    'Connecting to the local server':'正在连接论文服务','Connecting to the local Paper Pal server':'正在连接论文共改服务',
    'Resize document outline':'调整章节栏宽度','Resize review sidebar':'调整批注栏宽度',
    'Drag to resize · Double-click to reset':'拖动调整宽度，双击恢复','How to read the manuscript':'审阅标记说明',
    'Current source review progress':'当前章节审阅进度',
    'Ask the agent to read the whole open file and list what to change. Nothing is rewritten.':'请论文 AI 审阅当前章节并给出修改建议。',
    'Loading the paper structure…':'正在读取论文结构…','Discard approved plan':'放弃已确认方案',
    'Select a scope and ask the agent.':'选择章节，与论文 AI 讨论。','What feels structurally wrong?':'哪些结构需要调整？',
    'For example: Method and Experiments overlap; identify duplicated roles, missing transitions, and a better order.':'例如：方法与实验内容重复，请找出重复内容、缺失的过渡，并建议章节顺序。',
    'Choose at least one section.':'请至少选择一个章节。','Opening the LaTeX source…':'正在读取论文源文件…',
    'Expand the paper over the draft':'展开 PDF 阅读','Expand paper reader':'展开 PDF 阅读','Cited papers':'引用文献',
    'Rewrite comment':'修改批注','Close comment':'关闭批注','Comment or question':'修改要求或问题',
    'Say what should change, or ask a question…':'说明你希望如何修改，或输入问题…','Options':'选项',
    'Selected text · paper context':'选中文字 · 论文上下文','Change':'修改','Rewrite scope':'修改范围',
    'Selected text':'选中文字','Whole paragraph':'完整段落','Context':'上下文',
    'Context given to the agent':'提供给论文 AI 的上下文','Paper + code when needed':'按需读取论文与代码',
    'Current paragraph only':'仅当前段落','Full project review':'全项目审阅',
    'Send this selection and question to Project Chat':'将选中文字和问题发送给论文 AI',
    'Leave this comment, then place a linked comment at every other location it reaches. Nothing is rewritten.':'留下本条批注，并查找需要同步修改的位置。',
    'Find linked':'查找相关位置','File review findings':'章节审阅建议','File review':'章节审阅',
    'Close review':'关闭审阅建议','Opening the manuscript…':'正在打开论文…',
    'Comments in other files':'其他章节的批注','PDF ready':'PDF 已就绪','Checking Git…':'正在读取版本记录…',
    'Refresh Git status':'刷新版本记录','Refresh':'刷新','Compilation details':'编译详情','Selected text actions':'选中文字操作',
    'Paper context':'论文上下文','Your comment':'你的批注','Discuss':'讨论','Rewrite passage':'改写选中段落',
    'No active comments':'暂无待处理批注','All comments':'全部批注','Resolve':'标记已解决',
    'Awaiting approval':'待你确认','PDF updated':'PDF 已更新','PDF missing':'暂无 PDF',
    'Selected sections sent to one Structure Chat.':'已将所选章节放入论文 AI 草稿，请点击发送。',
    'Selection and question sent to Project Chat.':'已将选中原文和问题放入草稿，请点击发送。',
    'Working':'处理中','Needs attention':'需要处理','Interrupted':'已中断',
    'Figure rendered by LaTeX':'请在 PDF 中查看原图','Table rendered by LaTeX':'请在 PDF 中查看原表',
    'Complex macros are preserved in the compiled output.':'完整图表保留在编译后的 PDF 中。',
    'Open compiled PDF':'打开论文 PDF','Included file not found in the project':'未找到引用的文件',
  };
  const patterns = [
    [/^New comments and chat turns will use (.*)\.$/, '后续批注和聊天将使用 $1。'],
    [/^(\d+) characters selected\..*Whole paragraph.*$/, '已选中 $1 个字符。如需完整改写，可在“选项”中选择“完整段落”。'],
    [/^(\d+) selected$/, '$1 项已选择'],[/^(\d+) comments?$/, '$1 条批注'],
    [/^(\d+) sections?$/, '$1 个章节'],[/^(\d+) of (\d+) confirmed$/, '已确认 $1 / $2'],
    [/^You( · .*)?$/, '你$1'],[/^Codex( · .*)$/, '论文 AI$1'],
    [/^Theme: (system|light|dark)$/, (_,v) => '外观：'+({system:'跟随系统',light:'浅色',dark:'深色'}[v])],
    [/^References · (.*)$/, '参考文献 · $1'],
    [/^Waiting for (Codex|the agent).*$/, '正在等待论文 AI…'],
    [/^Asking (Codex|the agent).*$/, '论文 AI 正在处理…'],
    [/^Ask (Codex|the agent)$/, '询问论文 AI'],
    [/^Continue with (Codex|the agent)$/, '继续与论文 AI 讨论'],
    [/^Run (Codex|the agent)$/, '请论文 AI 处理'],
    [/^Send to (Codex|the agent)$/, '发送给论文 AI'],
    [/^(.*) · (medium|low|high) effort$/, (_,model,effort)=>`${model} · ${{medium:'中等',low:'轻量',high:'深入'}[effort]}推理`],
    [/^(\d+) · (Introduction|Data and methods|Results|Discussion|Conclusions)$/, (_,number,title)=>number+' · '+words[title]],
    [/^Editable paper paragraph (\d+)$/, '论文第 $1 段'],[/^Open comment (\d+)$/, '打开批注 $1'],
    [/^(\d+) · (\d+) unresolved$/, '$1 条批注 · $2 条待处理'],
    [/^(?:sections\/)?01_introduction\.tex$/, '引言'],[/^(?:sections\/)?02_data_methods\.tex$/, '数据与方法'],
    [/^(?:sections\/)?03_results\.tex$/, '结果'],[/^(?:sections\/)?04_discussion\.tex$/, '讨论'],
    [/^(?:sections\/)?05_conclusions\.tex$/, '结论'],[/^main\.tex$/, '论文主稿'],
    [/^metadata\.tex$/, '作者与题录'],[/^supplementary\.tex$/, '补充材料'],
    [/^Paragraph (\d+)$/, '第 $1 段'],[/^Git · (\d+) changed$/, '版本记录 · $1 处变动'],
    [/^(Ready|Queued|Working|Needs attention|Stopped|Interrupted) · (\d+) messages$/, (_,state,n)=>(words[state]||state)+' · '+n+' 条消息'],
    [/^Open page (\d+)$/, '查看 PDF 第 $1 页'],
  ];
  const skip = '#editor, .chat-message-content, .request-selected-text, .request-diff, .request-diff-line, .request-quote, .thread-assistant, .thread-user, .proposal-diff, .source-diff, .diff-view, pre, code, [contenteditable="true"], #hub-translation-view';
  const sourceControls='.structure-actions,.compiled-fallback';
  function translate(value) {
    const trimmed = value.trim();
    let result = words[trimmed];
    if (!result) for (const [pattern, replacement] of patterns) {
      if (pattern.test(trimmed)) { result = trimmed.replace(pattern, replacement); break; }
    }
    return result ? value.replace(trimmed, result) : value;
  }
  function localize(root) {
    if (root.nodeType === Node.TEXT_NODE) {
      if (!root.parentElement?.closest(skip) || root.parentElement.closest(sourceControls)) { const next = translate(root.nodeValue); if (next !== root.nodeValue) root.nodeValue = next; }
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE || root.matches('script,style')) return;
    for (const attr of ['title','aria-label','placeholder']) if (root.hasAttribute(attr)) {
      const before = root.getAttribute(attr), after = translate(before);
      if (after !== before) root.setAttribute(attr, after);
    }
    if (root.closest(skip) && !root.closest(sourceControls)) { for (const child of root.children) localize(child); return; }
    if (!root.matches('textarea,input')) for (const child of root.childNodes) localize(child);
  }
  document.documentElement.lang = 'zh-CN'; document.title = '论文共改';
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'childList') record.addedNodes.forEach(localize);
      else localize(record.target);
    }
  });
  localize(document.body);
  // Textarea/input placeholders are interface copy, but their values are always the author's.
  document.querySelectorAll('textarea,input').forEach(el => {
    for (const attr of ['placeholder','aria-label','title']) if(el.hasAttribute(attr)) el.setAttribute(attr, translate(el.getAttribute(attr)));
  });
  observer.observe(document.body, {subtree:true, childList:true, characterData:true, attributes:true, attributeFilter:['title','aria-label','placeholder']});
})();
