import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync, Visitor } from 'vite';
import assert from 'node:assert/strict';
import test from 'node:test';
import { SKILLS_TAXONOMY } from '../shared/skills.ts';
import { MESSAGES_EN, type MessageKey } from './i18n/en.ts';
import { loadZhMessages, translateMessage } from './i18n/messages.ts';
import { MESSAGES_ZH } from './i18n/zh.ts';
import { SKILL_FAMILY_LABELS_ZH, SKILL_NAMES_ZH } from './i18n/skillsZh.ts';

test('English and Simplified Chinese message dictionaries have 1:1 non-empty key parity', () => {
  const enKeys = Object.keys(MESSAGES_EN).sort();
  const zhKeys = Object.keys(MESSAGES_ZH).sort();

  assert.deepEqual(zhKeys, enKeys);

  for (const key of enKeys as MessageKey[]) {
    assert.ok(MESSAGES_EN[key].trim().length > 0, `Empty EN string for ${key}`);
    assert.ok(MESSAGES_ZH[key].trim().length > 0, `Empty ZH string for ${key}`);
  }
});

test('All 77 canonical skills and 19 skill families have Simplified Chinese translations', () => {
  const seenFamilies = new Set<string>();
  for (const skill of SKILLS_TAXONOMY) {
    assert.ok(
      SKILL_NAMES_ZH[skill.skillId] && SKILL_NAMES_ZH[skill.skillId].trim().length > 0,
      `Missing Simplified Chinese translation for skillId ${skill.skillId}`
    );
    seenFamilies.add(skill.familyCode);
  }

  for (const fam of seenFamilies) {
    assert.ok(
      SKILL_FAMILY_LABELS_ZH[fam] && SKILL_FAMILY_LABELS_ZH[fam].trim().length > 0,
      `Missing Simplified Chinese label for familyCode ${fam}`
    );
  }
});

test('translateMessage interpolates placeholders cleanly in both locales', async () => {
  await loadZhMessages();
  assert.equal(translateMessage('en', 'bank.selectedCount', { count: 4 }), '4 selected');
  assert.equal(translateMessage('zh-CN', 'bank.selectedCount', { count: 4 }), '已勾选 4 题');
  assert.equal(
    translateMessage('zh-CN', 'home.todayPlanLine', { total: 13, mix: '阅读 4、数学 7' }),
    '今日共规划 13 题：阅读 4、数学 7。'
  );
});

test('Every dictionary key has a reference in application source', () => {
  // Expand only templates actually present, using the domain unions behind the label helpers.
  const domains = new Map([
    ['section.', 'SectionCode'], ['sectionShort.', 'SectionCode'], ['format.', 'QuestionFormatType'],
    ['poolStatus.', 'BankPoolStatus'], ['completion.', 'QuestionCompletionStatus'],
  ]);
  const unions = new Map<string, string[]>();
  const prefixes = new Set<string>();
  const literals = new Set<string>();
  const root = fileURLToPath(new URL('../', import.meta.url));
  for (const file of globSync('**/*.{ts,tsx,js,jsx}', { cwd: root, exclude: [
    '**/*.{test,spec}.*', '**/__fixtures__/**', 'client/i18n/en.ts', 'client/i18n/zh.ts',
  ] })) {
    const source = readFileSync(join(root, file), 'utf8');
    const { program, errors } = parseSync(file, source);
    assert.equal(errors.length, 0, file);
    const typeLiterals = new WeakSet<object>();
    new Visitor({
      TSLiteralType(node) { typeLiterals.add(node.literal); },
      Literal(node) {
        if (!typeLiterals.has(node) && typeof node.value === 'string') literals.add(node.value);
      },
      TemplateLiteral(node) {
        const [head, tail] = node.quasis;
        if (!node.expressions.length) literals.add(head.value.raw);
        if (node.expressions.length === 1 && tail.value.raw === '' && domains.has(head.value.raw)) {
          prefixes.add(head.value.raw);
        }
      },
      TSTypeAliasDeclaration(node) {
        if (![...domains.values()].includes(node.id.name)) return;
        const type = node.typeAnnotation;
        assert.equal(type.type, 'TSUnionType');
        if (type.type === 'TSUnionType') unions.set(node.id.name, type.types.map(member => {
          assert.ok(member.type === 'TSLiteralType' && member.literal.type === 'Literal');
          return String(member.literal.value);
        }));
      },
    }).visit(program);
  }
  for (const prefix of prefixes) {
    const values = unions.get(domains.get(prefix)!);
    assert.ok(values?.length, `Missing source domain for ${prefix}`);
    for (const value of values!) literals.add(prefix + value);
  }
  const allKeys = new Set([...Object.keys(MESSAGES_EN), ...Object.keys(MESSAGES_ZH)]);
  assert.deepEqual([...allKeys].filter(key => !literals.has(key)).sort(), [], 'Unused translations');
});
