import test from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {hookOutput} from './hook-output.mjs';
// Strict subset of Codex UserPromptSubmitCommandOutputWire. In particular,
// metadata at the top level must fail, as it does with deny_unknown_fields.
const wire=z.object({continue:z.boolean(),hookSpecificOutput:z.object({hookEventName:z.literal('UserPromptSubmit'),additionalContext:z.string().max(800)}).strict().optional()}).strict();
test('hook projection removes metadata rejected by Codex and preserves advice',()=>{
 const original={continue:true,provider:{status:'jev'},usageReceipt:'receipt',recommendedModel:'gpt-5.6-terra',invocation:'hook',hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:'Jev advisory: Terra / medium.'}};
 assert.equal(wire.safeParse(original).success,false);
 const output=hookOutput(original);
 assert.deepEqual(wire.parse(output),{continue:true,hookSpecificOutput:original.hookSpecificOutput});
 assert.equal(original.usageReceipt,'receipt');
});
test('skipped routes remain valid and bounded',()=>{
 assert.deepEqual(wire.parse(hookOutput({provider:{status:'routing-skipped'}})),{continue:true});
 assert.equal(wire.parse(hookOutput({hookSpecificOutput:{additionalContext:'x'.repeat(2000)}})).hookSpecificOutput.additionalContext.length,800);
});
