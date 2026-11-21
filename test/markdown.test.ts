import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Lexer, walkTokens } from 'marked'
import { literalSource, markdownLabel, portableMarkdown } from '../src/markdown.js'
import { questionText, supportedInterview, type Question } from '../src/forms.js'

for (const [name, text] of Object.entries({
  prose: '**Review** _both_ options with `code` and a list.\n\n- First\n- Second',
  table: '| Check | Result |\n| --- | --- |\n| tests | pass |',
  link: '[Reference](https://example.invalid/reference)',
  autolink: '<https://example.invalid/reference>',
  inline: '`<img src="local"> ![example](local) password`',
  fence: '````ts\nconst password = "dummy-only";\n```\n<img src="local">\n````',
  tilde: '~~~text\n![example](local)\n~~~',
  escaped: '\\!\\[not an image\\]\\(local\\) &lt;img&gt;',
  indented: '    <img src="local">',
})) test(`portable Markdown retains ${name} without fetching or rendering it`, () => {
  assert.equal(portableMarkdown(text), true)
})

for (const [name, text] of Object.entries({
  image: '![photo](local.png)',
  referenceImage: '![photo][p]\n\n[p]: local.png',
  nestedImage: '> - ![photo](local.png)',
  html: '<details><summary>More</summary>Hidden context</details>',
  comment: '<!-- hidden context -->',
  mermaid: '```mermaid\ngraph LR; A-->B\n```',
  tildeMermaid: '~~~mermaid\ngraph LR; A-->B\n~~~',
  nestedMermaid: '> ~~~mermaid\n> graph LR; A-->B\n> ~~~',
  longMermaid: '```` Mermaid extra-info\ngraph LR; A-->B\n````',
  htmlPreview: '```html\n<p>Preview</p>\n```',
  svgPreview: '```xml\n<svg></svg>\n```',
  implicitPage: '```\n<!doctype html><html></html>\n```',
  openui: '```openui\nRoot()\n```',
  diff: '```diff\n-old\n+new\n```',
  localLink: '[File](./src/example.ts)',
  phoneLink: '[File](file:///phone/example.ts)',
  unsafeLink: '[Link](javascript:alert)',
  unclosed: '```ts\nconst demo = 1',
  mismatched: '````ts\nconst demo = 1\n```',
})) test(`nonportable Markdown ${name} stays phone-only`, () => {
  assert.equal(portableMarkdown(text), false)
})

test('literal source cannot break out through longer fences, HTML or diagrams', () => {
  const source = '```\n`````\n~~~mermaid\n<img src="local">\nconst password = "dummy-only";'
  const tokens = Lexer.lex(literalSource(source))
  assert.equal(tokens.length, 1)
  assert.equal(tokens[0]!.type, 'code')
  assert.equal((tokens[0] as { text: string }).text, source)
})

test('phone text metadata remains literal Markdown text, not media or formatting', () => {
  const label = '![literal](local) <img src="local"> **plain** `text` & entity'
  const tokens = Lexer.lex(markdownLabel(label))
  walkTokens(tokens, token => assert.ok(!['image', 'html', 'strong', 'codespan'].includes(token.type)))
})

const stored = (q: Question) => ({ questions: { questions: [q] }, draft: [], status: 'waiting', createdAt: 1 })
for (const lang of ['md', 'markdown', 'MD', 'ts', 'html', 'mermaid']) {
  for (const showSource of [undefined, true, false]) test(`content lang=${lang}, showSource=${showSource} matches phone source/Markdown mode`, () => {
    const source = '![diagram](local.png)\n<html>literal source</html>\n```'
    const q: Question = { id: 'review', type: 'text', question: 'Review this example.', content: { source, lang, ...(showSource === undefined ? {} : { showSource }) } }
    const rendered = (lang === 'md' || lang === 'markdown') && !showSource
    if (rendered) assert.throws(() => supportedInterview(stored(q), 1), /phone-only/)
    else {
      supportedInterview(stored(q), 1)
      const code = Lexer.lex(questionText(q)).filter(token => token.type === 'code')
      assert.equal(code.length, 1)
      assert.equal((code[0] as { text: string }).text, source)
    }
  })
}

test('all source metadata and option labels are retained literally, alongside portable Markdown', () => {
  const label = '![literal label](local)'
  const q: Question = { id: 'native/id', type: 'single', question: '**Compare** these options.', context: 'A portable context.', options: [label, {
    label: 'Second', recommended: true, conviction: 'slight', content: { source: '**Rendered** Markdown', lang: 'md' },
  }], recommended: label, conviction: 'strong', weight: 'minor', content: {
    title: '<b>Literal title</b>', file: 'example_[1].ts', lang: 'ts', source: 'const demo = 1',
  } }
  supportedInterview(stored(q), 1)
  const text = questionText(q)
  assert.ok(text.includes(markdownLabel(label)))
  assert.ok(text.includes(markdownLabel(q.content!.title!)))
  assert.ok(text.includes(`File: ${markdownLabel(q.content!.file!)}`))
  assert.match(text, /Language: ts/)
  assert.match(text, /\*\*Rendered\*\* Markdown/)
  assert.match(text, /recommended.*slight/)
  assert.match(text, /Weight: minor/)
  walkTokens(Lexer.lex(text), token => assert.ok(!['image', 'html'].includes(token.type)))
})

for (const layout of [{ lines: '2-4' }, { highlights: [2] }, { highlights: [] }]) test(`source layout ${JSON.stringify(layout)} is never silently flattened`, () => {
  const q: Question = { id: 'review', type: 'text', question: 'Review?', content: { source: 'example', ...layout } }
  assert.throws(() => supportedInterview(stored(q), 1), /phone-only/)
})
