import assert from 'node:assert/strict';
import { md, plainText, reportHTML } from '../web/utils.js';

const rich = md([
  '# Report',
  '',
  'A **bold** and *italic* paragraph.',
  '',
  '- first',
  '- second',
  '',
  '1. one',
  '2. two',
  '',
  '| name | value |',
  '| :--- | ---: |',
  '| alpha | 2 |',
  '',
  '```html',
  '<span>literal</span>',
  '```',
].join('\n'));

assert.match(rich, /<h1 class="h">Report<\/h1>/);
assert.match(rich, /<p>A <b>bold<\/b> and <i>italic<\/i> paragraph\.<\/p>/);
assert.match(rich, /<ul><li>first<\/li><li>second<\/li><\/ul>/);
assert.match(rich, /<ol><li>one<\/li><li>two<\/li><\/ol>/);
assert.match(rich, /<div class="md-table"><table>[\s\S]*<th style="text-align:left">name<\/th>/);
assert.match(rich, /<pre><code>&lt;span&gt;literal&lt;\/span&gt;<\/code><\/pre>/);

const links = md('[http](https://example.com/a?x=1&y=2) [mail](mailto:dev@example.com) <https://example.com/>');
assert.match(links, /<a href="https:\/\/example\.com\/a\?x=1&amp;y=2">http<\/a>/);
assert.match(links, /<a href="mailto:dev@example\.com">mail<\/a>/);
assert.match(links, /<a href="https:\/\/example\.com\/">https:\/\/example\.com\/<\/a>/);

const hostile = md('<script>alert(1)</script> ![pixel](https://example.com/x.png) [bad](javascript:alert(1)) [data](data:text/html,evil)');
assert.match(hostile, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
assert.doesNotMatch(hostile, /<script|<img|href="(?:javascript|data):/i);
assert.match(hostile, /!\[pixel\]\(https:\/\/example\.com\/x\.png\)/);

const note = md('- [ ] open\n- [x] closed');
assert.match(note, /class="chk" data-line="0"/);
assert.match(note, /class="chk" data-line="1"/);
const readonly = md('- [ ] open\n- [x] closed', { readonly: true });
assert.doesNotMatch(readonly, /class="chk"|data-line=/);
assert.match(readonly, /☐ open/);
assert.match(readonly, /☒ <span class="done">closed<\/span>/);

assert.equal(plainText('# **Title**\n\n- [ ] item\n\n[link](https://example.com)'), 'Title\n\n☐ item\n\nlink');
assert.equal(plainText('<https://example.com>'), 'https://example.com');
assert.equal(reportHTML('<unsafe>\nnext', 'plain'), '&lt;unsafe&gt;<br>next');
assert.doesNotMatch(reportHTML('- [ ] item', 'markdown'), /class="chk"|data-line=/);

console.log('PASS: Markdown escaping, links, blocks, tables, code, excerpts, and readonly checklists');
