let root: HTMLElement = document.body;

export function getRootElement(): HTMLElement {
  return root;
}

export function setRootElement(el: HTMLElement): void {
  root = el;
}
