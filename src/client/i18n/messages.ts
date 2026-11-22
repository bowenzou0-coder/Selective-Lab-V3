import { MESSAGES_EN, type MessageKey } from './en';

export type AppLocale = 'en' | 'zh-CN';
export { MESSAGES_EN, type MessageKey };

// The Chinese dictionary is a separate chunk so English sessions never download it.
let zhMessages: Partial<Record<MessageKey, string>> | null = null;
let zhSkillNames: Record<string, string> = {};
let zhFamilyLabels: Record<string, string> = {};
let zhLoading: Promise<void> | null = null;

export function getZhSkillLabels(): { names: Record<string, string>; families: Record<string, string> } {
  return { names: zhSkillNames, families: zhFamilyLabels };
}

export function isZhMessagesLoaded(): boolean {
  return zhMessages !== null;
}

export function loadZhMessages(): Promise<void> {
  zhLoading ??= import('./zh')
    .then((mod) => {
      zhMessages = mod.MESSAGES_ZH;
      zhSkillNames = mod.SKILL_NAMES_ZH;
      zhFamilyLabels = mod.SKILL_FAMILY_LABELS_ZH;
    })
    .catch((err: unknown) => {
      zhLoading = null;
      throw err;
    });
  return zhLoading;
}

export function translateMessage(
  locale: AppLocale,
  key: MessageKey,
  vars?: Record<string, string | number>
): string {
  const dict = locale === 'zh-CN' && zhMessages ? zhMessages : MESSAGES_EN;
  const template = dict[key] ?? MESSAGES_EN[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, k: string) => {
    const val = vars[k];
    return val === undefined ? `{${k}}` : String(val);
  });
}
