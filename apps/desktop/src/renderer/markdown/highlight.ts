import HighlightWorker from "./highlight.worker?worker";

let worker: Worker | null = null;
let seq = 0;
const waiting = new Map<number, (html: string | null) => void>();
const cache = new Map<string, string | null>();

/** Highlighted HTML for a code block, or null for an unknown language. Results are cached. */
export function highlight(code: string, lang: string): Promise<string | null> {
  const key = `${lang}\0${code}`;
  if (cache.has(key)) return Promise.resolve(cache.get(key)!);
  if (!worker) {
    worker = new HighlightWorker();
    worker.onmessage = (e: MessageEvent<{ id: number; html: string | null }>) => {
      waiting.get(e.data.id)?.(e.data.html);
      waiting.delete(e.data.id);
    };
  }
  const id = ++seq;
  return new Promise((resolve) => {
    waiting.set(id, (html) => {
      if (cache.size > 500) cache.clear();
      cache.set(key, html);
      resolve(html);
    });
    worker!.postMessage({ id, code, lang });
  });
}
