import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';

marked.setOptions({ gfm: true, breaks: true });

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

export function renderMarkdown(text) {
  return DOMPurify.sanitize(marked.parse(text || ''), { FORBID_TAGS: ['style', 'form', 'input'] });
}

export function enhanceCode(root) {
  for (const pre of root.querySelectorAll('pre')) {
    if (pre.querySelector('.copy-code')) continue;
    const b = document.createElement('button');
    b.className = 'copy-code';
    b.type = 'button';
    b.textContent = 'Copy';
    b.onclick = async () => {
      await navigator.clipboard.writeText(pre.querySelector('code')?.innerText || pre.innerText);
      b.textContent = 'Copied';
      setTimeout(() => (b.textContent = 'Copy'), 1200);
    };
    pre.appendChild(b);
  }
}
