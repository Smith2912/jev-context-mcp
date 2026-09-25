import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {cleanText} from './evidence.mjs';
import {createDecisionEngine, digest} from './decision-engine.mjs';
import {persistentProviderBudget} from './provider-budget.mjs';

const safeId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/;
const sensitive = /-----BEGIN [^-]*PRIVATE KEY-----|\bsk-[\w-]+|\bapikey_[\w]+|\b(?:password|secret|token|authorization|api[_-]?key)\s*[:=]/i;

export function createComputerUseHelper({settings, policy, apiKey, fetcher=fetch}) {
  const cfg = settings.workflow || {};
  const rules = policy.computerUse;
  if (!rules || !Number.isFinite(rules.minimumActionConfidence)) throw new Error('Computer Use policy missing');
  const base = path.join(cfg.artifactDirectory || path.dirname(settings.usageLedger || '.'), 'computer-use-helper');
  const reserveProviderRequest = persistentProviderBudget(cfg.limiterDirectory || path.join(base, 'provider-budget'), {
    requestsPerMinute: policy.requestsPerMinute,
    maxRunInput: policy.maxProviderInputTokensPerRun
  });
  const engine = createDecisionEngine({
    policy, apiKey, fetcher, cacheDirectory: path.join(base, 'cache'),
    schedulerEnabled: cfg.batchSchedulerEnabled === true, reserveProviderRequest,
    recordReceipt: async receipt => {
      const directory = path.join(base, 'receipts');
      await fs.mkdir(directory, {recursive:true});
      await fs.writeFile(path.join(directory, receipt.id + '.json'), JSON.stringify(receipt), {flag:'wx', mode:0o600});
    }
  });
  return async function decideComputerStep(input) {
    const {runId, task, surface, observation, actions, shareWithTypeSafe=false, contentClass='unknown', requiresMultimodal=false} = input;
    if (!safeId.test(runId) || typeof task !== 'string' || !task.trim() || task.length > rules.maxTaskChars ||
        !['browser','desktop','blender','daw'].includes(surface) || typeof observation !== 'string' ||
        !observation.trim() || observation.length > rules.maxObservationChars ||
        !Array.isArray(actions) || actions.length < 1 || actions.length > rules.maxActions ||
        actions.some(a => !a || !safeId.test(a.id) || a.id === 'escalate' || typeof a.description !== 'string' ||
          !a.description.trim() || a.description.length > rules.maxActionChars ||
          !['routine','consequential','unknown'].includes(a.risk)) ||
        new Set(actions.map(a => a.id)).size !== actions.length) throw new Error('Invalid bounded Computer Use request');
    const observationHash = digest({surface, observation});
    const baseResult = {status:'escalate', actionId:null, observationHash, policyVersion:policy.version,
      warning:'Advisory only. Reobserve the UI after each action; permissions and execution remain with Computer Use.'};
    if (!shareWithTypeSafe || contentClass !== 'routine' || requiresMultimodal ||
        sensitive.test([task,observation,...actions.map(a=>a.description)].join('\n'))) {
      return {...baseResult, reason:requiresMultimodal?'multimodal_judgment_required':'sharing_not_authorized_or_sensitive', provider:{status:'not_called'}};
    }
    const allowed = actions.filter(a=>a.risk==='routine');
    if (!allowed.length) return {...baseResult, reason:'no_routine_action', provider:{status:'not_called'}};
    const state = {task:cleanText(task), surface, observation:cleanText(observation),
      actions:actions.map(({id,description,risk})=>({id,description:cleanText(description),risk}))};
    const criteria = Object.fromEntries(allowed.map(a=>[a.id,a.description]));
    criteria.escalate = 'Request Codex judgment or a fresh observation; do not perform an action.';
    const questions = {
      next_action:{type:'choice',instructions:rules.nextActionInstruction,criteria},
      missing_evidence:{type:'noul',instructions:rules.missingEvidenceInstruction},
      needs_multimodal:{type:'noul',instructions:rules.multimodalInstruction}
    };
    const payloadChars = JSON.stringify({model:policy.model,
      state:JSON.stringify({evidence:state,sourceHashes:{observation:observationHash}}),questions}).length;
    if (payloadChars > rules.maxProviderPayloadChars) {
      return {...baseResult,reason:'context_too_large',provider:{status:'not_called'},payloadChars};
    }
    const result = await engine.evaluate({runId,state,questions,sourceHashes:{observation:observationHash},shareWithTypeSafe:true});
    const receipts = result.receipts.map(r=>({id:r.id,status:r.status,model:r.actualModel??null,
      usage:r.usage,elapsedMs:r.elapsedMs}));
    const provider = {status:result.status,receipts,errors:result.errors};
    const choice = result.answers.next_action, missing = result.answers.missing_evidence, multimodal = result.answers.needs_multimodal;
    if (result.status!=='complete' || !choice || !missing || !multimodal) return {...baseResult,reason:'provider_unavailable_or_invalid',provider};
    const action = allowed.find(a=>a.id===choice.choice);
    const confidence = Math.min(choice.confidence, choice.probabilities?.[choice.choice]??0);
    if (!action || confidence < rules.minimumActionConfidence || missing.noul >= rules.evidenceEscalationThreshold ||
        multimodal.noul >= rules.multimodalEscalationThreshold) {
      return {...baseResult,reason:!action?'jev_escalation':'low_confidence_or_missing_evidence',
        confidence,flags:{missingEvidence:missing.noul,needsMultimodal:multimodal.noul},provider};
    }
    return {...baseResult,status:'suggested',actionId:action.id,reason:'bounded_routine_action',confidence,
      flags:{missingEvidence:missing.noul,needsMultimodal:multimodal.noul},provider};
  };
}
