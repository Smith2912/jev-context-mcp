import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildReport, createReportFromFile, DEFAULT_INPUT_USD_PER_MILLION, DEFAULT_RATE_SOURCE, parseArguments } from './usage-report.mjs';

test('summarizes known, cached, unknown, and malformed ledger rows', () => {
  const ledger = [
    JSON.stringify({ tool: 'selectContext', status: 'jev', inputTokens: 500, outputTokens: 25 }),
    JSON.stringify({ tool: 'checkOutput', status: 'jev-cache', inputTokens: 0, outputTokens: 0 }),
    JSON.stringify({ tool: 'triage', status: 'local-only', inputTokens: null, outputTokens: null }),
    '{not json',
    '[]',
  ].join('\n');
  const report = buildReport(ledger, { inputUsdPerMillion: 2, inputRateSource: 'supplied' });

  assert.deepEqual({ ...report.byTool }, {
    selectContext: { records: 1, cachedCalls: 0, unknownUsageRecords: 0, knownInputTokens: 500, knownOutputTokens: 25, knownJevInputTokens: 500, estimatedKnownJevUsd: 0.001 },
    checkOutput: { records: 1, cachedCalls: 1, unknownUsageRecords: 0, knownInputTokens: 0, knownOutputTokens: 0, knownJevInputTokens: 0, estimatedKnownJevUsd: 0 },
    triage: { records: 1, cachedCalls: 0, unknownUsageRecords: 1, knownInputTokens: 0, knownOutputTokens: 0, knownJevInputTokens: 0, estimatedKnownJevUsd: 0 },
  });
  assert.deepEqual({ ...report.byStatus }, {
    jev: { records: 1, cachedCalls: 0, unknownUsageRecords: 0, knownInputTokens: 500, knownOutputTokens: 25, knownJevInputTokens: 500, estimatedKnownJevUsd: 0.001 },
    'jev-cache': { records: 1, cachedCalls: 1, unknownUsageRecords: 0, knownInputTokens: 0, knownOutputTokens: 0, knownJevInputTokens: 0, estimatedKnownJevUsd: 0 },
    'local-only': { records: 1, cachedCalls: 0, unknownUsageRecords: 1, knownInputTokens: 0, knownOutputTokens: 0, knownJevInputTokens: 0, estimatedKnownJevUsd: 0 },
  });
  assert.deepEqual(report.totals, {
    rowsRead: 5,
    validRecords: 3,
    malformedRows: 2,
    cachedCalls: 1,
    unknownUsageRecords: 1,
    knownInputTokens: 500,
    knownOutputTokens: 25,
    knownJevInputTokens: 500,
    estimatedKnownJevUsd: 0.001,
  });
});

test('counts a partially known usage record as unknown without discarding known input', () => {
  const report = buildReport(JSON.stringify({ tool: 'routeTask', status: 'jev', inputTokens: 100, outputTokens: null }));
  assert.equal(report.totals.unknownUsageRecords, 1);
  assert.equal(report.totals.knownInputTokens, 100);
  assert.equal(report.totals.knownOutputTokens, 0);
  assert.equal(report.totals.estimatedKnownJevUsd, 0.0000042);
});

test('uses the documented Jev default rate and records its source', () => {
  const options = parseArguments(['ledger.jsonl']);
  assert.equal(options.inputUsdPerMillion, DEFAULT_INPUT_USD_PER_MILLION);
  assert.equal(options.inputRateSource, DEFAULT_RATE_SOURCE);
  assert.equal(buildReport('').rate.inputUsdPerMillion, 0.042);
});

test('reads a synthetic file and validates command arguments', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jev-usage-report-'));
  const ledgerPath = path.join(directory, 'ledger.jsonl');
  try {
    await writeFile(ledgerPath, JSON.stringify({ tool: 'routeTask', status: 'jev', inputTokens: 1_000_000, outputTokens: 10 }));
    const report = await createReportFromFile(ledgerPath, { inputUsdPerMillion: 1.25, inputRateSource: 'supplied' });
    assert.equal(report.totals.estimatedKnownJevUsd, 1.25);
    assert.deepEqual(parseArguments(['ledger.jsonl', '--input-usd-per-million', '3']), {
      ledgerPath: 'ledger.jsonl', inputUsdPerMillion: 3, inputRateSource: 'supplied', help: false,
    });
    assert.throws(() => parseArguments(['ledger.jsonl', '--input-usd-per-million', '-1']), /non-negative/);
    assert.throws(() => buildReport('', { inputUsdPerMillion: Number.NaN }), /non-negative/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('retains adversarial tool and status names safely', () => {
  const ledger = [
    JSON.stringify({ tool: '__proto__', status: 'constructor', inputTokens: 1, outputTokens: 2 }),
    JSON.stringify({ tool: 'toString', status: '__proto__', inputTokens: 3, outputTokens: 4 }),
  ].join('\n');
  const report = buildReport(ledger);
  assert.equal(Object.getPrototypeOf(report.byTool), null);
  assert.equal(Object.getPrototypeOf(report.byStatus), null);
  assert.equal(report.byTool.__proto__.records, 1);
  assert.equal(report.byTool.toString.knownInputTokens, 3);
  assert.equal(report.byStatus.constructor.knownOutputTokens, 2);
  assert.equal(report.byStatus.__proto__.records, 1);
});
