const fs = require('fs');
let code = fs.readFileSync('portfolio-core.js', 'utf8');

// Remove batch normalization
code = code.replace(/  const batches = Array\.isArray\(source\.batches\)[\s\S]*?\)\)\.filter\(\(batch\) => batch\.id\)\n    : \[\];\n/, '');
code = code.replace(/    batches,\n/, '');
code = code.replace(/    batches: \[\],\n/, '');
code = code.replace(/    batchId: record\.batchId \? String\(record\.batchId\) : null,\n/, '');
code = code.replace(/    record\.batchId \|\|\n/, '');

// In applyPortfolioToCards
code = code.replace(/  const batches = new Map\(normalized\.batches\.map\(\(batch\) => \[batch\.id, batch\]\)\);\n/, '');
code = code.replace(/    const batch = record\.batchId \? batches\.get\(record\.batchId\) : null;\n/, '');
code = code.replace(/    let status = record\.status;\n    if \(status === "planned" && batch\?\.status === "submitted"\) status = "submitted";\n/, '    let status = record.status;\n');
code = code.replace(/      batchId: record\.batchId,\n/, '');

// In summarizePortfolio
code = code.replace(/    batchCount: normalized\.batches\.length,\n/, '');
code = code.replace(/    submittedBatchCount: normalized\.batches\.filter\(\n      \(batch\) => batch\.status === "submitted" \|\| batch\.status === "closed"\n    \)\.length,\n/, '');

// Remove batchAlignment function
code = code.replace(/export function batchAlignment[\s\S]*?\}\n/, '');

fs.writeFileSync('portfolio-core.js', code);
