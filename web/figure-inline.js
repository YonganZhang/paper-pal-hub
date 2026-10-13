// Registered assets resolve custom LaTeX figure macros without rewriting manuscript source.
(() => {
  const editor=document.querySelector('#editor');
  if(!editor)return;
  const prefix=location.pathname.replace(/\/$/,'');
  let epoch=0;
  async function render(){
    const current=++epoch;
    try{
      const response=await fetch(prefix+'/hub/figures');
      if(!response.ok)return;
      const data=await response.json();
      if(current!==epoch)return;
      let changed=false;
      for(const block of editor.querySelectorAll('.kind-figure')){
        const raw=block.reviewBlock?.raw || '';
        const figure=data.figures.find(f=>raw.includes('{'+f.path.split('/').at(-1)+'}')||raw.includes('{'+f.path+'}'));
        if(!figure?.sha256 || (block.dataset.hubFigureHash===figure.sha256 && block.querySelector(':scope > [data-hub-figure-preview]')))continue;
        const link=document.createElement('a');link.className='latex-figure-link';
        link.href=figure.asset_url;link.target='_blank';link.rel='noopener';link.title='打开原始图文件';
        const image=document.createElement('img');image.className='latex-figure-image';image.loading='lazy';
        image.alt=figure.title;image.src=figure.preview_url+'&revision='+figure.sha256;
        const fallbackCopy=block.querySelector(':scope > .compiled-fallback > div');
        if(fallbackCopy)fallbackCopy.hidden=false;
        image.addEventListener('load',()=>{
          if(!link.isConnected)return;
          if(fallbackCopy)fallbackCopy.hidden=true;
          window.dispatchEvent(new CustomEvent('paper-hub:figures-rendered'));
        },{once:true});
        image.addEventListener('error',()=>{
          if(!link.isConnected)return;
          if(fallbackCopy)fallbackCopy.hidden=false;
          image.hidden=true;link.append(document.createTextNode('预览暂不可用，点击打开原图 ↗'));
        },{once:true});
        link.append(image);
        block.querySelector(':scope > [data-hub-figure-preview]')?.remove();
        link.dataset.hubFigurePreview='1';
        block.querySelector(':scope > figcaption')?.before(link);
        block.dataset.hubFigureHash=figure.sha256;
        changed=true;
      }
      if(changed)window.dispatchEvent(new CustomEvent('paper-hub:figures-rendered'));
    }catch{/* PDF fallback and the figure gallery remain available. */}
  }
  window.addEventListener('paper-hub:document',render);
  window.addEventListener('paper-hub:figure-accepted',render);
  if(editor.children.length)void render();
})();
