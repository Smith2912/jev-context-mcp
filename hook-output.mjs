// Codex's hook parser denies unknown fields. Keep ordinary tool metadata out
// of the hook wire response; recordUsage must run before this projection.
export function hookOutput(result) {
  const output = {continue: true};
  const context = result.hookSpecificOutput?.additionalContext;
  if (typeof context === 'string' && context.trim()) {
    output.hookSpecificOutput = {
      hookEventName: 'UserPromptSubmit',
      additionalContext: context.slice(0, 800),
    };
  }
  return output;
}
