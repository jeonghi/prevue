// Bounds and pointer coordinates in the wire protocol are physical image pixels.
export function inspectDocument() {
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
      accessibilityRole: element.getAttribute('role') || undefined,
      accessibilityLabel: element.getAttribute('aria-label') || undefined,
      source: null, children,
    }];
  }
  return {
    width: Math.round(innerWidth * ratio), height: Math.round(innerHeight * ratio),
    nodes: Array.from(document.body.children).flatMap((child, i) => visit(child, String(i))),
  };
}
