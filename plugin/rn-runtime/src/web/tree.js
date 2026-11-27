function accessibilityRole(element) {
  const role = element.getAttribute('role');
  if (role) return role;
  if (element.matches('button,input[type=button],input[type=submit]')) return 'button';
  if (element.matches('textarea,input:not([type]),input[type=text],input[type=email],input[type=tel],input[type=url]')) return 'textbox';
  if (element.matches('input[type=checkbox]')) return 'checkbox';
  if (element.matches('a[href]')) return 'link';
  if (element.matches('img[alt]:not([alt=""])')) return 'img';
}

function accessibilityLabel(element) {
  const labels = (element.getAttribute('aria-labelledby') ?? '').trim().split(/\s+/)
    .map(id => id && document.getElementById(id)?.textContent?.trim()).filter(Boolean);
  return labels.join(' ') || element.getAttribute('aria-label') || element.getAttribute('alt') || undefined;
}

// Bounds and pointer coordinates in the wire protocol are physical image pixels.
export function inspectDocument(sourceAttribute) {
  const ratio = window.devicePixelRatio;
  function visit(element, id) {
    if (!(element instanceof Element) || ['SCRIPT', 'STYLE', 'LINK'].includes(element.tagName)) return [];
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return [];
    const children = Array.from(element.children).flatMap((child, i) => visit(child, id + '.' + i));
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return children;
    const text = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
      ? element.value
      : Array.from(element.childNodes).filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join('').trim();
    return [{
      id, name: element.localName,
      bounds: { x: rect.x * ratio, y: rect.y * ratio, width: rect.width * ratio, height: rect.height * ratio },
      text: text || undefined,
      testId: element.getAttribute('data-testid') || undefined,
      accessibilityRole: accessibilityRole(element),
      accessibilityLabel: accessibilityLabel(element),
      source: null, sourceToken: sourceAttribute ? element.getAttribute(sourceAttribute) || undefined : undefined, children,
    }];
  }
  return {
    width: Math.round(innerWidth * ratio), height: Math.round(innerHeight * ratio),
    nodes: Array.from(document.body.children).flatMap((child, i) => visit(child, String(i))),
  };
}
