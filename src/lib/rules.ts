import { ALLOW_RULE_ID, CATEGORIES, DYNAMIC_RULE_IDS, type Category } from './constants';
import type { State } from './state';

type Rule = chrome.declarativeNetRequest.Rule;
const FRAME_TYPES = ['main_frame', 'sub_frame'] as chrome.declarativeNetRequest.ResourceType[];

export function dynamicBlockRule(category: Category, domains: string[], extensionId: string): Rule {
  return {
    id: DYNAMIC_RULE_IDS[category],
    priority: 1,
    action: {
      type: 'redirect' as chrome.declarativeNetRequest.RuleActionType,
      redirect: { regexSubstitution: `chrome-extension://${extensionId}/block.html?c=${category}&host=\\1` },
    },
    condition: { regexFilter: '^https?://([^/:?#]+).*$', requestDomains: domains, resourceTypes: FRAME_TYPES },
  };
}

export function allowRule(domains: string[]): Rule {
  return {
    id: ALLOW_RULE_ID,
    priority: 100,
    action: { type: 'allow' as chrome.declarativeNetRequest.RuleActionType },
    condition: { requestDomains: domains, resourceTypes: FRAME_TYPES },
  };
}

/** Which bundled rulesets should be on, and which dynamic rules should be gone. */
export function desiredRules(state: State) {
  const enableRulesetIds: string[] = [];
  const disableRulesetIds: string[] = [];
  const removeRuleIds: number[] = [ALLOW_RULE_ID];
  for (const c of CATEGORIES) {
    const refreshed = state.applied[c] !== undefined;
    (refreshed ? disableRulesetIds : enableRulesetIds).push(c);
    if (!refreshed) removeRuleIds.push(DYNAMIC_RULE_IDS[c]);
  }
  const addRules = state.allowlist.length ? [allowRule(state.allowlist)] : [];
  return { enableRulesetIds, disableRulesetIds, removeRuleIds, addRules };
}

/** Makes the browser's rules match the saved state. Safe to call repeatedly. */
export async function syncRules(state: State): Promise<void> {
  const { enableRulesetIds, disableRulesetIds, removeRuleIds, addRules } = desiredRules(state);
  await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds, disableRulesetIds });
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
}

/** Reads the browser's real rules, so the settings page reports what is actually blocking. */
export async function activeCategories(): Promise<Record<Category, boolean>> {
  const rulesets = await chrome.declarativeNetRequest.getEnabledRulesets();
  const dynamic = await chrome.declarativeNetRequest.getDynamicRules({ ruleIds: Object.values(DYNAMIC_RULE_IDS) });
  const dynamicIds = new Set(dynamic.map((r) => r.id));
  return Object.fromEntries(
    CATEGORIES.map((c) => [c, rulesets.includes(c) || dynamicIds.has(DYNAMIC_RULE_IDS[c])]),
  ) as Record<Category, boolean>;
}
