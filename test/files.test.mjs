// Files (ADR-17): the ZIP reader and the text of Word, Excel and
// PowerPoint files; what a file becomes; how each provider gets it (in a
// message and in a tool result); read_file on a PDF; attached files in
// the chat, saved without their data and sent again on edit.
import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { api, settings, callbacks, transport, response, text, call, vaultApp, chatSetup } from './harness.mjs';

beforeEach(() => {
  api.clearOpenAIState();
  api.resetStreamTransport();
  globalThis.__notices = [];
  api.setChatGPTOAuthService({ getUsableCredential: async () => ({ accessToken: 'fake-token', accountId: 'fake-account' }) });
});

/** A ZIP archive (entries deflated unless `stored`), as Office writes them. */
function zip(entries, { stored = [] } = {}) {
  const parts = [];
  const directory = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const raw = Buffer.from(content);
    const store = stored.includes(name);
    const data = store ? raw : deflateRawSync(raw);
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(store ? 0 : 8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    parts.push(local, nameBytes, data);
    directory.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const dir = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  const all = Buffer.concat([...parts, dir, end]);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.length);
}

const W = body => `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${body}</w:body></w:document>`;
const para = (text, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const DOCX = zip({
  '[Content_Types].xml': '<Types/>',
  'word/document.xml': W([
    para('Project &amp; plan', 'Heading1'),
    para('Ziele', 'berschrift2'),
    '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>First point</w:t></w:r></w:p>',
    '<w:p><w:r><w:t>Cost</w:t></w:r><w:r><w:tab/><w:t>12 &lt; 20</w:t></w:r></w:p>',
    '<w:p/>',
    '<w:tbl><w:tr><w:tc>' + para('Name') + '</w:tc><w:tc>' + para('Role') + '</w:tc></w:tr><w:tr><w:tc>' + para('Ana') + '</w:tc><w:tc>' + para('Lead|PM') + '</w:tc></w:tr></w:tbl>',
  ].join('')),
}, { stored: ['[Content_Types].xml'] });

const XLSX = zip({
  'xl/workbook.xml': '<workbook><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/><sheet name="Notes &amp; more" sheetId="2" r:id="rId2"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
  'xl/sharedStrings.xml': '<sst><si><t>Item</t></si><si><r><t>Cost</t></r><r><t xml:space="preserve"> (EUR)</t></r></si><si><t>Tiles, grey</t></si></sst>',
  'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>12.5</v></c></row><row r="3"><c r="A3" s="1"/></row></sheetData></worksheet>',
  'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row r="1"><c r="B1" t="inlineStr"><is><t>Say "hi"</t></is></c><c r="C1" t="b"><v>1</v></c></row></sheetData></worksheet>',
});

const PPTX = zip({
  'ppt/slides/slide10.xml': '<p:sld><a:p><a:r><a:t>Last</a:t></a:r></a:p></p:sld>',
  'ppt/slides/slide2.xml': '<p:sld><a:p><a:r><a:t>Second</a:t></a:r><a:r><a:t> slide</a:t></a:r></a:p><a:p><a:r><a:t>Point</a:t></a:r></a:p></p:sld>',
  'ppt/slides/slide1.xml': '<p:sld><a:p><a:r><a:t>Title</a:t></a:r></a:p></p:sld>',
});

const PDF = new TextEncoder().encode('%PDF-1.7 fake').buffer;
const b64 = buffer => Buffer.from(buffer).toString('base64');

test('Word: headings (also German styles), lists, tabs, entities, tables as Markdown', async () => {
  const file = await api.files.fileAttachment('Plan.docx', DOCX);
  assert.equal(file.mediaType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(file.data, b64(DOCX));
  assert.equal(file.text, [
    '# Project & plan',
    '## Ziele',
    '- First point',
    'Cost\t12 < 20',
    '| Name | Role |\n| --- | --- |\n| Ana | Lead\\|PM |',
  ].join('\n\n'));
});

test('Excel: each sheet as CSV with shared, rich and inline strings, numbers, booleans and gaps', async () => {
  const file = await api.files.fileAttachment('Budget.xlsx', XLSX);
  assert.equal(file.text, '## Sheet: Budget\nItem,Cost (EUR)\n"Tiles, grey",,12.5\n\n## Sheet: Notes & more\n,"Say ""hi""",TRUE');
});

test('PowerPoint: slides in their order (2 before 10)', async () => {
  const file = await api.files.fileAttachment('Talk.pptx', PPTX);
  assert.equal(file.text, '## Slide 1\nTitle\n\n## Slide 2\nSecond slide\nPoint\n\n## Slide 10\nLast');
});

test('What a file becomes: PDF as data, text files as text, damaged Office files without text; binaries and large files refused', async () => {
  const pdf = await api.files.fileAttachment('Scan.pdf', PDF);
  assert.deepEqual({ ...pdf, id: '' }, { id: '', fileName: 'Scan.pdf', mediaType: 'application/pdf', data: b64(PDF), sizeBytes: PDF.byteLength });

  const csv = await api.files.fileAttachment('data.csv', new TextEncoder().encode('a,b\n1,2').buffer);
  assert.deepEqual([csv.mediaType, csv.data, csv.text], ['text/plain', '', 'a,b\n1,2']);
  const code = await api.files.fileAttachment('Dockerfile', new TextEncoder().encode('FROM node').buffer);
  assert.equal(code.text, 'FROM node');

  const broken = await api.files.fileAttachment('Broken.docx', new TextEncoder().encode('not a zip').buffer);
  assert.equal(broken.text, undefined);
  assert.ok(broken.data);

  assert.match(await api.files.fileAttachment('song.mp3', new Uint8Array([0, 1, 2, 0]).buffer), /only PDF, Word, Excel, PowerPoint and text files/);
  assert.match(await api.files.fileAttachment('Big.pdf', new ArrayBuffer(api.files.MAX_FILE_BYTES + 1)), /files can be up to 10 MB/);
});

/** The last user message of a provider's request, as sent. */
async function sentWith(provider, files) {
  const requests = transport(() => response(provider, [text('ok')]));
  const { app } = vaultApp();
  await new api.AgentLoop(app, settings(provider)).run('Summarise', callbacks(), null, [], undefined, { files });
  return requests[0];
}

test('Anthropic: a PDF as a document, Office and text files as text documents, a legacy file named only', async () => {
  const files = await Promise.all([
    api.files.fileAttachment('Scan.pdf', PDF),
    api.files.fileAttachment('Plan.docx', DOCX),
    api.files.fileAttachment('data.csv', new TextEncoder().encode('a,b').buffer),
    api.files.fileAttachment('Old.doc', new Uint8Array([0xd0, 0xcf, 0, 1]).buffer),
  ]);
  const body = await sentWith('anthropic', files);
  const content = body.messages.at(-1).content;
  assert.deepEqual(content[0], { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64(PDF) }, title: 'Scan.pdf' });
  assert.equal(content[1].type, 'document');
  assert.deepEqual(content[1].source.type, 'text');
  assert.match(content[1].source.data, /^# Project & plan/);
  assert.deepEqual(content[2], { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'a,b' }, title: 'data.csv' });
  assert.match(content[3].text, /Old\.doc: Claude can't read this file type/);
  assert.match(content.at(-1).text, /Summarise$/);
});

for (const provider of ['openai', 'chatgpt-oauth']) {
  test(`${provider}: PDF and Office files as input_file with their data, text files as text`, async () => {
    const files = await Promise.all([
      api.files.fileAttachment('Scan.pdf', PDF),
      api.files.fileAttachment('Plan.docx', DOCX),
      api.files.fileAttachment('data.csv', new TextEncoder().encode('a,b').buffer),
    ]);
    const body = await sentWith(provider, files);
    const content = body.input.at(-1).content;
    assert.deepEqual(content[0], { type: 'input_file', filename: 'Scan.pdf', file_data: `data:application/pdf;base64,${b64(PDF)}` });
    assert.equal(content[1].type, 'input_file');
    assert.match(content[1].file_data, /^data:application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document;base64,/);
    assert.deepEqual(content[2], { type: 'input_text', text: '<file name="data.csv">\na,b\n</file>' });
  });
}

/** A vault with a PDF, for read_file. */
function pdfVault() {
  const setup = vaultApp();
  setup.app.vault.getFileByPath = path => setup.files.has(path) || path === 'Docs/Scan.pdf' ? Object.assign(new api.TFile(path), { name: path.split('/').pop() }) : null;
  setup.app.vault.readBinary = async () => PDF;
  return setup;
}

for (const provider of ['anthropic', 'openai']) {
  test(`${provider}: read_file on a PDF sends it in the tool result; older ones are left out later`, async () => {
    const { app } = pdfVault();
    const requests = transport((body, index) => index === 0
      ? response(provider, [call('r1', 'read_file', { path: 'Docs/Scan.pdf' })], 'tool_use')
      : response(provider, [text(`A${index}`)], 'end_turn', index));
    const agent = new api.AgentLoop(app, settings(provider));
    const cb = callbacks({ onToolResult: (name, result) => { cb.shown = result.result; } });
    await agent.run('Read the scan', cb);
    assert.match(cb.shown, /Docs\/Scan\.pdf \(.*\) is attached\.\n\n\[1 file sent to the model\]/);
    if (provider === 'anthropic') {
      const result = requests[1].messages.at(-1).content[0];
      assert.equal(result.content[1].type, 'document');
      assert.equal(result.content[1].source.data, b64(PDF));
    } else {
      const output = requests[1].input.find(item => item.type === 'function_call_output').output;
      assert.equal(output[1].type, 'input_file');
    }
    // Turns later, the file isn't sent again (the AI can read it again);
    // OpenAI chains to its stored response instead of sending the history.
    for (const question of ['Q2', 'Q3', 'Q4']) await agent.run(question, callbacks());
    const last = JSON.stringify(requests.at(-1));
    assert.doesNotMatch(last, new RegExp(b64(PDF).slice(0, 12)));
    if (provider === 'anthropic') assert.match(last, /file from read_file omitted to save context/);
  });
}

test('Attached files in the chat: saved without data and text, back from the API history, sent again on edit', async () => {
  const { plugin, view, chat, writes } = await chatSetup('anthropic');
  const requests = transport(() => response('anthropic', [text('ok')]));
  const pdf = await api.files.fileAttachment('Scan.pdf', PDF);
  const csv = await api.files.fileAttachment('data.csv', new TextEncoder().encode('a,b').buffer);
  await view.handleUserMessage('Look', null, [], 'turn-a', undefined, [], [pdf, csv]);
  assert.deepEqual(chat.shown[0].files.map(f => f.fileName), ['Scan.pdf', 'data.csv']);
  assert.deepEqual(plugin.chatHistory[0].attachedFiles.map(f => f.fileName), ['Scan.pdf', 'data.csv']);

  await new Promise(resolve => setTimeout(resolve, 0));
  const saved = writes.at(-1).conversations[0];
  assert.deepEqual(saved.chatHistory[0].attachedFiles.map(({ data, text: t }) => [data, t]), [['', undefined], ['', undefined]]);
  const restored = await chatSetup('anthropic', writes.at(-1));
  assert.equal(restored.plugin.chatHistory[0].attachedFiles[0].data, b64(PDF));
  assert.equal(restored.plugin.chatHistory[0].attachedFiles[1].text, 'a,b');

  await view.editMessage('turn-a', 'Look again');
  const content = requests.at(-1).messages.at(-1).content;
  assert.deepEqual(content.slice(0, 2).map(b => b.type), ['document', 'document']);
});
