import { Lexer, walkTokens } from 'marked'

/** Escape phone text labels before interpolating them into a Markdown body. */
export function markdownLabel(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_[\]{}()#+.!|~-]/g, '\\$&')
}

export function literalSource(source: string): string {
  // Use a fence longer than any source fence so context cannot become active HTML/media.
  const length = [...source.matchAll(/`+/g)].reduce((max, match) => Math.max(max, match[0].length + 1), 3)
  const fence = '`'.repeat(length)
  return `${fence}\n${source}\n${fence}`
}

/** Inspect syntax only: no rendering, URL fetching or phone-local file resolution. */
export function portableMarkdown(text: string): boolean {
  let portable = true
  const tokens = Lexer.lex(text, { gfm: true })
  walkTokens(tokens, token => {
    if (token.type === 'html' || token.type === 'image') portable = false
    if (token.type === 'link' && !/^(https?:\/\/|mailto:)/i.test(token.href)) portable = false
    if (token.type !== 'code') return
    const language = (token.lang ?? '').trim().split(/\s+/)[0]!.toLowerCase()
    // These fences invoke phone renderers, not just syntax highlighting (build-508 web/ui.js).
    if (/^(mermaid|html|htm|xhtml|svg|openui|diff|patch)$/.test(language) ||
        ((!language || language === 'xml') && /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(token.text)) ||
        (!language && /^\s*(<!doctype html|<html[\s>])/i.test(token.text))) portable = false
    if (token.codeBlockStyle === 'indented') return
    // Unclosed fences would consume later question/context/confirmation blocks when joined.
    const lines = token.raw.trimEnd().split('\n')
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(lines[0] ?? '')?.[1]
    const closing = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines.at(-1) ?? '')?.[1]
    if (lines.length < 2 || !opening || !closing || closing[0] !== opening[0] || closing.length < opening.length) portable = false
  })
  return portable
}
