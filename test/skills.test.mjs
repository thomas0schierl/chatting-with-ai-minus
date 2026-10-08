// Skills (ADR-20): found in the skills folder, listed in the system prompt,
// loaded by use_skill or /name with their other files, offered after `/`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api } from './harness.mjs';

const { skills } = api;

const TEXT = {
  'Skills/meeting-notes/SKILL.md': '---\nname: meeting-notes\ndescription: Write meeting notes from a transcript.\n---\n\nUse the template.',
  'Skills/meeting-notes/template.md': '# Meeting',
  'Skills/meeting-notes/examples/one.md': 'Example',
  'Skills/Weekly review/SKILL.md': 'Go through the week.',
};
const PROPERTIES = {
  'Skills/meeting-notes/SKILL.md': { frontmatter: { name: 'meeting-notes', description: 'Write meeting notes from a transcript.' }, frontmatterPosition: { end: { offset: TEXT['Skills/meeting-notes/SKILL.md'].indexOf('\n\nUse') } } },
};

function skillsApp() {
  const files = new Map();
  const folders = new Map();
  const folder = path => {
    if (!folders.has(path)) {
      const created = Object.assign(new api.TFolder(path, []), { name: path.split('/').pop() });
      folders.set(path, created);
      const parent = path.includes('/') ? folder(path.slice(0, path.lastIndexOf('/'))) : null;
      parent?.children.push(created);
    }
    return folders.get(path);
  };
  for (const path of Object.keys(TEXT)) {
    const parent = folder(path.slice(0, path.lastIndexOf('/')));
    const file = Object.assign(new api.TFile(path), { parent });
    parent.children.push(file);
    files.set(path, file);
  }
  folder('Skills/empty');
  return {
    vault: {
      getFolderByPath: path => folders.get(path) ?? null,
      getFileByPath: path => files.get(path) ?? null,
      cachedRead: async file => TEXT[file.path],
    },
    metadataCache: { getFileCache: file => PROPERTIES[file.path] ?? null },
  };
}

test('skills: each subfolder with a SKILL.md; the name from its properties, else the folder', () => {
  const found = skills.findSkills(skillsApp(), 'Skills');
  assert.deepEqual(found, [
    { name: 'meeting-notes', description: 'Write meeting notes from a transcript.', path: 'Skills/meeting-notes/SKILL.md' },
    { name: 'Weekly review', description: '', path: 'Skills/Weekly review/SKILL.md' },
  ]);
  assert.deepEqual(skills.findSkills(skillsApp(), 'Elsewhere'), []);
});

test('skills: the system prompt lists them after the built-in prompt, none without skills', () => {
  const list = skills.skillsPrompt(skills.findSkills(skillsApp(), 'Skills'));
  assert.match(list, /call use_skill with its name/);
  assert.match(list, /- meeting-notes: Write meeting notes from a transcript\.\n- Weekly review: \(no description\)/);
  assert.equal(skills.skillsPrompt([]), null);
  const prompt = api.buildSystemPrompt('Be brief.', list);
  assert.ok(prompt.indexOf('## Skills') < prompt.indexOf('## This vault\'s instructions'));
  assert.doesNotMatch(api.buildSystemPrompt(null, null), /## Skills/);
});

test('use_skill: the instructions without properties and the skill\'s other files; an unknown name lists the skills', async () => {
  const loaded = await skills.useSkill(skillsApp(), 'Skills', { name: '/Meeting-Notes' });
  assert.equal(loaded.isError, false);
  assert.match(loaded.result, /^<skill name="meeting-notes" path="Skills\/meeting-notes\/SKILL\.md">\nUse the template\.\n<\/skill>/);
  assert.match(loaded.result, /other files.*:\n- Skills\/meeting-notes\/examples\/one\.md\n- Skills\/meeting-notes\/template\.md$/);
  assert.doesNotMatch(loaded.result, /description:/);
  const missing = await skills.useSkill(skillsApp(), 'Skills', { name: 'nope' });
  assert.deepEqual(missing, { result: 'No skill named "nope". Skills: meeting-notes, Weekly review.', isError: true });
});

test('/name: invoked at the start or after a space, loaded along with the message', async () => {
  const found = skills.findSkills(skillsApp(), 'Skills');
  assert.deepEqual(skills.invokedSkills('/meeting-notes for today, see a/b and /nope', found).map(s => s.name), ['meeting-notes']);
  assert.deepEqual(skills.invokedSkills('and/meeting-notes', found), []);
  const text = await skills.invokedSkillsText(skillsApp(), 'Skills', 'Please /meeting-notes');
  assert.match(text, /^\[Skills the user invoked with \/name; follow them for this request:\]\n<skill name="meeting-notes"/);
  assert.equal(await skills.invokedSkillsText(skillsApp(), 'Skills', 'no skill here'), null);
});

test('/ autocomplete: what is being typed after a slash, and the matching skills', () => {
  assert.deepEqual(skills.skillAt('/mee', 4), { start: 0, query: 'mee' });
  assert.deepEqual(skills.skillAt('hi /', 4), { start: 3, query: '' });
  assert.equal(skills.skillAt('a/b', 3), null);
  assert.equal(skills.skillAt('/done now', 9), null);
  const found = skills.findSkills(skillsApp(), 'Skills');
  assert.deepEqual(skills.skillCandidates(found, '').map(s => s.name), ['meeting-notes', 'Weekly review']);
});
