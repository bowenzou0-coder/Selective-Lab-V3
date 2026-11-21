import assert from 'node:assert/strict';
import test from 'node:test';
import { SKILLS_TAXONOMY } from '../shared/skills.ts';
import { MESSAGES_EN, MESSAGES_ZH, translateMessage, type MessageKey } from './i18n/messages.ts';
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

test('translateMessage interpolates placeholders cleanly in both locales', () => {
  assert.equal(translateMessage('en', 'bank.selectedCount', { count: 4 }), '4 selected');
  assert.equal(translateMessage('zh-CN', 'bank.selectedCount', { count: 4 }), '已勾选 4 题');
  assert.equal(
    translateMessage('zh-CN', 'home.todayPlanLine', { total: 13, mix: '阅读 4、数学 7' }),
    '今日共规划 13 题：阅读 4、数学 7。'
  );
});
