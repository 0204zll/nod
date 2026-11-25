export const printSandbox = 'allow-scripts allow-modals';

export function printSource(content: string, nonce: string, head = '') {
  const policy = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; base-uri 'none'; form-action 'none'`;
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"><script nonce="${nonce}">addEventListener('afterprint',function(){parent.postMessage('nod:printed','*')});addEventListener('load',function(){setTimeout(function(){print()},100)})</script>${head}${content}`;
}

export function printDocument(content: string, head = '') {
  const frame = document.createElement('iframe');
  frame.title = 'Print';
  frame.setAttribute('sandbox', printSandbox);
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.style.cssText =
    'position:fixed;left:0;top:0;width:794px;height:1123px;border:0;opacity:0;pointer-events:none;color-scheme:light';
  const finish = () => {
    window.removeEventListener('message', printed);
    window.clearTimeout(timer);
    frame.remove();
  };
  const printed = (event: MessageEvent) => {
    if (event.source === frame.contentWindow && event.data === 'nod:printed') finish();
  };
  const timer = window.setTimeout(finish, 10 * 60 * 1000);
  window.addEventListener('message', printed);
  frame.srcdoc = printSource(content, crypto.randomUUID().replaceAll('-', ''), head);
  document.body.append(frame);
}

export const printReset =
  'html,body{background:#fff!important;min-height:0!important;height:auto!important;border:0!important;box-shadow:none!important;outline:0!important}body::before,body::after{display:none!important}';

export function appStyles() {
  return [...document.styleSheets]
    .map((sheet) => {
      try {
        return [...sheet.cssRules].map((rule) => rule.cssText).join('\n');
      } catch {
        return '';
      }
    })
    .join('\n')
    .replaceAll('</', '<\\/');
}

export async function inlineBlobs(html: string) {
  const urls = [...new Set(html.match(/blob:[^"')\s&<>]+/g) ?? [])];
  const inlined = await Promise.all(
    urls.map(async (url) => {
      const blob = await (await fetch(url)).blob();
      return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('A slide image could not be read.'));
        reader.readAsDataURL(blob);
      });
    }),
  );
  return urls.reduce((text, url, index) => text.replaceAll(url, inlined[index]), html);
}
