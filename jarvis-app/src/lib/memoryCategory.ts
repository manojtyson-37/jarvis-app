// Category guard for model-extracted memory facts.
//
// maya_memory rows with category "instruction" are standing rules: getRules() injects them into every prompt
// with authority over the style rules. The nightly evolve job asks the model to extract facts from chat history,
// and that history includes Maya's replies, which quote email and ticket text. If the model's category were saved
// as given, a hostile email could get a fact tagged "instruction" and become a standing rule. So any category the
// model supplies is mapped onto this allowlist; everything else becomes "general". Rules are written only by
// saveRule(), from Manoj's own chat messages or the Rules list.
export const FACT_CATEGORIES = ['general', 'preference', 'goal', 'person', 'habit'] as const;
export type FactCategory = (typeof FACT_CATEGORIES)[number];

// Categories the prompt deliberately leaves out (getPromptFacts) or that mean a standing rule. A model fact tagged
// with one of these is dropped, not renamed, so it can't slip into the prompt as "general".
const RESERVED = ['instruction', 'question', 'ticket', 'email'];
export function isReservedFactCategory(raw: unknown): boolean {
  return typeof raw === 'string' && RESERVED.includes(raw.trim().toLowerCase());
}

export function safeFactCategory(raw: unknown): FactCategory {
  const c = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return (FACT_CATEGORIES as readonly string[]).includes(c) ? (c as FactCategory) : 'general';
}
