// Lossless for selected source evidence and retrieval coordinates. Accounting
// is persisted before this projection; verbose diagnostics remain internal.
export function compactContext(result) {
  return {
    file:result.file,sha256:result.sha256,
    sourceBytes:result.sourceBytes,sourceLines:result.sourceLines,excerptCharacters:result.excerptCharacters,
    selected:result.selected.map(({start,end,columnStart,text})=>({start,end,...(columnStart===undefined?{}:{columnStart}),text})),
    omittedChunks:result.omittedChunks,
    nextCandidateOffset:result.nextCandidateOffset,
    provider:result.provider,
    usageReceipt:result.usageReceipt,
    ...(result.usageLedgerWarning?{usageLedgerWarning:result.usageLedgerWarning}:{}),
    warning:'Selected evidence may omit relevant context. Retrieve omitted pages or hash-bound source ranges before conclusions or edits.',
  };
}
