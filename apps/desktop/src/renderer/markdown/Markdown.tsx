import { memo, useEffect, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { highlight } from "./highlight";

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let live = true;
    if (lang) void highlight(code, lang).then((h) => live && setHtml(h));
    return () => {
      live = false;
    };
  }, [code, lang]);
  return (
    <div className="group relative my-2 overflow-hidden rounded-control border border-line bg-bg-1">
      <div className="flex h-6 items-center justify-between border-b border-line px-2.5 font-mono text-[10.5px] text-text-3">
        <span>{lang || "text"}</span>
        <button
          aria-label="Copy code"
          className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          onClick={() => {
            void navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      </div>
      {html ? (
        // Shiki escapes the code it renders; this HTML only ever comes from our own worker.
        <div className="shiki-wrap overflow-x-auto p-2.5 font-mono text-[12px] leading-[1.55]" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="overflow-x-auto p-2.5 font-mono text-[12px] leading-[1.55] text-text-1">{code}</pre>
      )}
    </div>
  );
}

const components: Components = {
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const text = String(children as ReactNode).replace(/\n$/, "");
    const lang = /language-([\w-]+)/.exec(className ?? "")?.[1];
    if (lang || text.includes("\n")) return <CodeBlock code={text} lang={lang ?? ""} />;
    return <code className="rounded-control bg-surface-2 px-1 py-px font-mono text-[0.88em] text-text-1">{children}</code>;
  },
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
    >
      {children}
    </a>
  ),
  p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-1.5 list-disc space-y-0.5 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-1.5 list-decimal space-y-0.5 pl-5">{children}</ol>,
  h1: ({ children }) => <h3 className="mt-3 mb-1 text-[15px] font-semibold">{children}</h3>,
  h2: ({ children }) => <h3 className="mt-3 mb-1 text-[14.5px] font-semibold">{children}</h3>,
  h3: ({ children }) => <h4 className="mt-2.5 mb-1 text-[14px] font-semibold">{children}</h4>,
  blockquote: ({ children }) => <blockquote className="my-1.5 border-l-2 border-line-strong pl-3 text-text-2">{children}</blockquote>,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-[12.5px]">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border border-line bg-surface-2 px-2 py-1 text-left font-semibold">{children}</th>,
  td: ({ children }) => <td className="border border-line px-2 py-1 align-top">{children}</td>,
  hr: () => <hr className="my-3 border-line" />,
};

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {text}
    </ReactMarkdown>
  );
});
