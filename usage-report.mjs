#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Jev's published input price, recorded in GENERAL-INTEGRATION.md on 2026-09-19.
export const DEFAULT_INPUT_USD_PER_MILLION = 0.042;
export const DEFAULT_RATE_SOURCE = 'Jev published $0.042/M input rate; output free; recorded 2026-09-19 in GENERAL-INTEGRATION.md.';

function isNonNegativeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function assertValidRate(inputUsdPerMillion) {
  if (!Number.isFinite(inputUsdPerMillion) || inputUsdPerMillion < 0) {
    throw new Error('inputUsdPerMillion must be a non-negative finite number.');
  }
}

function createBucket() {
  return {
    records: 0,
    cachedCalls: 0,
    unknownUsageRecords: 0,
    knownInputTokens: 0,
    knownOutputTokens: 0,
    knownJevInputTokens: 0,
    estimatedKnownJevUsd: 0,
  };
}

function addToBucket(bucket, { hasKnownInput, hasKnownOutput, inputTokens, outputTokens, isCached, isJev }) {
  bucket.records += 1;
  if (hasKnownInput) bucket.knownInputTokens += inputTokens;
  if (hasKnownOutput) bucket.knownOutputTokens += outputTokens;
  if (!hasKnownInput || !hasKnownOutput) bucket.unknownUsageRecords += 1;
  if (isCached) bucket.cachedCalls += 1;
  if (isJev && hasKnownInput) bucket.knownJevInputTokens += inputTokens;
}

function finalizeEstimate(bucket, inputUsdPerMillion) {
  bucket.estimatedKnownJevUsd = Number(
    ((bucket.knownJevInputTokens / 1_000_000) * inputUsdPerMillion).toFixed(12),
  );
}

export function parseArguments(args) {
  const positional = [];
  let inputUsdPerMillion = DEFAULT_INPUT_USD_PER_MILLION;
  let inputRateSource = DEFAULT_RATE_SOURCE;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--input-usd-per-million') {
      const rawRate = args[index + 1];
      if (rawRate === undefined) throw new Error('--input-usd-per-million requires a value.');
      inputUsdPerMillion = Number(rawRate);
      inputRateSource = 'supplied';
      index += 1;
    } else if (argument === '--help' || argument === '-h') {
      return { help: true };
    } else if (argument.startsWith('-')) {
      throw new Error(`Unknown option: ${argument}`);
    } else {
      positional.push(argument);
    }
  }

  if (positional.length !== 1) throw new Error('Provide exactly one JSONL ledger path.');
  try { assertValidRate(inputUsdPerMillion); }
  catch { throw new Error('--input-usd-per-million must be a non-negative finite number.'); }

  return { ledgerPath: positional[0], inputUsdPerMillion, inputRateSource, help: false };
}

export function buildReport(jsonl, { inputUsdPerMillion = DEFAULT_INPUT_USD_PER_MILLION, inputRateSource = DEFAULT_RATE_SOURCE } = {}) {
  assertValidRate(inputUsdPerMillion);
  const report = {
    schemaVersion: 2,
    rate: {
      inputUsdPerMillion,
      source: inputRateSource,
      appliesTo: 'Known input tokens in records whose status begins with "jev".',
    },
    totals: {
      rowsRead: 0,
      validRecords: 0,
      malformedRows: 0,
      cachedCalls: 0,
      unknownUsageRecords: 0,
      knownInputTokens: 0,
      knownOutputTokens: 0,
      knownJevInputTokens: 0,
      estimatedKnownJevUsd: 0,
    },
    byTool: Object.create(null),
    byStatus: Object.create(null),
    limitations: [
      'Unknown token values are counted as unknown, never as zero.',
      'estimatedKnownJevUsd covers known Jev input tokens only; it is not a complete billing total.',
      'Cached calls are counted from status values containing "cache"; their recorded token values are still reported when present.',
    ],
  };

  const lines = jsonl.split(/\r?\n/);
  for (const line of lines) {
    if (line === '') continue;
    report.totals.rowsRead += 1;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      report.totals.malformedRows += 1;
      continue;
    }
    if (record === null || Array.isArray(record) || typeof record !== 'object') {
      report.totals.malformedRows += 1;
      continue;
    }

    report.totals.validRecords += 1;
    const tool = typeof record.tool === 'string' && record.tool !== '' ? record.tool : '(unknown)';
    const status = typeof record.status === 'string' && record.status !== '' ? record.status : '(unknown)';
    const hasKnownInput = isNonNegativeInteger(record.inputTokens);
    const hasKnownOutput = isNonNegativeInteger(record.outputTokens);
    if (hasKnownInput) report.totals.knownInputTokens += record.inputTokens;
    if (hasKnownOutput) report.totals.knownOutputTokens += record.outputTokens;
    if (!hasKnownInput || !hasKnownOutput) report.totals.unknownUsageRecords += 1;

    const normalizedStatus = status.toLowerCase();
    const isCached = normalizedStatus.includes('cache');
    const isJev = normalizedStatus.startsWith('jev');
    if (isCached) report.totals.cachedCalls += 1;
    if (isJev && hasKnownInput) {
      report.totals.knownJevInputTokens += record.inputTokens;
    }
    const details = { hasKnownInput, hasKnownOutput, inputTokens: record.inputTokens, outputTokens: record.outputTokens, isCached, isJev };
    report.byTool[tool] ??= createBucket();
    report.byStatus[status] ??= createBucket();
    addToBucket(report.byTool[tool], details);
    addToBucket(report.byStatus[status], details);
  }

  finalizeEstimate(report.totals, inputUsdPerMillion);
  for (const bucket of Object.values(report.byTool)) finalizeEstimate(bucket, inputUsdPerMillion);
  for (const bucket of Object.values(report.byStatus)) finalizeEstimate(bucket, inputUsdPerMillion);
  return report;
}

export async function createReportFromFile(ledgerPath, options) {
  const jsonl = await fs.readFile(ledgerPath, 'utf8');
  return buildReport(jsonl, options);
}

export const helpText = `Usage: node usage-report.mjs <ledger.jsonl> [--input-usd-per-million <rate>]\n\nDefaults to ${DEFAULT_INPUT_USD_PER_MILLION} USD per million input tokens (${DEFAULT_RATE_SOURCE}) Output is JSON.`;

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${helpText}\n`);
    return;
  }
  const report = await createReportFromFile(path.resolve(options.ledgerPath), options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`usage-report: ${error.message}\n`);
    process.exitCode = 1;
  });
}
